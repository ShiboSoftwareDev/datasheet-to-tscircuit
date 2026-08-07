import type { ModelReferencePreview, ModelReferenceSeriesPreview } from "@/shared/job-types"
import type { ModelRequirement } from "../types"
import type {
  FixtureElement,
  ValidationAnalysis,
  ValidationCase,
  ValidationObservation,
  ValidationRunResult,
  ValidationSeriesPoint,
  ValidationSeriesResult,
} from "../../spice-validation"
import { averageDefined, maximumDefined, titleFromIdentifier } from "./shared"
import {
  completeViewerValidation,
  normalizeViewerCaseState,
  requiresViewerWaveform,
  type ViewerCaseState,
} from "./viewer-case-state"

const MAX_PREVIEW_POINTS = 600

function downsample(points: ValidationSeriesPoint[]): ValidationSeriesPoint[] {
  if (points.length <= MAX_PREVIEW_POINTS) return points.map(({ x, y }) => ({ x, y }))
  const stride = Math.ceil(points.length / MAX_PREVIEW_POINTS)
  return points.filter((_, index) => index % stride === 0 || index === points.length - 1)
}

/** Projects the immutable source series used to start a comparison chart. */
export function projectReferenceComparisonDraft(input: {
  requirement: ModelRequirement
  updated_at: string
}): ModelReferencePreview {
  const curve = input.requirement.reference_curve
  if (input.requirement.support.status !== "modeled" || !curve) {
    throw new Error(`Requirement ${input.requirement.requirement_id} has no modeled reference graph`)
  }
  const source_file = curve.image?.trim()
  if (!source_file) {
    throw new Error(`Reference graph ${input.requirement.requirement_id} has no retained source image`)
  }
  return {
    benchmark_id: input.requirement.requirement_id,
    title: input.requirement.title,
    source_file,
    x_axis_label: titleFromIdentifier(curve.x_quantity),
    x_axis_unit: curve.x_unit,
    y_axis_label: titleFromIdentifier(curve.y_quantity),
    y_axis_unit: curve.y_unit,
    x_scale: "linear",
    y_scale: "linear",
    reference_kind: "curve",
    reference_points: downsample(curve.points),
    is_stale: false,
    updated_at: input.updated_at,
  }
}

function referencePoints(
  observation: ValidationObservation,
  result_points: ValidationSeriesPoint[],
): ValidationSeriesPoint[] {
  const reference = observation.reference
  if (reference.type === "curve") return reference.points.map(({ x, y }) => ({ x, y }))
  if (reference.type === "bounds") return []
  const x_values = result_points.length > 0 ? result_points.map(({ x }) => x) : [0]
  return x_values.map((x) => ({ x, y: reference.target }))
}

function referenceBounds(observation: ValidationObservation): { min?: number; max?: number } | undefined {
  const reference = observation.reference
  if (reference.type !== "bounds") return undefined
  return {
    ...(reference.min === undefined ? {} : { min: reference.min }),
    ...(reference.max === undefined ? {} : { max: reference.max }),
  }
}

function metadataValue(observation: ValidationObservation, ...names: string[]): string | undefined {
  const metadata = observation.evidence?.metadata
  for (const name of names) {
    const value = metadata?.[name]?.trim()
    if (value) return value
  }
  return undefined
}

function analysisAxis(input: { analysis: ValidationAnalysis; fixtures: FixtureElement[] }): {
  label: string
  unit: string
} {
  const analysis = input.analysis
  if (analysis.type === "transient") return { label: "Time", unit: "s" }
  if (analysis.type === "operating_point") return { label: "Operating point", unit: "" }
  const source = input.fixtures.find(({ id }) => id === analysis.source_id)
  return {
    label: titleFromIdentifier(analysis.source_id),
    unit: source?.type === "current_source" ? "A" : "V",
  }
}

function observationQuantity(observation: ValidationObservation): string {
  return (
    metadataValue(observation, "y_quantity", "quantity") ??
    (observation.type === "voltage" ? "voltage" : "current")
  )
}

function observationSourceFile(observation: ValidationObservation): string {
  return observation.evidence?.image ?? "validation-plan.json"
}

function projectReferenceSeries(input: {
  observation: ValidationObservation
  result?: ValidationSeriesResult
}): ModelReferenceSeriesPreview {
  const result_points = downsample(input.result?.points ?? [])
  return {
    series_id: input.observation.id,
    title: titleFromIdentifier(input.observation.id),
    role: input.observation.role ?? "response",
    quantity: observationQuantity(input.observation),
    unit: metadataValue(input.observation, "y_unit") ?? input.observation.unit,
    source_file: observationSourceFile(input.observation),
    result_file: input.result ? "validation-results.json" : undefined,
    y_scale: input.observation.scale,
    reference_kind: input.observation.reference.type,
    reference_points: downsample(referencePoints(input.observation, result_points)),
    reference_bounds: referenceBounds(input.observation),
    result_points: input.result ? result_points : undefined,
    normalized_rmse: input.result?.metrics.normalized_rmse,
    normalized_max_error: input.result?.metrics.normalized_max_error,
    matches_reference: input.result?.passed,
  }
}

export function projectModelReferencePreview(input: {
  validation_case: ValidationCase
  result?: ValidationRunResult
  updated_at: string
  viewer_state?: ViewerCaseState
}): ModelReferencePreview {
  const case_result = input.result?.cases.find(({ case_id }) => case_id === input.validation_case.id)
  const viewer_required = requiresViewerWaveform(input.validation_case)
  const viewer_state = normalizeViewerCaseState(input.validation_case, input.viewer_state)
  const viewer_validation = completeViewerValidation(viewer_state)
  const displayed_series = viewer_required ? (viewer_validation?.series ?? []) : (case_result?.series ?? [])
  const result_by_observation = new Map(displayed_series.map((series) => [series.observation_id, series]))
  const series = input.validation_case.observations.map((observation) =>
    projectReferenceSeries({
      observation,
      result: result_by_observation.get(observation.id),
    }),
  )
  const primary = series[0]
  const primary_observation = input.validation_case.observations[0]
  if (!primary || !primary_observation) {
    throw new Error(`Validation case ${input.validation_case.id} has no observations`)
  }
  const axis = analysisAxis({
    analysis: input.validation_case.analysis,
    fixtures: input.validation_case.fixtures,
  })
  return {
    benchmark_id: input.validation_case.id,
    title: input.validation_case.title ?? titleFromIdentifier(input.validation_case.id),
    source_file: primary.source_file,
    result_file: primary.result_file,
    x_axis_label: metadataValue(primary_observation, "x_quantity") ?? axis.label,
    x_axis_unit: metadataValue(primary_observation, "x_unit") ?? axis.unit,
    y_axis_label: titleFromIdentifier(primary.quantity),
    y_axis_unit: primary.unit,
    x_scale: "linear",
    y_scale: primary.y_scale,
    reference_kind: primary.reference_kind,
    reference_points: primary.reference_points,
    reference_bounds: primary.reference_bounds,
    result_points: primary.result_points,
    series,
    result_status:
      case_result?.status === "cancelled"
        ? "cancelled"
        : viewer_required
          ? case_result?.status === "passed" && viewer_state.kind === "matched"
            ? "verified"
            : case_result
              ? "failed"
              : undefined
          : case_result?.status === "passed"
            ? "verified"
            : case_result?.status,
    result_origin: viewer_required ? "tscircuit_viewer" : case_result ? "server_validation" : undefined,
    normalized_rmse: case_result
      ? averageDefined(displayed_series.map(({ metrics }) => metrics.normalized_rmse))
      : undefined,
    normalized_max_error: case_result
      ? maximumDefined(displayed_series.map(({ metrics }) => metrics.normalized_max_error))
      : undefined,
    matches_reference:
      case_result?.status === "cancelled"
        ? undefined
        : case_result
          ? viewer_required
            ? case_result.status === "passed" && viewer_state.kind === "matched"
            : case_result.status === "passed" &&
              displayed_series.length === input.validation_case.observations.length &&
              displayed_series.every(({ passed }) => passed)
          : undefined,
    is_stale: false,
    updated_at: input.updated_at,
  }
}
