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

export function getBenchmarkRangeCoverageError(input: {
  reference_points: Point[]
  result_points: Point[]
  x_scale?: "linear" | "log"
}): string | undefined {
  const { reference_points, result_points } = input
  const x_scale = input.x_scale ?? "linear"
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

export function scoreSeriesPoints(input: {
  series: BenchmarkSeriesDefinition
  reference_points: Point[]
  result_points: Point[]
  x_scale?: "linear" | "log"
}): ModelValidationSeries {
  const { series, reference_points, result_points } = input
  try {
    const x_scale = input.x_scale ?? "linear"
    const y_scale = series.y_scale ?? "linear"
    const range_coverage_error = getBenchmarkRangeCoverageError({ reference_points, result_points, x_scale })
    if (range_coverage_error) throw new Error(range_coverage_error)
    const target_values = reference_points.map((point) =>
      transform({ value: point.y, scale: y_scale, label: "reference y" }),
    )
    const target_min = Math.min(...target_values)
    const target_max = Math.max(...target_values)
    const target_abs_max = Math.max(...target_values.map(Math.abs))
    const normalization_span = Math.max(target_max - target_min, target_abs_max * 0.05, 1e-12)
    const normalized_errors = reference_points.map((reference_point) => {
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
        return scoreSeriesPoints({ series, reference_points, result_points, x_scale: benchmark.x_scale })
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
