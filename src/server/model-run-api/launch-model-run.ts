import { join } from "node:path"
import type { ModelRun } from "@/shared/job-types"
import { runModel } from "../model-workflow"
import { getRuntimeSourceCommit } from "../runtime-source-commit"
import type { ModelRunApiContext } from "./model-run-api-context"

export type LaunchModelRunResult =
  | { status: "created"; model_run: ModelRun }
  | { status: "already_exists"; model_run: ModelRun }
  | { status: "job_deleting" }
  | { status: "job_not_found" }

function reportObserverFailure(input: { model_run_id: string; operation: string; error: unknown }): void {
  console.error("[model-run] observer_failed", {
    model_run_id: input.model_run_id,
    operation: input.operation,
    cause: input.error instanceof Error ? input.error.message : String(input.error),
  })
}

/** Lifecycle logs are observers: their failure must never gate durable work. */
export function appendModelRunLogBestEffort(
  context: ModelRunApiContext,
  model_run_id: string,
  message: string,
): void {
  try {
    void context.model_run_store
      .appendLog(model_run_id, { stream: "system", message })
      .catch((error) => reportObserverFailure({ model_run_id, operation: "append_lifecycle_log", error }))
  } catch (error) {
    reportObserverFailure({ model_run_id, operation: "append_lifecycle_log", error })
  }
}

async function recordUnexpectedRunnerFailure(
  model_run_id: string,
  error: unknown,
  context: ModelRunApiContext,
): Promise<void> {
  try {
    const model_run = context.model_run_store.getModelRun(model_run_id)
    if (!model_run || model_run.is_complete) return
    const message = error instanceof Error ? error.message : String(error)
    await context.model_run_store
      .appendLog(model_run_id, {
        stream: "system",
        message: `Model pipeline stopped after an unexpected runner failure: ${message}\n`,
      })
      .catch(() => undefined)
    const current = context.model_run_store.getModelRun(model_run_id)
    if (!current || current.is_complete) return
    context.model_run_store.finishSegment(model_run_id, {
      status: "failed",
      is_complete: true,
      has_errors: true,
      error_message: message,
      completed_at: new Date().toISOString(),
    })
  } catch (recovery_error) {
    reportObserverFailure({
      model_run_id,
      operation: "recover_unexpected_runner_failure",
      error: recovery_error,
    })
  }
}

/** Final background boundary shared by create, retry, and restarting extend. */
export function launchModelRunner(model_run_id: string, context: ModelRunApiContext): void {
  const runner = context.run_model ?? runModel
  try {
    void runner({ model_run_id }, context).catch((error) => {
      void recordUnexpectedRunnerFailure(model_run_id, error, context)
    })
  } catch (error) {
    void recordUnexpectedRunnerFailure(model_run_id, error, context)
  }
}

export async function launchModelRun(
  input: { job_id: string; job_dir: string; effort_multiplier: number },
  context: ModelRunApiContext,
): Promise<LaunchModelRunResult> {
  if (!context.job_store.getJob(input.job_id)) return { status: "job_not_found" }
  if (context.job_store.isJobDeleting(input.job_id)) return { status: "job_deleting" }
  const model_run_id = crypto.randomUUID()
  const creation = context.model_run_store.createModelRunIfAbsent({
    model_run_id,
    job_id: input.job_id,
    model_dir: join(input.job_dir, "spice"),
    use_openai: context.use_openai,
    effort_multiplier: input.effort_multiplier,
  })
  if (creation.status === "already_exists") return creation
  const source_commit = await getRuntimeSourceCommit()
  const execution_context = { ...context, use_openai: context.use_openai ?? false }
  appendModelRunLogBestEffort(
    execution_context,
    model_run_id,
    `Created a ${input.effort_multiplier}× SPICE model run using workflow source ${source_commit}. The server owns pin mapping, tscircuit execution, scoring, and publication; each effort unit provides 30 minutes of repair time.\n`,
  )
  launchModelRunner(model_run_id, execution_context)
  const current_run = context.model_run_store.getModelRun(model_run_id)
  if (!current_run) throw new Error(`Model run ${model_run_id} disappeared immediately after launch`)
  return { status: "created", model_run: current_run }
}
