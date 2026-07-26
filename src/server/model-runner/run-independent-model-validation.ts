import { join } from "node:path"
import { verifyBenchmarkLock } from "../model-benchmark-lock"
import { scoreModelBenchmarks } from "../model-scorer"
import {
  clearVerifiedSimulationResults,
  getVerifiedResultsDirectory,
  hasCompleteVerifiedSimulationReport,
} from "../model-simulation-validator"
import type { ModelExecution } from "./model-execution"
import type { ModelRefinementState } from "./model-refinement-state"
import { updateServerProgress } from "./model-run-state"
import { ModelInfrastructureError, ModelProcessStaleError } from "./stream-model-process"
import {
  findSuspiciousBenchmarkConditioning,
  validateAbsoluteTimeShift,
} from "./validate-absolute-time-shift"
import { validateChampion } from "./validate-champion"
import { validateFeedbackSensitivity } from "./validate-feedback-sensitivity"

export function getStimulusScoringContractError(validation: {
  benchmarks: Array<{
    benchmark_id: string
    series?: Array<{
      series_id: string
      role: string
      passed: boolean
      normalized_rmse?: number
      normalized_max_error?: number
      error_message?: string
    }>
  }>
}): string | undefined {
  const failures = validation.benchmarks.flatMap((benchmark) =>
    (benchmark.series ?? []).flatMap((series) =>
      series.role === "stimulus" && !series.passed
        ? [
            `${benchmark.benchmark_id}/${series.series_id}: ${
              series.error_message ??
              `NRMSE ${series.normalized_rmse ?? "unavailable"}, max ${
                series.normalized_max_error ?? "unavailable"
              }`
            }`,
          ]
        : [],
    ),
  )
  return failures.length > 0
    ? `Locked benchmark harness stimulus failed the authoritative scorer and requires controlled circuit repair: ${failures.join(
        " | ",
      )}`
    : undefined
}

async function validateModelIntegrity(input: {
  state: ModelRefinementState
  execution: ModelExecution
  validation_signal: AbortSignal
}): Promise<void> {
  const { state, execution, validation_signal } = input
  const final_champion = state.final_champion
  if (!state.final_validation?.all_passed || !final_champion || final_champion.integration_error) return
  const integrity_findings = findSuspiciousBenchmarkConditioning(final_champion.model_source)
  if (integrity_findings.length > 0) {
    state.model_integrity_error = `Model integrity review failed: ${integrity_findings.join("; ")}`
    state.final_validation = {
      ...state.final_validation,
      all_passed: false,
      all_critical_passed: false,
    }
    return
  }

  const feedback_sensitivity = await validateFeedbackSensitivity({
    job_dir: execution.job_dir,
    model_dir: execution.model_dir,
    tsci_bin: execution.context.tsci_bin,
    signal: validation_signal,
    append: execution.append.bind(execution),
  })
  if (feedback_sensitivity.required && feedback_sensitivity.passed) {
    await execution.append(
      "system",
      `Hidden feedback-sensitivity check passed for ${feedback_sensitivity.benchmark_id}.\n`,
    )
  } else if (!feedback_sensitivity.passed) {
    state.model_integrity_error = `Feedback-sensitivity check failed${
      feedback_sensitivity.benchmark_id ? ` for ${feedback_sensitivity.benchmark_id}` : ""
    }: ${feedback_sensitivity.error_message ?? "the output did not follow the external feedback network"}`
    state.final_validation = {
      ...state.final_validation,
      all_passed: false,
      all_critical_passed: false,
    }
    return
  }

  const causal_shift = await validateAbsoluteTimeShift({
    job_dir: execution.job_dir,
    model_dir: execution.model_dir,
    tsci_bin: execution.context.tsci_bin,
    signal: validation_signal,
    append: execution.append.bind(execution),
  })
  if (causal_shift.required && causal_shift.passed) {
    await execution.append("system", `Hidden stimulus-shift check passed for ${causal_shift.benchmark_id}.\n`)
  } else if (!causal_shift.passed) {
    state.causal_shift_error = `Causal stimulus-shift check failed${
      causal_shift.benchmark_id ? ` for ${causal_shift.benchmark_id}` : ""
    }: ${causal_shift.error_message ?? "the shifted output did not follow its input stimulus"}`
    state.final_validation = {
      ...state.final_validation,
      all_passed: false,
      all_critical_passed: false,
    }
  }
}

export async function runIndependentModelValidation(
  state: ModelRefinementState,
  execution: ModelExecution,
): Promise<boolean> {
  execution.context.model_run_store.updateModelRun(execution.model_run_id, {
    status: "validating",
    is_complete: false,
    has_errors: false,
  })
  await execution.progress_monitor?.sync()
  await execution.artifact_monitor?.sync()
  updateServerProgress(
    {
      model_run_id: execution.model_run_id,
      phase: "validating",
      message: "Re-running the locked suite and extracting server-verified simulator results",
    },
    execution.context.model_run_store,
  )
  execution.context.model_run_store.pauseSegment(execution.model_run_id)
  execution.stopBudgetMonitor()
  state.final_error_message = undefined
  state.causal_shift_error = undefined
  state.model_integrity_error = undefined

  const validation_controller = new AbortController()
  const cancel_validation = validation_controller.abort.bind(validation_controller)
  execution.cancellation_signal.addEventListener("abort", cancel_validation, { once: true })
  const configured_validation_timeout_ms = Number(process.env.MODEL_VALIDATION_TIMEOUT_MS ?? 30 * 60_000)
  const validation_timeout_ms = Number.isFinite(configured_validation_timeout_ms)
    ? Math.max(1_000, configured_validation_timeout_ms)
    : 30 * 60_000
  const validation_timer = setTimeout(() => validation_controller.abort(), validation_timeout_ms)

  try {
    await clearVerifiedSimulationResults(execution.model_dir)
    state.final_champion = await validateChampion(
      {
        model_run_id: execution.model_run_id,
        job_id: execution.model_run.job_id,
        job_dir: execution.job_dir,
        model_dir: execution.model_dir,
        benchmark_lock: state.benchmark_lock,
        signal: validation_controller.signal,
      },
      execution.context,
    )
    if (state.final_champion.infrastructure_error) {
      throw new ModelInfrastructureError(state.final_champion.infrastructure_error)
    }
    await verifyBenchmarkLock(execution.model_dir, state.benchmark_lock)
    if (state.final_champion.benchmark_contract_error) {
      state.final_error_message = state.final_champion.benchmark_contract_error
    } else if (!(await hasCompleteVerifiedSimulationReport(execution.model_dir))) {
      state.final_validation = undefined
      state.final_error_message =
        "Scoring was deferred because independent simulation validation is incomplete."
    } else {
      state.final_validation = await scoreModelBenchmarks(execution.model_dir, {
        results_directory_override: getVerifiedResultsDirectory(execution.model_dir),
      })
      const stimulus_contract_error = getStimulusScoringContractError(state.final_validation)
      if (stimulus_contract_error) {
        state.final_champion.benchmark_contract_error = stimulus_contract_error
        state.final_error_message = stimulus_contract_error
      }
      await Bun.write(
        join(execution.model_dir, "validation-report.json"),
        `${JSON.stringify(state.final_validation, null, 2)}\n`,
      )
      await execution.artifact_monitor?.sync()
      await validateModelIntegrity({
        state,
        execution,
        validation_signal: validation_controller.signal,
      })
    }
  } catch (error) {
    if (error instanceof ModelInfrastructureError) throw error
    state.final_error_message = error instanceof Error ? error.message : String(error)
    if (state.final_validation?.all_passed) {
      state.causal_shift_error = state.final_error_message
      state.final_validation = {
        ...state.final_validation,
        all_passed: false,
        all_critical_passed: false,
      }
    }
    if (error instanceof ModelProcessStaleError) execution.stale_timeout = true
  } finally {
    clearTimeout(validation_timer)
    execution.cancellation_signal.removeEventListener("abort", cancel_validation)
  }

  if (execution.cancellation_signal.aborted) {
    await execution.preserveCancellation()
    return false
  }
  return true
}
