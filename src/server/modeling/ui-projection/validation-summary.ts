import type {
  ModelValidationBenchmark,
  ModelValidationSeries,
  ModelValidationSummary,
} from "@/shared/job-types"
import type {
  ValidationObservation,
  ValidationPlan,
  ValidationRunResult,
  ValidationSeriesResult,
} from "../../spice-validation"
import type { ModelContract } from "../types"
import { errorMessage, titleFromIdentifier } from "./shared"
import {
  completeViewerValidation,
  missingViewerWaveformMessage,
  normalizeViewerCaseState,
  requiresViewerWaveform,
  type ViewerCaseStateByCase,
  viewerStateMessage,
} from "./viewer-case-state"

function finiteMetrics(series: ValidationSeriesResult[]): Array<{
  rmse: number
  maximum: number
}> {
  return series.flatMap(({ metrics }) =>
    metrics.normalized_rmse !== undefined && Number.isFinite(metrics.normalized_rmse)
      ? [
          {
            rmse: metrics.normalized_rmse,
            maximum:
              metrics.normalized_max_error !== undefined && Number.isFinite(metrics.normalized_max_error)
                ? metrics.normalized_max_error
                : metrics.normalized_rmse,
          },
        ]
      : [],
  )
}

function observationTolerance(observation: ValidationObservation): number {
  return observation.reference.type === "bounds" ? 0 : observation.reference.tolerance
}

/**
 * Projects the authoritative validation result into the legacy UI summary DTO.
 * Every declared case is critical because the v1 validation contract has no
 * advisory case: a model is accepted only when every case passes.
 */
export function projectModelValidationSummary(
  plan: ValidationPlan,
  result: ValidationRunResult,
  contract?: ModelContract,
  viewer_state_by_case?: ViewerCaseStateByCase,
): ModelValidationSummary {
  const result_by_case = new Map(
    result.cases.map((validation_case) => [validation_case.case_id, validation_case]),
  )
  const stimulus_causality_failed = result.errors.some(({ code }) => code === "bound_stimulus_insensitive")
  const benchmarks: ModelValidationBenchmark[] = plan.cases.map((validation_case) => {
    const case_result = result_by_case.get(validation_case.id)
    const viewer_required = requiresViewerWaveform(validation_case)
    const viewer_state = normalizeViewerCaseState(validation_case, viewer_state_by_case?.[validation_case.id])
    const viewer_validation = completeViewerValidation(viewer_state)
    const viewer_error = viewerStateMessage(viewer_state)
    const displayed_series = viewer_required ? (viewer_validation?.series ?? []) : (case_result?.series ?? [])
    const series_by_id = new Map(case_result?.series.map((series) => [series.observation_id, series]) ?? [])
    if (viewer_required) {
      series_by_id.clear()
      for (const series of displayed_series) series_by_id.set(series.observation_id, series)
    }
    const series: ModelValidationSeries[] = validation_case.observations.map((observation) => {
      const series_result = series_by_id.get(observation.id)
      return {
        series_id: observation.id,
        title: titleFromIdentifier(observation.id),
        role: "response",
        unit: observation.unit,
        tolerance: observationTolerance(observation),
        normalized_rmse: series_result?.metrics.normalized_rmse,
        normalized_max_error: series_result?.metrics.normalized_max_error,
        passed: series_result?.passed ?? false,
        error_message:
          errorMessage(series_result?.errors ?? []) ??
          (series_result ? undefined : "Validation did not produce this observation."),
      }
    })
    const metrics = finiteMetrics(displayed_series)
    const normalized_rmse =
      metrics.length > 0 ? metrics.reduce((sum, metric) => sum + metric.rmse, 0) / metrics.length : undefined
    const normalized_max_error =
      metrics.length > 0 ? Math.max(...metrics.map(({ maximum }) => maximum)) : undefined
    return {
      benchmark_id: validation_case.id,
      title: validation_case.title ?? titleFromIdentifier(validation_case.id),
      critical: true,
      tolerance: Math.max(0, ...validation_case.observations.map(observationTolerance)),
      normalized_rmse,
      normalized_max_error,
      passed:
        !stimulus_causality_failed &&
        case_result?.status === "passed" &&
        series.every(({ passed }) => passed) &&
        (!viewer_required || viewer_state.kind === "matched"),
      error_message:
        errorMessage([
          ...(case_result?.errors ?? []),
          ...result.errors,
          ...(viewer_validation?.errors ?? []),
          ...(viewer_error ? [{ message: viewer_error }] : []),
        ]) ??
        (viewer_required && !viewer_validation
          ? missingViewerWaveformMessage(validation_case.id)
          : undefined) ??
        (case_result ? undefined : "Validation did not execute this case."),
      series,
    }
  })
  const scored = benchmarks.flatMap(({ normalized_rmse }) =>
    normalized_rmse !== undefined && Number.isFinite(normalized_rmse) ? [normalized_rmse] : [],
  )
  const maximums = benchmarks.flatMap(({ normalized_max_error }) =>
    normalized_max_error !== undefined && Number.isFinite(normalized_max_error) ? [normalized_max_error] : [],
  )
  const curve_metrics = plan.cases.flatMap((validation_case) => {
    const case_result = result_by_case.get(validation_case.id)
    const viewer_required = requiresViewerWaveform(validation_case)
    const viewer_state = normalizeViewerCaseState(validation_case, viewer_state_by_case?.[validation_case.id])
    const viewer_validation = completeViewerValidation(viewer_state)
    const series_by_id = new Map(
      (viewer_required ? viewer_validation?.series : case_result?.series)?.map((series) => [
        series.observation_id,
        series,
      ]) ?? [],
    )
    return validation_case.observations.flatMap((observation) => {
      if (observation.reference.type !== "curve") return []
      const series = series_by_id.get(observation.id)
      const normalized_rmse = series?.metrics.normalized_rmse
      if (
        !series ||
        series.points.length === 0 ||
        normalized_rmse === undefined ||
        !Number.isFinite(normalized_rmse)
      ) {
        return []
      }
      const sample_count = Math.max(1, series.metrics.sample_count)
      return [
        {
          normalized_rmse,
          normalized_max_error:
            series.metrics.normalized_max_error !== undefined &&
            Number.isFinite(series.metrics.normalized_max_error)
              ? series.metrics.normalized_max_error
              : normalized_rmse,
          sample_count,
        },
      ]
    })
  })
  const curve_sample_count = curve_metrics.reduce((sum, metric) => sum + metric.sample_count, 0)
  const curve_score =
    curve_sample_count > 0
      ? curve_metrics.reduce((sum, metric) => sum + metric.normalized_rmse * metric.sample_count, 0) /
        curve_sample_count
      : undefined
  const curve_worst_normalized_error =
    curve_metrics.length > 0
      ? Math.max(...curve_metrics.map(({ normalized_max_error }) => normalized_max_error))
      : undefined
  const passing_count = benchmarks.filter(({ passed }) => passed).length
  const scope = contract
    ? (() => {
        const modeled = contract.characterization.requirements.filter(
          ({ support }) => support.status === "modeled",
        )
        const documented_only = contract.characterization.requirements.flatMap((requirement) =>
          requirement.support.status === "documented_only"
            ? [
                {
                  requirement_id: requirement.requirement_id,
                  title: requirement.title,
                  reason: requirement.support.reason,
                },
              ]
            : [],
        )
        const curve_observation_count = plan.cases.reduce(
          (count, validation_case) =>
            count + validation_case.observations.filter(({ reference }) => reference.type === "curve").length,
          0,
        )
        const scalar_observation_count =
          plan.cases.reduce((count, validation_case) => count + validation_case.observations.length, 0) -
          curve_observation_count
        const validated_sample_count = result.cases.reduce(
          (count, validation_case) =>
            count +
            validation_case.series.reduce((series_count, series) => series_count + series.points.length, 0),
          0,
        )
        const swept_case_count = plan.cases.filter(
          ({ analysis }) => analysis.type === "dc_sweep" || analysis.type === "transient",
        ).length
        return {
          total_requirement_count: contract.characterization.requirements.length,
          modeled_requirement_count: modeled.length,
          documented_only_requirement_count: documented_only.length,
          validated_sample_count,
          scalar_observation_count,
          curve_observation_count,
          compared_curve_observation_count: curve_metrics.length,
          curve_sample_count,
          swept_case_count,
          quality:
            curve_metrics.length > 0
              ? ("curve_validated" as const)
              : curve_observation_count > 0
                ? ("curve_attempted" as const)
                : swept_case_count > 0 || validated_sample_count > scalar_observation_count
                  ? ("range_checked" as const)
                  : ("scalar_only" as const),
          documented_only_requirements: documented_only,
          limitations: [...contract.characterization.limitations],
        }
      })()
    : undefined
  return {
    benchmark_count: benchmarks.length,
    passing_count,
    critical_count: benchmarks.length,
    critical_passing_count: passing_count,
    score: scored.length > 0 ? scored.reduce((sum, value) => sum + value, 0) / scored.length : undefined,
    worst_normalized_error: maximums.length > 0 ? Math.max(...maximums) : undefined,
    curve_score,
    curve_worst_normalized_error,
    all_critical_passed: result.passed && benchmarks.length > 0 && passing_count === benchmarks.length,
    all_passed: result.passed && benchmarks.length > 0 && passing_count === benchmarks.length,
    benchmarks,
    ...(scope ? { scope } : {}),
  }
}
