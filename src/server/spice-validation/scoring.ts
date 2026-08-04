import type {
  ObservationComparisonMetrics,
  ValidationExecutionError,
  ValidationObservation,
  ValidationSeriesPoint,
  ValidationSeriesResult,
} from "./types"

const NORMALIZATION_FLOOR = 1e-15

function logValue(value: number): number {
  return Math.log10(value)
}

function comparisonError(code: string, message: string): ValidationExecutionError {
  return { kind: "comparison", code, message }
}

function failureResult(
  observation: ValidationObservation,
  points: ValidationSeriesPoint[],
  code: string,
  message: string,
): ValidationSeriesResult {
  return {
    observation_id: observation.id,
    type: observation.type,
    unit: observation.unit,
    scale: observation.scale,
    points,
    passed: false,
    metrics: { sample_count: points.length },
    errors: [comparisonError(code, message)],
  }
}

function metricsFromErrors(errors: number[], normalization: number): ObservationComparisonMetrics {
  const squared_sum = errors.reduce((sum, error) => sum + error * error, 0)
  const max_absolute_error = errors.reduce((maximum, error) => Math.max(maximum, Math.abs(error)), 0)
  const denominator = Math.max(Math.abs(normalization), NORMALIZATION_FLOOR)
  return {
    sample_count: errors.length,
    normalized_rmse: Math.sqrt(squared_sum / errors.length) / denominator,
    normalized_max_error: max_absolute_error / denominator,
    max_absolute_error,
  }
}

function scoreTarget(
  observation: ValidationObservation,
  points: ValidationSeriesPoint[],
): ValidationSeriesResult {
  const reference = observation.reference
  if (reference.type !== "target") throw new Error("Target scorer received a non-target reference")
  const log_scale = observation.scale === "log"
  const errors = points.map((point) =>
    log_scale ? logValue(point.y) - logValue(reference.target) : point.y - reference.target,
  )
  const tolerance = log_scale
    ? Math.max(
        logValue((reference.target + reference.tolerance) / reference.target),
        reference.target > reference.tolerance
          ? logValue(reference.target / (reference.target - reference.tolerance))
          : 0,
      )
    : reference.tolerance
  const metrics = metricsFromErrors(errors, tolerance)
  const passed = points.every((point) => Math.abs(point.y - reference.target) <= reference.tolerance)
  return {
    observation_id: observation.id,
    type: observation.type,
    unit: observation.unit,
    scale: observation.scale,
    points,
    passed,
    metrics,
    errors: passed
      ? []
      : [
          comparisonError(
            "target_tolerance_exceeded",
            `At least one sample differs from target ${reference.target} by more than ${reference.tolerance}`,
          ),
        ],
  }
}

function scoreBounds(
  observation: ValidationObservation,
  points: ValidationSeriesPoint[],
): ValidationSeriesResult {
  const reference = observation.reference
  if (reference.type !== "bounds") throw new Error("Bounds scorer received a non-bounds reference")
  const log_scale = observation.scale === "log"
  const violations = points.map((point) => {
    if (reference.min !== undefined && point.y < reference.min) {
      return log_scale ? logValue(reference.min) - logValue(point.y) : reference.min - point.y
    }
    if (reference.max !== undefined && point.y > reference.max) {
      return log_scale ? logValue(point.y) - logValue(reference.max) : point.y - reference.max
    }
    return 0
  })
  const bound_values = [reference.min, reference.max].filter((value): value is number => value !== undefined)
  const span = reference.min !== undefined && reference.max !== undefined ? reference.max - reference.min : 0
  const normalization = log_scale
    ? reference.min !== undefined && reference.max !== undefined
      ? logValue(reference.max) - logValue(reference.min)
      : 1
    : Math.max(span, ...bound_values.map(Math.abs), NORMALIZATION_FLOOR)
  const metrics = metricsFromErrors(violations, normalization)
  const passed = violations.every((violation) => violation === 0)
  return {
    observation_id: observation.id,
    type: observation.type,
    unit: observation.unit,
    scale: observation.scale,
    points,
    passed,
    metrics,
    errors: passed
      ? []
      : [comparisonError("bounds_exceeded", "At least one sample lies outside the required bounds")],
  }
}

function interpolate(points: ValidationSeriesPoint[], x: number): number | undefined {
  const first = points[0]
  const last = points.at(-1)
  if (!first || !last) return undefined
  if (points.length === 1) return first.x === x ? first.y : undefined
  if (x < first.x || x > last.x) return undefined
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    if (!current) return undefined
    if (current.x === x) return current.y
    const next = points[index + 1]
    if (!next || x > next.x) continue
    const fraction = (x - current.x) / (next.x - current.x)
    return current.y + fraction * (next.y - current.y)
  }
  return undefined
}

function scoreCurve(
  observation: ValidationObservation,
  points: ValidationSeriesPoint[],
): ValidationSeriesResult {
  const reference = observation.reference
  if (reference.type !== "curve") throw new Error("Curve scorer received a non-curve reference")
  const ordered = points
    .map((point, index) => ({ point, index }))
    .sort((a, b) => a.point.x - b.point.x || a.index - b.index)
    .map(({ point }) => point)
  for (let index = 1; index < ordered.length; index += 1) {
    const current = ordered[index]
    const previous = ordered[index - 1]
    if (current && previous && current.x === previous.x) {
      return failureResult(
        observation,
        points,
        "duplicate_series_x",
        `Simulation produced duplicate x value ${current.x}`,
      )
    }
  }
  const scored_points =
    observation.scale === "log" ? ordered.map((point) => ({ x: point.x, y: logValue(point.y) })) : ordered
  const scored_reference = reference.points.map((point) => ({
    x: point.x,
    y: observation.scale === "log" ? logValue(point.y) : point.y,
  }))
  const sampled = scored_reference.map((reference_point) => ({
    reference_point,
    simulated_y: interpolate(scored_points, reference_point.x),
  }))
  const missing = sampled.find(({ simulated_y }) => simulated_y === undefined)
  if (missing) {
    return failureResult(
      observation,
      points,
      "curve_outside_simulation_range",
      `Reference x=${missing.reference_point.x} is outside the simulated range`,
    )
  }
  const errors = sampled.map(
    ({ reference_point, simulated_y }) => (simulated_y ?? Number.POSITIVE_INFINITY) - reference_point.y,
  )
  const reference_y = scored_reference.map((point) => point.y)
  const y_min = Math.min(...reference_y)
  const y_max = Math.max(...reference_y)
  const y_range = y_max - y_min
  const normalization =
    y_range > NORMALIZATION_FLOOR
      ? y_range
      : Math.max(...reference_y.map((value) => Math.abs(value)), NORMALIZATION_FLOOR)
  const metrics = metricsFromErrors(errors, normalization)
  const passed = (metrics.normalized_max_error ?? Number.POSITIVE_INFINITY) <= reference.tolerance
  return {
    observation_id: observation.id,
    type: observation.type,
    unit: observation.unit,
    scale: observation.scale,
    points,
    passed,
    metrics,
    errors: passed
      ? []
      : [
          comparisonError(
            "curve_tolerance_exceeded",
            `Normalized maximum error ${metrics.normalized_max_error} exceeds tolerance ${reference.tolerance}`,
          ),
        ],
  }
}

export function scoreObservation(
  observation: ValidationObservation,
  points: ValidationSeriesPoint[],
): ValidationSeriesResult {
  if (points.length === 0) {
    return failureResult(observation, points, "empty_series", "Simulation produced no samples")
  }
  if (points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return failureResult(observation, points, "non_finite_series", "Simulation produced a non-finite sample")
  }
  if (observation.scale === "log" && points.some((point) => point.y <= 0)) {
    return failureResult(
      observation,
      points,
      "invalid_log_sample",
      "Log-scale observations require positive simulation samples",
    )
  }
  if (
    observation.scale === "log" &&
    ((observation.reference.type === "target" && observation.reference.target <= 0) ||
      (observation.reference.type === "bounds" &&
        ((observation.reference.min !== undefined && observation.reference.min <= 0) ||
          (observation.reference.max !== undefined && observation.reference.max <= 0))) ||
      (observation.reference.type === "curve" && observation.reference.points.some((point) => point.y <= 0)))
  ) {
    return failureResult(
      observation,
      points,
      "invalid_log_reference",
      "Log-scale observations require positive reference values",
    )
  }
  switch (observation.reference.type) {
    case "target":
      return scoreTarget(observation, points)
    case "bounds":
      return scoreBounds(observation, points)
    case "curve":
      return scoreCurve(observation, points)
  }
}
