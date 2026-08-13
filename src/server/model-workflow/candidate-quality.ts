import type { ViewerSimulationValidation } from "../modeling"
import type { ValidationRunResult } from "../spice-validation"
import { getNonRepairableValidationErrors } from "./validation-repair-policy"

export interface CandidateViewerQualityCase {
  readonly case_id: string
  readonly available: boolean
  readonly series: ReadonlyArray<{
    readonly passed: boolean
    readonly normalized_max_error?: number
    readonly normalized_rmse?: number
  }>
}

export interface CandidateQuality {
  readonly passed: boolean
  readonly non_repairable_error_count: number
  readonly causality_failure_count: number
  readonly viewer_unavailable_count: number
  readonly failed_case_count: number
  readonly failed_series_count: number
  readonly worst_normalized_error: number
  readonly mean_normalized_error: number
}

function finite(values: readonly (number | undefined)[]): number[] {
  return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
}

export function viewerQualityCasesFromValidation(input: {
  case_ids: readonly string[]
  viewer_validation_by_case: Readonly<Record<string, ViewerSimulationValidation | undefined>>
}): CandidateViewerQualityCase[] {
  return input.case_ids.map((case_id) => {
    const validation = input.viewer_validation_by_case[case_id]
    return {
      case_id,
      available: validation?.simulation_valid === true,
      series:
        validation?.series.map((series) => ({
          passed: series.passed,
          normalized_max_error: series.metrics.normalized_max_error,
          normalized_rmse: series.metrics.normalized_rmse,
        })) ?? [],
    }
  })
}

/**
 * Creates a deterministic, model-agnostic quality rank. It rewards complete
 * direct/viewer execution before numeric fit, so a non-runnable candidate can
 * never displace a slightly less accurate but inspectable one.
 */
export function createCandidateQuality(input: {
  result: ValidationRunResult
  viewer_cases: readonly CandidateViewerQualityCase[]
}): CandidateQuality {
  const direct_failed_case_ids = new Set(
    input.result.cases.filter(({ status }) => status !== "passed").map(({ case_id }) => case_id),
  )
  const failed_case_ids = new Set(direct_failed_case_ids)
  const viewer_unavailable_count = input.viewer_cases.filter(({ available }) => !available).length
  for (const viewer_case of input.viewer_cases) {
    if (!viewer_case.available || viewer_case.series.some(({ passed }) => !passed)) {
      failed_case_ids.add(viewer_case.case_id)
    }
  }
  const direct_series = input.result.cases.flatMap(({ series }) => series)
  const viewer_series = input.viewer_cases.flatMap(({ series }) => series)
  const normalized_errors = finite([
    ...direct_series.flatMap(({ metrics }) => [metrics.normalized_max_error, metrics.normalized_rmse]),
    ...viewer_series.flatMap(({ normalized_max_error, normalized_rmse }) => [
      normalized_max_error,
      normalized_rmse,
    ]),
  ])
  const causality_failure_count = input.result.errors.filter(
    ({ code }) => code === "bound_stimulus_insensitive",
  ).length
  const non_repairable_error_count = getNonRepairableValidationErrors(input.result).length
  const failed_series_count =
    direct_series.filter(({ passed }) => !passed).length +
    viewer_series.filter(({ passed }) => !passed).length
  const passed =
    input.result.passed &&
    causality_failure_count === 0 &&
    viewer_unavailable_count === 0 &&
    failed_case_ids.size === 0 &&
    failed_series_count === 0
  return {
    passed,
    non_repairable_error_count,
    causality_failure_count,
    viewer_unavailable_count,
    failed_case_count: failed_case_ids.size,
    failed_series_count,
    worst_normalized_error: normalized_errors.length > 0 ? Math.max(...normalized_errors) : Infinity,
    mean_normalized_error:
      normalized_errors.length > 0
        ? normalized_errors.reduce((sum, value) => sum + value, 0) / normalized_errors.length
        : Infinity,
  }
}

const QUALITY_FIELDS: readonly (keyof CandidateQuality)[] = [
  "passed",
  "non_repairable_error_count",
  "causality_failure_count",
  "viewer_unavailable_count",
  "failed_case_count",
  "failed_series_count",
  "worst_normalized_error",
  "mean_normalized_error",
]

const QUALITY_FIELD_LABELS: Readonly<Record<keyof CandidateQuality, string>> = {
  passed: "validation target",
  non_repairable_error_count: "non-repairable errors",
  causality_failure_count: "stimulus-causality failures",
  viewer_unavailable_count: "unavailable viewer simulations",
  failed_case_count: "failed cases",
  failed_series_count: "failed series",
  worst_normalized_error: "worst normalized error",
  mean_normalized_error: "mean normalized error",
}

type CandidateQualityDirection = "improved" | "unchanged" | "worsened"

function qualityFieldValue(quality: CandidateQuality, field: keyof CandidateQuality): number {
  return field === "passed" ? (quality.passed ? 0 : 1) : quality[field]
}

function qualityDirection(input: {
  candidate: CandidateQuality
  incumbent: CandidateQuality
  field: keyof CandidateQuality
}): CandidateQualityDirection {
  const candidate_value = qualityFieldValue(input.candidate, input.field)
  const incumbent_value = qualityFieldValue(input.incumbent, input.field)
  if (candidate_value < incumbent_value) return "improved"
  if (candidate_value > incumbent_value) return "worsened"
  return "unchanged"
}

/**
 * Gives the next repair attempt qualitative feedback about a rejected result.
 * The ordered, server-owned gates are disclosed without exposing reference
 * points or encouraging a candidate to optimize a private validation sample.
 */
export function formatRejectedCandidateQualityFeedback(input: {
  candidate: CandidateQuality
  incumbent: CandidateQuality
}): string {
  const comparisons = QUALITY_FIELDS.map((field) => ({
    field,
    direction: qualityDirection({ ...input, field }),
  }))
  const decisive = comparisons.find(({ direction }) => direction !== "unchanged")
  return [
    "Server evaluation of the rejected candidate (gates are listed in acceptance priority):",
    ...comparisons.map(({ field, direction }) => `- ${QUALITY_FIELD_LABELS[field]}: ${direction}.`),
    decisive
      ? `The candidate was rejected because its first changed gate, ${QUALITY_FIELD_LABELS[decisive.field]}, ${decisive.direction}. Preserve the incumbent and choose a different diagnosis.`
      : "The candidate tied the incumbent at every quality gate. Preserve the incumbent and choose a different diagnosis.",
  ].join("\n")
}

/** Negative means left is better, positive means right is better, zero is a tie. */
export function compareCandidateQuality(left: CandidateQuality, right: CandidateQuality): number {
  for (const field of QUALITY_FIELDS) {
    const left_value = qualityFieldValue(left, field)
    const right_value = qualityFieldValue(right, field)
    if (left_value < right_value) return -1
    if (left_value > right_value) return 1
  }
  return 0
}
