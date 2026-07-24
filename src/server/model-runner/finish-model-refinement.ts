import { rm } from "node:fs/promises"
import { join } from "node:path"
import { isModelEvidenceQualityWarning } from "@/shared/model-warnings"
import { verifyBenchmarkLock } from "../model-benchmark-lock"
import { attachModelToGeneratedComponent } from "./attach-model-to-generated-component"
import { createUnverifiedFallbackModel } from "./create-unverified-fallback-model"
import { markModelCardAsUnverified, markModelCardWithEvidenceWarning } from "./model-checkpoint"
import type { ModelExecution } from "./model-execution"
import type { ModelRefinementState } from "./model-refinement-state"
import { updateServerProgress } from "./model-run-state"

export async function finishModelRefinement(
  state: ModelRefinementState,
  execution: ModelExecution,
): Promise<void> {
  execution.stopBudgetMonitor()
  if (state.isValidationComplete && state.final_champion && state.final_validation) {
    const current_warnings =
      execution.context.model_run_store.getModelRun(execution.model_run_id)?.warnings ?? execution.warnings
    const has_evidence_quality_warnings = current_warnings.some(isModelEvidenceQualityWarning)
    const published_model_card = has_evidence_quality_warnings
      ? markModelCardWithEvidenceWarning(state.final_champion.model_card)
      : state.final_champion.model_card
    await verifyBenchmarkLock(execution.model_dir, state.benchmark_lock)
    await rm(join(execution.model_dir, "validation-feedback.md"), { force: true })
    await attachModelToGeneratedComponent({
      job_id: execution.model_run.job_id,
      job_dir: execution.job_dir,
      model_dir: execution.model_dir,
      job_store: execution.context.job_store,
    })
    await execution.append(
      "system",
      "Attached the validated server-generated model wrapper to the component.\n",
    )
    await execution.append(
      "system",
      has_evidence_quality_warnings
        ? "SPICE simulation complete. Every locked benchmark passed, but datasheet evidence-quality warnings prevent an independent accuracy claim.\n"
        : "SPICE model complete. Every locked benchmark passed verified simulation.\n",
    )
    updateServerProgress(
      {
        model_run_id: execution.model_run_id,
        phase: "complete",
        message: has_evidence_quality_warnings
          ? "Verified simulation completed with datasheet evidence warnings"
          : "Every locked benchmark passed server-verified simulation",
        update: {
          iteration: state.final_champion.iteration,
          benchmark: {
            completed: state.final_validation.benchmark_count,
            total: state.final_validation.benchmark_count,
          },
          champion: {
            revision: state.final_champion.manifest.revision,
            passing: state.final_validation.passing_count,
            total: state.final_validation.benchmark_count,
            score: state.final_validation.score,
            worst_normalized_error: state.final_validation.worst_normalized_error,
          },
        },
      },
      execution.context.model_run_store,
    )
    execution.context.model_run_store.finishSegment(execution.model_run_id, {
      status: "complete",
      is_complete: true,
      has_errors: false,
      error_message: undefined,
      completed_at: new Date().toISOString(),
      iteration: state.final_champion.iteration,
      model_source: state.final_champion.model_source,
      manifest: state.final_champion.manifest,
      validation: state.final_validation,
      model_card: published_model_card,
    })
    return
  }

  const terminal_message =
    state.final_error_message ?? "Ran out of iterations before every benchmark could be verified."
  const remaining_time_ms = execution.context.model_run_store.getRemainingTimeMs(execution.model_run_id) ?? 0
  const effort_expired = execution.budget_exhausted || remaining_time_ms <= 0
  const terminal_summary = execution.stale_timeout
    ? "The model run timed out after producing no output"
    : effort_expired
      ? "The model run exhausted its refinement effort before 100% validation"
      : "The model run failed before 100% validation"
  await execution.append(
    "system",
    `${terminal_summary}. The latest model checkpoint remains available. ${terminal_message}\n`,
  )
  const fallback = state.final_champion
    ? {
        iteration: state.final_champion.iteration,
        model_source: state.final_champion.model_source,
        manifest: state.final_champion.manifest,
        model_card: markModelCardAsUnverified(state.final_champion.model_card),
      }
    : { iteration: 0, ...(await createUnverifiedFallbackModel(execution)) }
  await execution.addWarning(
    `The best available SPICE output was published without full benchmark validation: ${terminal_message}`,
  )
  updateServerProgress(
    {
      model_run_id: execution.model_run_id,
      phase: "complete",
      message: "Best available SPICE output published with warnings",
    },
    execution.context.model_run_store,
  )
  execution.context.model_run_store.finishSegment(execution.model_run_id, {
    status: "complete",
    is_complete: true,
    has_errors: false,
    error_message: undefined,
    completed_at: new Date().toISOString(),
    ...fallback,
    ...(state.final_validation ? { validation: state.final_validation } : {}),
  })
}
