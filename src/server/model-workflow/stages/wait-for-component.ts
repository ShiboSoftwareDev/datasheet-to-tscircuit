import { join } from "node:path"
import type { JobStore } from "../../job-store"
import type { ModelRunStore } from "../../model-run-store"
import { PipelineError } from "../../pipeline"
import { modelArtifact, updateModelProgress } from "../stage-helpers"
import { defineModelStage } from "./stage-factory"

type ComponentReadiness = "ready" | "failed" | "waiting"

function inspectComponentReadiness(input: { job_id: string; job_store: JobStore }): ComponentReadiness {
  const job = input.job_store.getJob(input.job_id)
  if (!job) return "failed"
  if (job.is_complete) {
    return job.display_status === "complete" && job.component_ready && !job.has_errors ? "ready" : "failed"
  }
  const component_pipeline = job.pipelines?.component_generation ?? job.pipeline
  if (component_pipeline?.status === "completed") {
    const committed =
      component_pipeline.pipeline_id === "component_generation"
        ? component_pipeline.stage_results.repair_component?.status === "completed"
        : component_pipeline.stage_results.publish?.status === "completed"
    return !job.has_errors && job.component_ready && committed ? "ready" : "failed"
  }
  if (component_pipeline?.status === "failed" || component_pipeline?.status === "cancelled") {
    return "failed"
  }
  return "waiting"
}

/**
 * Cross-pipeline coordination happens before MODEL_PIPELINE starts. That keeps
 * every retained pipeline task a pure function of its captured input state.
 */
export async function waitForComponentBeforeModelPipeline(input: {
  job_id: string
  model_run_id: string
  job_store: JobStore
  model_run_store: ModelRunStore
  signal: AbortSignal
}): Promise<void> {
  input.signal.throwIfAborted()
  input.model_run_store.updateModelRun(input.model_run_id, {
    status: "waiting_for_component",
    is_complete: false,
    has_errors: false,
    error_message: undefined,
  })
  updateModelProgress({
    store: input.model_run_store,
    model_run_id: input.model_run_id,
    phase: "waiting_for_component",
    message: "Waiting for the validated component artifact",
  })
  if (inspectComponentReadiness(input) !== "waiting") return

  await new Promise<void>((resolve, reject) => {
    let unsubscribe: (() => void) | undefined
    const finish = (error?: Error) => {
      input.signal.removeEventListener("abort", on_abort)
      unsubscribe?.()
      error ? reject(error) : resolve()
    }
    const on_abort = () => finish(new Error("Model run was cancelled while waiting for the component"))
    input.signal.addEventListener("abort", on_abort, { once: true })
    unsubscribe = input.job_store.subscribe(input.job_id, (event) => {
      if (event.event_type !== "job_updated") return
      if (inspectComponentReadiness(input) !== "waiting") finish()
    })
    if (inspectComponentReadiness(input) !== "waiting") finish()
  })
}

export const waitForComponentStage = defineModelStage({
  id: "wait_for_component",
  depends_on: [],
  async execute({ context, services, signal }) {
    signal.throwIfAborted()
    const componentNotReady = (error: unknown): PipelineError =>
      new PipelineError(
        {
          code: "component_not_ready",
          message: error instanceof Error ? error.message : String(error),
          stage_id: "wait_for_component",
          operation: "wait_for_component",
          entity_refs: [{ entity_type: "job", entity_id: context.job_id }],
          hint: "Inspect the component pipeline and its failed stage before retrying the model run.",
        },
        { cause: error },
      )
    const initial_state = inspectComponentReadiness({ job_id: context.job_id, job_store: services.job_store })
    if (initial_state === "failed") {
      const job = services.job_store.getJob(context.job_id)
      throw componentNotReady(
        new Error(job?.error_message ?? "Component generation did not complete successfully"),
      )
    }
    if (initial_state === "waiting") {
      throw new PipelineError({
        code: "component_state_not_terminal",
        message: "The retained task input was captured before component generation reached a terminal state",
        stage_id: "wait_for_component",
        operation: "wait_for_component",
        entity_refs: [{ entity_type: "job", entity_id: context.job_id }],
        hint: "Model pipeline execution must wait for component generation before retaining task input.",
      })
    }

    const component_source = (await Bun.file(join(context.job_dir, "component.circuit.tsx")).exists())
      ? join(context.job_dir, "component.circuit.tsx")
      : join(context.job_dir, "index.circuit.tsx")
    return {
      status: "completed",
      output: { job_id: context.job_id, component_source },
      artifacts: [
        await modelArtifact({
          id: "validated_component_source",
          path: component_source,
          media_type: "text/typescript",
          role: "model_input",
        }),
      ],
    }
  },
})
