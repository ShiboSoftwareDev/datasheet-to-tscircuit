import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { PublicPipelineSnapshot } from "@/shared/job-types"
import { RETAINED_ACCEPTED_WARNING_PREFIX } from "@/shared/model-warnings"
import { TsciAgentClient } from "../infrastructure/agent"
import { BunProcessRunner } from "../infrastructure/process"
import { ModelStrategyRegistry } from "../modeling"
import { projectPublicPipelineSnapshot, runPipeline } from "../pipeline"
import { MODEL_PIPELINE } from "./model-pipeline"
import { appendModelLog, updateModelProgress } from "./stage-helpers"
import {
  waitForComponentBeforePublication,
  waitForModelEvidenceBeforeComparison,
} from "./stages/wait-for-component"
import type { ModelRunnerContext } from "./types"
import { REPAIR_BUDGET_MS_PER_EFFORT } from "./types"

function failedStageMessage(result: PublicPipelineSnapshot): string {
  for (const stage of Object.values(result.stage_results)) {
    if (stage.status !== "failed" || !stage.error) continue
    return `[${stage.stage_id}/${stage.error.code}] ${stage.error.message}\nTrace: ${stage.debug_ref}`
  }
  return "The model pipeline failed without a stage diagnostic."
}

function unsupportedStageMessage(result: PublicPipelineSnapshot): string | undefined {
  for (const stage of Object.values(result.stage_results)) {
    if (stage.status !== "failed" || stage.error?.code !== "no_eligible_time_domain_graph") continue
    return stage.error.message
  }
  return undefined
}

function retainedAcceptedWarnings(input: {
  context: ModelRunnerContext
  model_run_id: string
  state: "running" | "failed" | "cancelled" | "paused"
}): string[] | undefined {
  const current = input.context.model_run_store.getModelRun(input.model_run_id)
  const revision = current?.manifest?.revision
  if (!revision || !current.model_source) return undefined
  const retained = (current.warnings ?? []).filter(
    (warning) => !warning.startsWith(RETAINED_ACCEPTED_WARNING_PREFIX),
  )
  const attempt_state =
    input.state === "running"
      ? "while a replacement attempt runs"
      : input.state === "failed"
        ? "because the latest replacement attempt failed"
        : input.state === "cancelled"
          ? "because the latest replacement attempt was stopped"
          : "because the latest development model did not meet the publication target"
  const candidate_is_visible = input.state !== "running" && current.validation?.artifact_state === "candidate"
  const visibility_copy = candidate_is_visible
    ? "the validation below belongs to the unaccepted candidate, while accepted downloads remain available"
    : "its downloads remain available, but its metrics are hidden so they are not attributed to the new attempt"
  return [
    ...retained,
    `${RETAINED_ACCEPTED_WARNING_PREFIX} ${revision} ${attempt_state}; ${visibility_copy}.`,
  ]
}

export function markAcceptedArtifactsAsRetained(input: {
  context: ModelRunnerContext
  model_run_id: string
  state: "running" | "failed" | "cancelled" | "paused"
}): string[] | undefined {
  const warnings = retainedAcceptedWarnings(input)
  if (!warnings) return undefined
  const current = input.context.model_run_store.getModelRun(input.model_run_id)
  const preserve_candidate_projection =
    input.state !== "running" && current?.validation?.artifact_state === "candidate"
  input.context.model_run_store.updateModelRun(input.model_run_id, {
    warnings,
    ...(preserve_candidate_projection ? {} : { validation: undefined }),
  })
  if (!preserve_candidate_projection) {
    input.context.model_run_store.updatePreviewOptions(input.model_run_id, [])
    input.context.model_run_store.updatePreviews(input.model_run_id, {})
  }
  return warnings
}

async function runClaimedModel(input: { model_run_id: string }, context: ModelRunnerContext): Promise<void> {
  const model_run = context.model_run_store.getModelRun(input.model_run_id)
  if (!model_run) throw new Error(`Model run ${input.model_run_id} was not found`)
  const job_dir = context.job_store.getJobDir(model_run.job_id)
  const model_dir = context.model_run_store.getModelDir(input.model_run_id)
  const signal = context.model_run_store.getCancellationSignal(input.model_run_id)
  if (!job_dir || !model_dir || !signal) throw new Error("Model run workspace was not found")
  markAcceptedArtifactsAsRetained({
    context,
    model_run_id: input.model_run_id,
    state: "running",
  })
  const process_runner = context.process_runner ?? new BunProcessRunner()
  const agent_client =
    context.agent_client ??
    new TsciAgentClient({
      process_runner,
      agent_bin: context.agent_bin,
      max_attempts: context.agent_transport_retry_limit,
      retry_base_delay_ms: context.agent_transport_retry_base_delay_ms,
    })
  const invocation_id = crypto.randomUUID()
  context.model_run_store.updateModelRun(input.model_run_id, { current_invocation_id: invocation_id })
  const invocation_dir = join(model_dir, "runs", invocation_id)
  await mkdir(invocation_dir, { recursive: true })
  const result = await runPipeline({
    definition: MODEL_PIPELINE,
    run_id: input.model_run_id,
    workspace_dir: invocation_dir,
    context: {
      model_run_id: input.model_run_id,
      job_id: model_run.job_id,
      job_dir,
      model_dir,
      use_openai: model_run.use_openai ?? context.use_openai ?? false,
      repair_budget_ms: model_run.effort_multiplier * REPAIR_BUDGET_MS_PER_EFFORT,
      invocation_id,
    },
    services: {
      job_store: context.job_store,
      model_run_store: context.model_run_store,
      agent_client,
      process_runner,
      strategy_registry: context.strategy_registry ?? new ModelStrategyRegistry(),
      tsci_bin: context.tsci_bin,
    },
    task_input_root: job_dir,
    signal,
    before_stage_start: ({ stage_id, signal: stage_signal }) => {
      if (stage_id === "wait_for_model_evidence") {
        return waitForModelEvidenceBeforeComparison({
          job_id: model_run.job_id,
          model_run_id: input.model_run_id,
          job_store: context.job_store,
          model_run_store: context.model_run_store,
          signal: stage_signal,
        })
      }
      if (stage_id === "wait_for_component") {
        return waitForComponentBeforePublication({
          job_id: model_run.job_id,
          model_run_id: input.model_run_id,
          job_store: context.job_store,
          model_run_store: context.model_run_store,
          signal: stage_signal,
        })
      }
    },
    on_snapshot: (snapshot) => {
      context.model_run_store.updateModelRun(input.model_run_id, {
        pipeline: projectPublicPipelineSnapshot({
          snapshot,
          artifact_root: job_dir,
          private_roots: [model_dir, invocation_dir],
        }),
      })
    },
  })
  const public_result = projectPublicPipelineSnapshot({
    snapshot: result,
    artifact_root: job_dir,
    private_roots: [model_dir, invocation_dir],
  })

  const publish_result = result.stage_results.publish
  const publication_committed =
    publish_result.status === "completed" && publish_result.output.attached === true

  if (result.status === "completed" && publication_committed) {
    try {
      updateModelProgress({
        store: context.model_run_store,
        model_run_id: input.model_run_id,
        phase: "complete",
        message: "Model passed every validation case and was attached to the component",
        iteration: context.model_run_store.getModelRun(input.model_run_id)?.iteration,
      })
    } catch {
      // The publication pointer, rather than this compatibility checkpoint,
      // is authoritative once the pipeline reports committed completion.
    }
    await appendModelLog(
      context.model_run_store,
      input.model_run_id,
      "system",
      "Model pipeline complete: the server-owned validation plan passed and the canonical model was published.\n",
    ).catch(() => undefined)
    try {
      context.model_run_store.finishCommittedSegment(input.model_run_id, {
        status: "complete",
        is_complete: true,
        has_errors: false,
        error_message: undefined,
        completed_at: new Date().toISOString(),
        pipeline: public_result,
      })
    } catch {
      // A concurrent deletion can remove the live record, but it cannot undo
      // the already-committed publication selected on disk.
    }
    return
  }

  if (result.status === "completed") {
    const quality_warning =
      "The development SPICE model remains unpublished because it did not meet the server-owned validation target."
    const current_warnings = context.model_run_store.getModelRun(input.model_run_id)?.warnings ?? []
    const retained_warnings = markAcceptedArtifactsAsRetained({
      context,
      model_run_id: input.model_run_id,
      state: "paused",
    })
    const warnings = [...new Set([...(retained_warnings ?? current_warnings), quality_warning])]
    updateModelProgress({
      store: context.model_run_store,
      model_run_id: input.model_run_id,
      phase: "complete",
      message: "Repair finished; the development model remains unpublished",
      iteration: context.model_run_store.getModelRun(input.model_run_id)?.iteration,
    })
    await appendModelLog(
      context.model_run_store,
      input.model_run_id,
      "system",
      `Model pipeline paused: ${quality_warning}\n`,
    ).catch(() => undefined)
    context.model_run_store.finishSegment(input.model_run_id, {
      status: "complete",
      is_complete: true,
      has_errors: false,
      error_message: undefined,
      warnings,
      completed_at: new Date().toISOString(),
      pipeline: public_result,
    })
    return
  }

  if (result.status === "cancelled" || signal.aborted) {
    const warnings = markAcceptedArtifactsAsRetained({
      context,
      model_run_id: input.model_run_id,
      state: "cancelled",
    })
    updateModelProgress({
      store: context.model_run_store,
      model_run_id: input.model_run_id,
      phase: "cancelled",
      message: "Model pipeline was cancelled",
    })
    await appendModelLog(
      context.model_run_store,
      input.model_run_id,
      "system",
      "Model pipeline was cancelled.\n",
    ).catch(() => undefined)
    context.model_run_store.finishSegment(input.model_run_id, {
      status: "cancelled",
      is_complete: true,
      has_errors: false,
      error_message: undefined,
      ...(warnings === undefined ? {} : { warnings }),
      completed_at: new Date().toISOString(),
      pipeline: public_result,
    })
    return
  }

  const unsupported_message = unsupportedStageMessage(public_result)
  if (unsupported_message) {
    const current_warnings = context.model_run_store.getModelRun(input.model_run_id)?.warnings ?? []
    const retained_warnings = markAcceptedArtifactsAsRetained({
      context,
      model_run_id: input.model_run_id,
      state: "paused",
    })
    const warnings = [...new Set([...(retained_warnings ?? current_warnings), unsupported_message])]
    updateModelProgress({
      store: context.model_run_store,
      model_run_id: input.model_run_id,
      phase: "unsupported",
      message: "No supported reproducible elapsed-time voltage graph exists in this datasheet",
    })
    await appendModelLog(
      context.model_run_store,
      input.model_run_id,
      "system",
      `Model pipeline stopped without an error: ${unsupported_message}\n`,
    ).catch(() => undefined)
    context.model_run_store.finishSegment(input.model_run_id, {
      status: "unsupported",
      is_complete: true,
      has_errors: false,
      error_message: undefined,
      warnings,
      completed_at: new Date().toISOString(),
      pipeline: public_result,
    })
    return
  }

  const error_message = failedStageMessage(public_result)
  const warnings = markAcceptedArtifactsAsRetained({
    context,
    model_run_id: input.model_run_id,
    state: "failed",
  })
  updateModelProgress({
    store: context.model_run_store,
    model_run_id: input.model_run_id,
    phase: "failed",
    message: error_message,
  })
  await appendModelLog(
    context.model_run_store,
    input.model_run_id,
    "system",
    `Model pipeline failed: ${error_message}\n`,
  ).catch(() => undefined)
  context.model_run_store.finishSegment(input.model_run_id, {
    status: "failed",
    is_complete: true,
    has_errors: true,
    error_message,
    ...(warnings === undefined ? {} : { warnings }),
    completed_at: new Date().toISOString(),
    pipeline: public_result,
  })
}

export async function runModel(input: { model_run_id: string }, context: ModelRunnerContext): Promise<void> {
  if (!context.model_run_store.claimModelExecution(input.model_run_id)) return
  try {
    await runClaimedModel(input, context)
  } catch (error) {
    const model_run = context.model_run_store.getModelRun(input.model_run_id)
    if (model_run && !model_run.is_complete) {
      const cancelled = context.model_run_store.getCancellationSignal(input.model_run_id)?.aborted
      const error_message = error instanceof Error ? error.message : String(error)
      const warnings = markAcceptedArtifactsAsRetained({
        context,
        model_run_id: input.model_run_id,
        state: cancelled ? "cancelled" : "failed",
      })
      updateModelProgress({
        store: context.model_run_store,
        model_run_id: input.model_run_id,
        phase: cancelled ? "cancelled" : "failed",
        message: cancelled ? "Model pipeline was cancelled" : error_message,
      })
      await appendModelLog(
        context.model_run_store,
        input.model_run_id,
        "system",
        `${cancelled ? "Model pipeline cancelled" : `Model pipeline crashed: ${error_message}`}\n`,
      ).catch(() => undefined)
      context.model_run_store.finishSegment(input.model_run_id, {
        status: cancelled ? "cancelled" : "failed",
        is_complete: true,
        has_errors: !cancelled,
        error_message: cancelled ? undefined : error_message,
        ...(warnings === undefined ? {} : { warnings }),
        completed_at: new Date().toISOString(),
      })
    }
  } finally {
    context.model_run_store.releaseModelExecution(input.model_run_id)
  }
}
