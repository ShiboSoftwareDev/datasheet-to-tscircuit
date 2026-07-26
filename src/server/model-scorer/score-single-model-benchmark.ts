import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ModelValidationBenchmark, ModelValidationSeries } from "@/shared/job-types"
import {
  type BenchmarkDefinition,
  type BenchmarkManifest,
  type BenchmarkSeriesDefinition,
  type Point,
  parseBenchmarkManifest,
  resolveWorkspaceFile,
  type ScoreBenchmarkOptions,
} from "./parse-benchmark-manifest"
import type { DocumentedStimulusRange } from "./documented-stimulus-range"
import { findDocumentedStimulusRange } from "./documented-stimulus-range"

export async function readCsvPoints(file_path: string): Promise<Point[]> {
  const text = await readFile(file_path, "utf8")
  const points: Point[] = []
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const columns = trimmed.split(/[,\t]/).map((column) => column.trim())
    if (columns.length < 2) throw new Error(`${file_path}:${index + 1} must contain x,y values`)
    const x = Number(columns[0])
    const y = Number(columns[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      if (points.length === 0) continue
      throw new Error(`${file_path}:${index + 1} contains a non-numeric x or y value`)
    }
    points.push({ x, y })
  }
  if (points.length < 2) throw new Error(`${file_path} must contain at least two numeric points`)
  points.sort((first, second) => first.x - second.x)
  for (let index = 1; index < points.length; index += 1) {
    if (points[index]!.x === points[index - 1]!.x) {
      throw new Error(`${file_path} contains duplicate x=${points[index]!.x}`)
    }
  }
  return points
}

export function transform(input: { value: number; scale: "linear" | "log"; label: string }): number {
  const { value, scale, label } = input
  if (scale === "linear") return value
  if (value <= 0) throw new Error(`${label} must be positive when using a logarithmic scale`)
  return Math.log10(value)
}

function boundaryTolerance(first: number, second: number): number {
  return Number.EPSILON * 64 * Math.max(1, Math.abs(first), Math.abs(second))
}

const MAX_NEGATIVE_REFERENCE_TIME_FRACTION = 0.01

export function getReferenceTimeAxisError(points: Point[], label = "reference x"): string | undefined {
  if (points.length === 0) return undefined
  const minimum_x = Math.min(...points.map((point) => point.x))
  if (minimum_x >= 0) return undefined
  const maximum_x = Math.max(...points.map((point) => point.x))
  const span = maximum_x - minimum_x
  const tolerated_edge_noise =
    span * MAX_NEGATIVE_REFERENCE_TIME_FRACTION + boundaryTolerance(minimum_x, maximum_x)
  if (maximum_x >= 0 && span > 0 && -minimum_x <= tolerated_edge_noise) return undefined
  return `${label} must be non-negative elapsed time in milliseconds; minimum x=${minimum_x} exceeds the 1% trace-span edge tolerance`
}

export function normalizeReferenceTimePoints(points: Point[]): Point[] {
  return points.some((point) => point.x < 0)
    ? points.map((point) => (point.x < 0 ? { ...point, x: 0 } : point))
    : points
}

export function getBenchmarkRangeCoverageError(input: {
  reference_points: Point[]
  result_points: Point[]
  x_scale?: "linear" | "log"
}): string | undefined {
  const { result_points } = input
  const x_scale = input.x_scale ?? "linear"
  const time_axis_error = getReferenceTimeAxisError(input.reference_points)
  if (time_axis_error) return time_axis_error
  const reference_points =
    x_scale === "linear" ? normalizeReferenceTimePoints(input.reference_points) : input.reference_points
  if (reference_points.length < 2 || result_points.length < 2) {
    return "reference and simulated results must each contain at least two points"
  }
  const reference_first = Math.min(...reference_points.map((point) => point.x))
  const reference_last = Math.max(...reference_points.map((point) => point.x))
  const result_first = Math.min(...result_points.map((point) => point.x))
  const result_last = Math.max(...result_points.map((point) => point.x))
  const transformed_reference_first = transform({
    value: reference_first,
    scale: x_scale,
    label: "reference x",
  })
  const transformed_reference_last = transform({
    value: reference_last,
    scale: x_scale,
    label: "reference x",
  })
  const transformed_result_first = transform({ value: result_first, scale: x_scale, label: "result x" })
  const transformed_result_last = transform({ value: result_last, scale: x_scale, label: "result x" })
  if (
    transformed_reference_first <
    transformed_result_first - boundaryTolerance(transformed_reference_first, transformed_result_first)
  ) {
    return `simulation starts at x=${result_first} but the reference starts at x=${reference_first}`
  }
  if (
    transformed_reference_last >
    transformed_result_last + boundaryTolerance(transformed_reference_last, transformed_result_last)
  ) {
    return `simulation ends at x=${result_last} but the reference requires x=${reference_last}`
  }
  return undefined
}

/**
 * Removes only the convention-dependent sample immediately before a truly
 * discontinuous stimulus edge. Multi-point measured rise/fall shapes remain
 * intact and must be reproduced by the benchmark harness.
 */
export function removeAmbiguousStimulusEdgePoints(reference_points: Point[]): Point[] {
  if (reference_points.length < 3) return reference_points
  const x_values = reference_points.map((point) => point.x)
  const y_values = reference_points.map((point) => point.y)
  const x_span = Math.max(...x_values) - Math.min(...x_values)
  const y_span = Math.max(...y_values) - Math.min(...y_values)
  if (!(x_span > 0) || !(y_span > 0)) return reference_points
  return reference_points.filter((point, index) => {
    const next = reference_points[index + 1]
    if (!next) return true
    const is_ideal_discontinuity =
      next.x - point.x <= x_span * 0.02 && Math.abs(next.y - point.y) >= y_span * 0.8
    return !is_ideal_discontinuity
  })
}

function interpolate(input: { points: Point[]; x: number; x_scale: "linear" | "log" }): number {
  const { points, x, x_scale } = input
  const transformed_x = transform({ value: x, scale: x_scale, label: "x" })
  const first_x = transform({ value: points[0]!.x, scale: x_scale, label: "result x" })
  const last_x = transform({ value: points.at(-1)!.x, scale: x_scale, label: "result x" })
  if (
    transformed_x < first_x - boundaryTolerance(transformed_x, first_x) ||
    transformed_x > last_x + boundaryTolerance(transformed_x, last_x)
  ) {
    throw new Error(`Reference x=${x} is outside the simulated result range`)
  }
  const bounded_x = Math.max(first_x, Math.min(last_x, transformed_x))
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index]!
    const right_x = transform({ value: right.x, scale: x_scale, label: "result x" })
    if (right_x < bounded_x) continue
    const left = points[index - 1]!
    const left_x = transform({ value: left.x, scale: x_scale, label: "result x" })
    if (right_x === left_x) return right.y
    const ratio = (bounded_x - left_x) / (right_x - left_x)
    return left.y + ratio * (right.y - left.y)
  }
  return points.at(-1)!.y
}

interface StimulusPhase {
  state: "low" | "high"
  start_x: number
  end_x: number
}

function isStepLikeStimulus(points: Point[], levels: { low: number; high: number }): boolean {
  const span = levels.high - levels.low
  if (!(span > 0)) return false
  const stable_points = points.filter(
    (point) => Math.min(Math.abs(point.y - levels.low), Math.abs(point.y - levels.high)) <= span * 0.2,
  )
  return stable_points.length / points.length >= 0.65
}

function inferTwoLevels(points: Point[]): { low: number; high: number } | undefined {
  const values = points.map((point) => point.y)
  let low = Math.min(...values)
  let high = Math.max(...values)
  if (!(high > low)) return undefined
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const midpoint = low + (high - low) / 2
    const low_values = values.filter((value) => value < midpoint)
    const high_values = values.filter((value) => value >= midpoint)
    if (low_values.length === 0 || high_values.length === 0) return undefined
    low = low_values.reduce((total, value) => total + value, 0) / low_values.length
    high = high_values.reduce((total, value) => total + value, 0) / high_values.length
  }
  return high > low ? { low, high } : undefined
}

function medianPointSpacing(points: Point[]): number {
  const spacings = points
    .slice(1)
    .map((point, index) => point.x - points[index]!.x)
    .filter((spacing) => spacing > 0)
    .sort((first, second) => first - second)
  return spacings[Math.floor(spacings.length / 2)] ?? 0
}

function getStableStimulusPhases(
  points: Point[],
  levels: { low: number; high: number },
  maximum_glitch_duration: number,
): StimulusPhase[] {
  const midpoint = levels.low + (levels.high - levels.low) / 2
  const stateAt = (point: Point): StimulusPhase["state"] => (point.y >= midpoint ? "high" : "low")
  const phases: StimulusPhase[] = []
  let state = stateAt(points[0]!)
  let start_x = points[0]!.x
  for (let index = 1; index < points.length; index += 1) {
    const next_state = stateAt(points[index]!)
    if (next_state === state) continue
    phases.push({ state, start_x, end_x: points[index]!.x })
    state = next_state
    start_x = points[index]!.x
  }
  phases.push({ state, start_x, end_x: points.at(-1)!.x })

  let changed = true
  while (changed && phases.length > 1) {
    changed = false
    const first = phases[0]!
    if (first.end_x - first.start_x <= maximum_glitch_duration) {
      phases[1]!.start_x = first.start_x
      phases.shift()
      changed = true
      continue
    }
    const last = phases.at(-1)!
    if (last.end_x - last.start_x <= maximum_glitch_duration) {
      phases.at(-2)!.end_x = last.end_x
      phases.pop()
      changed = true
      continue
    }
    for (let index = 1; index < phases.length - 1; index += 1) {
      const phase = phases[index]!
      const previous = phases[index - 1]!
      const next = phases[index + 1]!
      if (phase.end_x - phase.start_x <= maximum_glitch_duration && previous.state === next.state) {
        previous.end_x = next.end_x
        phases.splice(index, 2)
        changed = true
        break
      }
    }
  }
  return phases
}

function summarizeStableStimulusPhases(phases: StimulusPhase[]): string {
  const first = phases[0]
  if (!first) return "empty"
  return [
    `starts ${first.state}`,
    ...phases
      .slice(1)
      .map((phase) => `${phase.state === "high" ? "low→high" : "high→low"} at x≈${phase.start_x}`),
  ].join(", ")
}

function clipPointsToReferenceRange(input: {
  points: Point[]
  first_x: number
  last_x: number
  x_scale: "linear" | "log"
}): Point[] {
  return [
    {
      x: input.first_x,
      y: interpolate({ points: input.points, x: input.first_x, x_scale: input.x_scale }),
    },
    ...input.points.filter((point) => point.x > input.first_x && point.x < input.last_x),
    {
      x: input.last_x,
      y: interpolate({ points: input.points, x: input.last_x, x_scale: input.x_scale }),
    },
  ]
}

function scoreStepStimulus(input: {
  series: Pick<
    BenchmarkSeriesDefinition,
    "id" | "title" | "role" | "unit" | "tolerance" | "max_error_tolerance"
  >
  reference_points: Point[]
  result_points: Point[]
  x_scale: "linear" | "log"
  documented_range?: DocumentedStimulusRange
}): ModelValidationSeries | undefined {
  if (input.x_scale !== "linear") return undefined
  const first_x = input.reference_points[0]!.x
  const last_x = input.reference_points.at(-1)!.x
  const x_span = last_x - first_x
  if (!(x_span > 0)) return undefined
  const result_points = clipPointsToReferenceRange({
    points: input.result_points,
    first_x,
    last_x,
    x_scale: input.x_scale,
  })
  const reference_levels = input.documented_range ?? inferTwoLevels(input.reference_points)
  const result_levels = inferTwoLevels(result_points)
  if (
    !reference_levels ||
    !result_levels ||
    !(reference_levels.high > reference_levels.low) ||
    !isStepLikeStimulus(input.reference_points, reference_levels)
  ) {
    return undefined
  }
  const y_span = reference_levels.high - reference_levels.low
  const maximum_glitch_duration = Math.max(x_span * 0.05, medianPointSpacing(input.reference_points) * 1.5)
  const reference_phases = getStableStimulusPhases(
    input.reference_points,
    reference_levels,
    maximum_glitch_duration,
  )
  const result_phases = getStableStimulusPhases(result_points, reference_levels, maximum_glitch_duration)
  const base = {
    series_id: input.series.id,
    title: input.series.title,
    role: input.series.role,
    unit: input.series.unit,
    tolerance: input.series.tolerance,
  }
  const reference_sequence = reference_phases.map((phase) => phase.state).join("→")
  const result_sequence = result_phases.map((phase) => phase.state).join("→")
  if (reference_sequence !== result_sequence) {
    return {
      ...base,
      normalized_rmse: 1,
      normalized_max_error: 1,
      passed: false,
      error_message: `stable stimulus phase sequence is ${result_sequence || "empty"}, expected ${
        reference_sequence || "empty"
      }; expected stable transitions: ${summarizeStableStimulusPhases(
        reference_phases,
      )}; simulated stable transitions: ${summarizeStableStimulusPhases(result_phases)}`,
    }
  }

  const level_errors = [
    Math.abs(result_levels.low - reference_levels.low) / y_span,
    Math.abs(result_levels.high - reference_levels.high) / y_span,
  ]
  const reference_transitions = reference_phases.slice(1)
  const result_transitions = result_phases.slice(1)
  const timing_errors = reference_transitions.map(
    (transition, index) => Math.abs(result_transitions[index]!.start_x - transition.start_x) / x_span,
  )
  const normalized_errors = [...level_errors, ...timing_errors]
  const normalized_rmse = Math.sqrt(
    normalized_errors.reduce((total, error) => total + error * error, 0) / normalized_errors.length,
  )
  const normalized_max_error = Math.max(...normalized_errors)
  const level_rmse = Math.sqrt(
    level_errors.reduce((total, error) => total + error * error, 0) / level_errors.length,
  )
  const level_max_error = Math.max(...level_errors)
  const level_tolerance = Math.max(input.series.tolerance, 0.05)
  const level_max_tolerance = input.series.max_error_tolerance ?? Math.max(level_tolerance * 2, 0.1)
  const timing_tolerance = Math.min(
    0.05,
    Math.max(0.01, (medianPointSpacing(input.reference_points) * 1.5) / x_span),
  )
  const timing_error = Math.max(0, ...timing_errors)
  const passed =
    level_rmse <= level_tolerance &&
    level_max_error <= level_max_tolerance &&
    timing_error <= timing_tolerance
  return {
    ...base,
    normalized_rmse,
    normalized_max_error,
    passed,
    ...(!passed
      ? {
          error_message:
            level_rmse > level_tolerance || level_max_error > level_max_tolerance
              ? `stable stimulus levels are ${result_levels.low}..${result_levels.high} ${input.series.unit}, expected ${reference_levels.low}..${reference_levels.high} ${input.series.unit}`
              : `stimulus transition timing differs by ${(timing_error * 100).toFixed(
                  2,
                )}% of the plotted time span; allowed ${(timing_tolerance * 100).toFixed(
                  2,
                )}%; expected stable transitions: ${summarizeStableStimulusPhases(
                  reference_phases,
                )}; simulated stable transitions: ${summarizeStableStimulusPhases(result_phases)}`,
        }
      : {}),
  }
}

export function scoreSeriesPoints(input: {
  series: Pick<
    BenchmarkSeriesDefinition,
    "id" | "title" | "role" | "unit" | "tolerance" | "max_error_tolerance" | "y_scale"
  >
  reference_points: Point[]
  result_points: Point[]
  x_scale?: "linear" | "log"
  documented_stimulus_range?: DocumentedStimulusRange
}): ModelValidationSeries {
  const { series, reference_points, result_points } = input
  try {
    const x_scale = input.x_scale ?? "linear"
    const y_scale = series.y_scale ?? "linear"
    const range_coverage_error = getBenchmarkRangeCoverageError({ reference_points, result_points, x_scale })
    if (range_coverage_error) throw new Error(range_coverage_error)
    const elapsed_reference_points =
      x_scale === "linear" ? normalizeReferenceTimePoints(reference_points) : reference_points
    if (series.role === "stimulus") {
      const stimulus_score = scoreStepStimulus({
        series,
        reference_points: elapsed_reference_points,
        result_points,
        x_scale,
        documented_range: input.documented_stimulus_range,
      })
      if (stimulus_score) return stimulus_score
    }
    const scoring_reference_points =
      series.role === "stimulus"
        ? removeAmbiguousStimulusEdgePoints(elapsed_reference_points)
        : elapsed_reference_points
    const target_values = scoring_reference_points.map((point) =>
      transform({ value: point.y, scale: y_scale, label: "reference y" }),
    )
    const target_min = Math.min(...target_values)
    const target_max = Math.max(...target_values)
    const target_abs_max = Math.max(...target_values.map(Math.abs))
    const normalization_span = Math.max(target_max - target_min, target_abs_max * 0.05, 1e-12)
    const normalized_errors = scoring_reference_points.map((reference_point) => {
      const simulated_y = interpolate({ points: result_points, x: reference_point.x, x_scale })
      const transformed_simulated_y = transform({ value: simulated_y, scale: y_scale, label: "simulated y" })
      const transformed_reference_y = transform({
        value: reference_point.y,
        scale: y_scale,
        label: "reference y",
      })
      return Math.abs(transformed_simulated_y - transformed_reference_y) / normalization_span
    })
    const normalized_rmse = Math.sqrt(
      normalized_errors.reduce((total, error) => total + error * error, 0) / normalized_errors.length,
    )
    const normalized_max_error = Math.max(...normalized_errors)
    const max_error_tolerance = series.max_error_tolerance ?? series.tolerance * 2
    return {
      series_id: series.id,
      title: series.title,
      role: series.role,
      unit: series.unit,
      tolerance: series.tolerance,
      normalized_rmse,
      normalized_max_error,
      passed: normalized_rmse <= series.tolerance && normalized_max_error <= max_error_tolerance,
    }
  } catch (error) {
    return {
      series_id: series.id,
      title: series.title,
      role: series.role,
      unit: series.unit,
      tolerance: series.tolerance,
      passed: false,
      error_message: error instanceof Error ? error.message : String(error),
    }
  }
}

export function resolveSeriesResultFile(input: {
  model_dir: string
  benchmark: BenchmarkDefinition
  series: BenchmarkSeriesDefinition
  options?: ScoreBenchmarkOptions
}): string {
  const { model_dir, benchmark, series } = input
  const options = input.options ?? {}
  const explicit = options.result_files_override?.[series.id]
  if (explicit) return explicit
  const primary = benchmark.series.find((candidate) => candidate.role === "response")
  if (options.result_file_override && primary?.id === series.id) return options.result_file_override
  if (options.results_directory_override) {
    const is_legacy = benchmark.series.length === 1 && series.id === "result"
    return is_legacy
      ? join(options.results_directory_override, `${benchmark.id}.csv`)
      : join(options.results_directory_override, benchmark.id, `${series.id}.csv`)
  }
  return resolveWorkspaceFile(model_dir, series.result_file)
}

export async function scoreBenchmark(input: {
  model_dir: string
  benchmark: BenchmarkDefinition
  options?: ScoreBenchmarkOptions
}): Promise<ModelValidationBenchmark> {
  const { model_dir, benchmark } = input
  const series_results = await Promise.all(
    benchmark.series.map(async (series) => {
      try {
        const [reference_points, result_points] = await Promise.all([
          readCsvPoints(resolveWorkspaceFile(model_dir, series.reference_file)),
          readCsvPoints(resolveSeriesResultFile({ model_dir, benchmark, series, options: input.options })),
        ])
        return scoreSeriesPoints({
          series,
          reference_points,
          result_points,
          x_scale: benchmark.x_scale,
          documented_stimulus_range:
            series.role === "stimulus" && benchmark.conditions
              ? findDocumentedStimulusRange({
                  conditions: benchmark.conditions,
                  title: series.title,
                  series_id: series.id,
                  series_unit: series.unit,
                })
              : undefined,
        })
      } catch (error) {
        return {
          series_id: series.id,
          title: series.title,
          role: series.role,
          unit: series.unit,
          tolerance: series.tolerance,
          passed: false,
          error_message: error instanceof Error ? error.message : String(error),
        } satisfies ModelValidationSeries
      }
    }),
  )
  const response_results = series_results.filter((series) => series.role === "response")
  let total_weight = 0
  let weighted_error = 0
  for (const result of response_results) {
    const definition = benchmark.series.find((series) => series.id === result.series_id)!
    if (result.normalized_rmse === undefined) continue
    total_weight += definition.weight
    weighted_error += result.normalized_rmse * definition.weight
  }
  const normalized_values = series_results.flatMap((series) =>
    series.normalized_max_error === undefined ? [] : [series.normalized_max_error],
  )
  const failures = series_results.filter((series) => !series.passed)
  return {
    benchmark_id: benchmark.id,
    title: benchmark.title,
    critical: benchmark.critical,
    tolerance: benchmark.tolerance,
    normalized_rmse: total_weight > 0 ? weighted_error / total_weight : undefined,
    normalized_max_error: normalized_values.length > 0 ? Math.max(...normalized_values) : undefined,
    passed: failures.length === 0,
    ...(failures.some((series) => series.error_message)
      ? {
          error_message: failures
            .map((series) => `${series.title}: ${series.error_message ?? "outside tolerance"}`)
            .join("; "),
        }
      : {}),
    series: series_results,
  }
}

export async function readBenchmarkManifest(model_dir: string): Promise<BenchmarkManifest> {
  const manifest_value: unknown = JSON.parse(await readFile(join(model_dir, "benchmarks.json"), "utf8"))
  return parseBenchmarkManifest(manifest_value)
}

export function requireBenchmark(manifest: BenchmarkManifest, benchmark_id: string): BenchmarkDefinition {
  const benchmark = manifest.benchmarks.find((candidate) => candidate.id === benchmark_id)
  if (!benchmark) throw new Error(`Benchmark ${benchmark_id} was not found in benchmarks.json`)
  return benchmark
}

export async function scoreSingleModelBenchmark(input: {
  model_dir: string
  benchmark_id: string
  result_file_override?: string
  result_files_override?: Record<string, string>
}): Promise<ModelValidationBenchmark> {
  const { model_dir, benchmark_id, result_file_override, result_files_override } = input
  const manifest = await readBenchmarkManifest(model_dir)
  return scoreBenchmark({
    model_dir,
    benchmark: requireBenchmark(manifest, benchmark_id),
    options: { result_file_override, result_files_override },
  })
}
