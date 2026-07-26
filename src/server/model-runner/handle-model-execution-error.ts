import { ComponentNotReadyError } from "../model-scaffold"
import { createUnverifiedFallbackModel } from "./create-unverified-fallback-model"
import { publishAvailableModelCheckpoint, restoreBestReportedModelCheckpoint } from "./model-checkpoint"
import type { ModelExecution } from "./model-execution"
import { updateServerProgress } from "./model-run-state"
import {
  ModelInfrastructureError,
  ModelPreparationError,
  ModelProcessStaleError,
  ModelWorkspaceIsolationError,
} from "./stream-model-process"

export function normalizeModelExecutionErrorMessage(message: string): string {
  if (
    /(?:exceeded|exhausted).{0,30}(?:quota|billing)|insufficient_quota|check your plan and billing/i.test(
      message,
    )
  ) {
    return "The model provider quota is exhausted."
  }
  return message
}

export function getModelExecutionRecoveryWarning(input: {
  error_message: string
  preserved_existing_output: boolean
}): string {
  const normalized_message = normalizeModelExecutionErrorMessage(input.error_message)
  return normalized_message === "The model provider quota is exhausted." && input.preserved_existing_output
    ? "Additional SPICE refinement could not start because the model provider quota is exhausted. The previously published SPICE output was preserved unchanged."
    : `The latest recoverable SPICE artifact was retained after workflow failure: ${normalized_message}`
}

export async function handleModelExecutionError(error: unknown, execution: ModelExecution): Promise<void> {
  execution.stopBudgetMonitor()
  if (execution.cancellation_signal.aborted) {
    await execution.preserveCancellation()
    return
  }

  const is_stale_error = error instanceof ModelProcessStaleError
  const is_infrastructure_error = error instanceof ModelInfrastructureError
  const raw_error_message = is_stale_error
    ? "The model run timed out after producing no output."
    : error instanceof Error
      ? error.message
      : String(error)
  const error_message = normalizeModelExecutionErrorMessage(raw_error_message)
  const is_quota_error = error_message === "The model provider quota is exhausted."
  if (error instanceof ComponentNotReadyError || error instanceof ModelPreparationError) {
    const preparation_failure = error instanceof ModelPreparationError
    await execution
      .append(
        "system",
        `\n${
          preparation_failure
            ? "SPICE model workflow stopped before refinement"
            : "SPICE model workflow failed"
        }: ${error_message}\n`,
      )
      .catch(() => undefined)
    updateServerProgress(
      {
        model_run_id: execution.model_run_id,
        phase: "failed",
        message: preparation_failure
          ? "SPICE generation stopped because setup evidence or benchmarks did not pass validation"
          : "SPICE generation stopped because no authoritative component passed validation",
      },
      execution.context.model_run_store,
    )
    const update = {
      status: "failed" as const,
      is_complete: true,
      has_errors: true,
      completed_at: new Date().toISOString(),
      error_message,
    }
    const current_run = execution.context.model_run_store.getModelRun(execution.model_run_id)
    if (current_run?.segment_started_at) {
      execution.context.model_run_store.finishSegment(execution.model_run_id, update)
    } else {
      execution.context.model_run_store.updateModelRun(execution.model_run_id, update)
    }
    return
  }
  if (is_stale_error || error instanceof ModelWorkspaceIsolationError) {
    const restored_revision = await restoreBestReportedModelCheckpoint(execution.model_dir).catch(
      () => undefined,
    )
    if (restored_revision) {
      await execution
        .append(
          "system",
          `Restored reported champion ${restored_revision} after terminating the agent process tree.\n`,
        )
        .catch(() => undefined)
    }
  }
  await publishAvailableModelCheckpoint(
    { model_run_id: execution.model_run_id, model_dir: execution.model_dir },
    execution.context.model_run_store,
  ).catch(() => false)
  await execution
    .append(
      "system",
      `\n${
        is_stale_error
          ? "The model run timed out after producing no output"
          : is_quota_error
            ? "Additional SPICE refinement could not start"
            : is_infrastructure_error
              ? "The model run stopped safely because a server infrastructure check failed"
              : "SPICE model workflow failed"
      }: ${error_message}\n`,
    )
    .catch(() => undefined)
  let current_run = execution.context.model_run_store.getModelRun(execution.model_run_id)
  const preserved_existing_output = Boolean(current_run?.model_source)
  const preserved_verified_output = Boolean(current_run?.model_source && current_run.validation?.all_passed)
  if (!current_run?.model_source || !current_run.manifest) {
    const fallback = await createUnverifiedFallbackModel(execution)
    current_run = execution.context.model_run_store.updateModelRun(execution.model_run_id, fallback)
  }
  await execution
    .addWarning(
      getModelExecutionRecoveryWarning({
        error_message,
        preserved_existing_output,
      }),
    )
    .catch(() => undefined)
  const can_finish_with_recovery = preserved_verified_output || execution.budget_exhausted
  const update = can_finish_with_recovery
    ? {
        status: "complete" as const,
        is_complete: true,
        has_errors: false,
        completed_at: new Date().toISOString(),
        error_message: undefined,
      }
    : {
        status: "failed" as const,
        is_complete: true,
        has_errors: true,
        completed_at: new Date().toISOString(),
        error_message,
      }
  updateServerProgress(
    {
      model_run_id: execution.model_run_id,
      phase: can_finish_with_recovery ? "complete" : "failed",
      message: can_finish_with_recovery
        ? preserved_verified_output
          ? "Previously verified SPICE output preserved with warnings"
          : "Refinement effort expired; the latest recoverable artifact was retained"
        : "SPICE workflow failed; the latest recoverable artifact was retained for retry",
    },
    execution.context.model_run_store,
  )
  if (current_run?.segment_started_at) {
    execution.context.model_run_store.finishSegment(execution.model_run_id, update)
  } else {
    execution.context.model_run_store.updateModelRun(execution.model_run_id, update)
  }
}
