import { readFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import type { ModelValidationBenchmark, ModelValidationSummary } from "@/shared/job-types"

interface Point {
  x: number
  y: number
}

interface ScoreBenchmarkOptions {
  results_directory_override?: string
  result_file_override?: string
}

export interface BenchmarkDefinition {
  id: string
  title: string
  source: {
    page: number
    figure?: string
  }
  critical: boolean
  weight: number
  tolerance: number
  max_error_tolerance?: number
  x_scale?: "linear" | "log"
  y_scale?: "linear" | "log"
  reference_file: string
  result_file: string
  simulation: {
    kind: "transient_voltage"
    x_axis: "time_ms"
    probe_name: string
    dut_spice_node: string
    scale?: number
    offset?: number
  }
}

export interface BenchmarkManifest {
  version: 1
  locked_at: string
  benchmarks: BenchmarkDefinition[]
}

export interface ModelValidationReport extends ModelValidationSummary {
  version: 1
  generated_at: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseBenchmarkManifest(value: unknown): BenchmarkManifest {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.locked_at !== "string" ||
    !value.locked_at.trim() ||
    !Number.isFinite(new Date(value.locked_at).valueOf())
  ) {
    throw new Error("benchmarks.json must contain a version 1 locked benchmark manifest")
  }
  if (!Array.isArray(value.benchmarks) || value.benchmarks.length === 0) {
    throw new Error("benchmarks.json must contain at least one benchmark")
  }

  const benchmarks = value.benchmarks.map((entry, index): BenchmarkDefinition => {
    if (!isRecord(entry)) throw new Error(`Benchmark ${index + 1} must be an object`)
    const source = entry.source
    if (
      !isRecord(source) ||
      typeof source.page !== "number" ||
      !Number.isInteger(source.page) ||
      source.page < 1
    ) {
      throw new Error(`Benchmark ${index + 1} must cite a datasheet page`)
    }
    const required_strings = ["id", "title", "reference_file", "result_file"] as const
    for (const key of required_strings) {
      if (typeof entry[key] !== "string" || entry[key].trim() === "") {
        throw new Error(`Benchmark ${index + 1} has no ${key}`)
      }
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.id as string)) {
      throw new Error(`Benchmark ${index + 1} has an invalid id`)
    }
    const reference_file = entry.reference_file as string
    if (
      !reference_file.startsWith("evidence/") ||
      reference_file.includes("\\") ||
      reference_file.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error(`Benchmark ${String(entry.id)} reference_file must stay under evidence/`)
    }
    if (entry.result_file !== `results/champion/${entry.id}.csv`) {
      throw new Error(
        `Benchmark ${String(entry.id)} result_file must be results/champion/${String(entry.id)}.csv`,
      )
    }
    if (typeof entry.critical !== "boolean") {
      throw new Error(`Benchmark ${String(entry.id)} must declare whether it is critical`)
    }
    if (typeof entry.weight !== "number" || !Number.isFinite(entry.weight) || entry.weight <= 0) {
      throw new Error(`Benchmark ${String(entry.id)} has an invalid weight`)
    }
    if (typeof entry.tolerance !== "number" || !Number.isFinite(entry.tolerance) || entry.tolerance <= 0) {
      throw new Error(`Benchmark ${String(entry.id)} has an invalid tolerance`)
    }
    if (
      entry.max_error_tolerance !== undefined &&
      (typeof entry.max_error_tolerance !== "number" ||
        !Number.isFinite(entry.max_error_tolerance) ||
        entry.max_error_tolerance <= 0)
    ) {
      throw new Error(`Benchmark ${String(entry.id)} has an invalid max-error tolerance`)
    }
    if (entry.x_scale !== undefined && entry.x_scale !== "linear" && entry.x_scale !== "log") {
      throw new Error(`Benchmark ${String(entry.id)} has an invalid x scale`)
    }
    if (entry.x_scale === "log") {
      throw new Error(`Benchmark ${String(entry.id)} must use a linear elapsed-time x axis`)
    }
    if (entry.y_scale !== undefined && entry.y_scale !== "linear" && entry.y_scale !== "log") {
      throw new Error(`Benchmark ${String(entry.id)} has an invalid y scale`)
    }
    if (
      !isRecord(entry.simulation) ||
      entry.simulation.kind !== "transient_voltage" ||
      entry.simulation.x_axis !== "time_ms" ||
      typeof entry.simulation.probe_name !== "string" ||
      !entry.simulation.probe_name.trim() ||
      typeof entry.simulation.dut_spice_node !== "string" ||
      !entry.simulation.dut_spice_node.trim()
    ) {
      throw new Error(
        `Benchmark ${String(entry.id)} must define one transient_voltage simulation with x_axis "time_ms"`,
      )
    }
    for (const key of ["scale", "offset"] as const) {
      const number = entry.simulation[key]
      if (number !== undefined && (typeof number !== "number" || !Number.isFinite(number))) {
        throw new Error(`Benchmark ${String(entry.id)} simulation.${key} must be finite`)
      }
    }

    return {
      id: entry.id as string,
      title: entry.title as string,
      source: {
        page: source.page,
        figure: typeof source.figure === "string" ? source.figure : undefined,
      },
      critical: entry.critical,
      weight: entry.weight,
      tolerance: entry.tolerance,
      max_error_tolerance:
        typeof entry.max_error_tolerance === "number" ? entry.max_error_tolerance : undefined,
      x_scale: entry.x_scale as "linear" | "log" | undefined,
      y_scale: entry.y_scale as "linear" | "log" | undefined,
      reference_file,
      result_file: entry.result_file as string,
      simulation: {
        kind: "transient_voltage",
        x_axis: "time_ms",
        probe_name: entry.simulation.probe_name.trim(),
        dut_spice_node: entry.simulation.dut_spice_node.trim(),
        scale: typeof entry.simulation.scale === "number" ? entry.simulation.scale : undefined,
        offset: typeof entry.simulation.offset === "number" ? entry.simulation.offset : undefined,
      },
    }
  })

  if (new Set(benchmarks.map((benchmark) => benchmark.id)).size !== benchmarks.length) {
    throw new Error("Benchmark ids must be unique")
  }
  return { version: 1, locked_at: value.locked_at, benchmarks }
}

function resolveWorkspaceFile(model_dir: string, file_path: string): string {
  const resolved_root = resolve(model_dir)
  const resolved_file = resolve(resolved_root, file_path)
  if (!resolved_file.startsWith(`${resolved_root}${sep}`)) {
    throw new Error(`Benchmark file escapes the model workspace: ${file_path}`)
  }
  return resolved_file
}

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

function transform(value: number, scale: "linear" | "log", label: string): number {
  if (scale === "linear") return value
  if (value <= 0) throw new Error(`${label} must be positive when using a logarithmic scale`)
  return Math.log10(value)
}

function interpolate(points: Point[], x: number, x_scale: "linear" | "log"): number {
  const transformed_x = transform(x, x_scale, "x")
  const first_x = transform(points[0]!.x, x_scale, "result x")
  const last_x = transform(points.at(-1)!.x, x_scale, "result x")
  if (transformed_x < first_x || transformed_x > last_x) {
    throw new Error(`Reference x=${x} is outside the simulated result range`)
  }

  for (let index = 1; index < points.length; index += 1) {
    const right = points[index]!
    const right_x = transform(right.x, x_scale, "result x")
    if (right_x < transformed_x) continue
    const left = points[index - 1]!
    const left_x = transform(left.x, x_scale, "result x")
    if (right_x === left_x) return right.y
    const ratio = (transformed_x - left_x) / (right_x - left_x)
    return left.y + ratio * (right.y - left.y)
  }
  return points.at(-1)!.y
}

async function scoreBenchmark(
  model_dir: string,
  benchmark: BenchmarkDefinition,
  options: ScoreBenchmarkOptions = {},
): Promise<ModelValidationBenchmark> {
  try {
    const reference_points = await readCsvPoints(resolveWorkspaceFile(model_dir, benchmark.reference_file))
    const result_file =
      options.result_file_override ??
      (options.results_directory_override
        ? join(options.results_directory_override, `${benchmark.id}.csv`)
        : resolveWorkspaceFile(model_dir, benchmark.result_file))
    const result_points = await readCsvPoints(result_file)
    const x_scale = benchmark.x_scale ?? "linear"
    const y_scale = benchmark.y_scale ?? "linear"
    const target_values = reference_points.map((point) => transform(point.y, y_scale, "reference y"))
    const target_min = Math.min(...target_values)
    const target_max = Math.max(...target_values)
    const target_abs_max = Math.max(...target_values.map(Math.abs))
    const normalization_span = Math.max(target_max - target_min, target_abs_max * 0.05, 1e-12)
    const normalized_errors = reference_points.map((reference_point) => {
      const simulated_y = interpolate(result_points, reference_point.x, x_scale)
      const transformed_simulated_y = transform(simulated_y, y_scale, "simulated y")
      const transformed_reference_y = transform(reference_point.y, y_scale, "reference y")
      return Math.abs(transformed_simulated_y - transformed_reference_y) / normalization_span
    })
    const normalized_rmse = Math.sqrt(
      normalized_errors.reduce((total, error) => total + error * error, 0) / normalized_errors.length,
    )
    const normalized_max_error = Math.max(...normalized_errors)
    const max_error_tolerance = benchmark.max_error_tolerance ?? benchmark.tolerance * 2
    return {
      benchmark_id: benchmark.id,
      title: benchmark.title,
      critical: benchmark.critical,
      tolerance: benchmark.tolerance,
      normalized_rmse,
      normalized_max_error,
      passed: normalized_rmse <= benchmark.tolerance && normalized_max_error <= max_error_tolerance,
    }
  } catch (error) {
    return {
      benchmark_id: benchmark.id,
      title: benchmark.title,
      critical: benchmark.critical,
      tolerance: benchmark.tolerance,
      passed: false,
      error_message: error instanceof Error ? error.message : String(error),
    }
  }
}

async function readBenchmarkManifest(model_dir: string): Promise<BenchmarkManifest> {
  const manifest_value: unknown = JSON.parse(await readFile(join(model_dir, "benchmarks.json"), "utf8"))
  return parseBenchmarkManifest(manifest_value)
}

function requireBenchmark(manifest: BenchmarkManifest, benchmark_id: string): BenchmarkDefinition {
  const benchmark = manifest.benchmarks.find((candidate) => candidate.id === benchmark_id)
  if (!benchmark) throw new Error(`Benchmark ${benchmark_id} was not found in benchmarks.json`)
  return benchmark
}

export async function scoreSingleModelBenchmark(
  model_dir: string,
  benchmark_id: string,
  options: { result_file_override?: string } = {},
): Promise<ModelValidationBenchmark> {
  const manifest = await readBenchmarkManifest(model_dir)
  return scoreBenchmark(model_dir, requireBenchmark(manifest, benchmark_id), options)
}

function escapeSvgText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function downsamplePoints(points: Point[], maximum = 1_200): Point[] {
  if (points.length <= maximum) return points
  const stride = Math.ceil(points.length / maximum)
  return points.filter((_, index) => index % stride === 0 || index === points.length - 1)
}

function formatAxisValue(value: number): string {
  const absolute = Math.abs(value)
  if ((absolute > 0 && absolute < 0.001) || absolute >= 10_000) return value.toExponential(2)
  return Number(value.toPrecision(4)).toString()
}

export async function renderModelBenchmarkComparisonSvg(
  model_dir: string,
  benchmark_id: string,
  options: { result_file_override?: string } = {},
): Promise<string> {
  const manifest = await readBenchmarkManifest(model_dir)
  const benchmark = requireBenchmark(manifest, benchmark_id)
  const reference_points = await readCsvPoints(resolveWorkspaceFile(model_dir, benchmark.reference_file))
  const result_file = options.result_file_override ?? resolveWorkspaceFile(model_dir, benchmark.result_file)
  const result_points = await readCsvPoints(result_file)
  const score = await scoreBenchmark(model_dir, benchmark, { result_file_override: result_file })
  const x_scale = benchmark.x_scale ?? "linear"
  const y_scale = benchmark.y_scale ?? "linear"
  const transformed_reference = reference_points.map((point) => ({
    x: transform(point.x, x_scale, "reference x"),
    y: transform(point.y, y_scale, "reference y"),
  }))
  const transformed_result = result_points.map((point) => ({
    x: transform(point.x, x_scale, "result x"),
    y: transform(point.y, y_scale, "result y"),
  }))
  const all_points = [...transformed_reference, ...transformed_result]
  const raw_x_min = Math.min(...all_points.map((point) => point.x))
  const raw_x_max = Math.max(...all_points.map((point) => point.x))
  const raw_y_min = Math.min(...all_points.map((point) => point.y))
  const raw_y_max = Math.max(...all_points.map((point) => point.y))
  const x_span = Math.max(raw_x_max - raw_x_min, Math.max(Math.abs(raw_x_min), 1) * 1e-9)
  const y_span = Math.max(raw_y_max - raw_y_min, Math.max(Math.abs(raw_y_min), 1) * 1e-9)
  const x_min = raw_x_min
  const y_min = raw_y_min - y_span * 0.08
  const y_max = raw_y_max + y_span * 0.08
  const width = 1_200
  const height = 720
  const left = 92
  const right = 34
  const top = 92
  const bottom = 78
  const plot_width = width - left - right
  const plot_height = height - top - bottom
  const mapX = (value: number) => left + ((value - x_min) / x_span) * plot_width
  const mapY = (value: number) => top + (1 - (value - y_min) / (y_max - y_min)) * plot_height
  const makePath = (points: Point[]) =>
    downsamplePoints(points)
      .map(
        (point, index) => `${index === 0 ? "M" : "L"}${mapX(point.x).toFixed(2)},${mapY(point.y).toFixed(2)}`,
      )
      .join(" ")
  const reference_path = makePath(transformed_reference)
  const result_path = makePath(transformed_result)
  const ticks = Array.from({ length: 6 }, (_, index) => index / 5)
  const x_ticks = ticks
    .map((ratio) => {
      const value = x_min + ratio * x_span
      const label_value = x_scale === "log" ? 10 ** value : value
      const x = mapX(value)
      return `<line x1="${x}" y1="${top}" x2="${x}" y2="${top + plot_height}" class="grid"/><text x="${x}" y="${top + plot_height + 30}" text-anchor="middle" class="tick">${escapeSvgText(formatAxisValue(label_value))}</text>`
    })
    .join("")
  const y_ticks = ticks
    .map((ratio) => {
      const value = y_min + ratio * (y_max - y_min)
      const label_value = y_scale === "log" ? 10 ** value : value
      const y = mapY(value)
      return `<line x1="${left}" y1="${y}" x2="${left + plot_width}" y2="${y}" class="grid"/><text x="${left - 14}" y="${y + 5}" text-anchor="end" class="tick">${escapeSvgText(formatAxisValue(label_value))}</text>`
    })
    .join("")
  const metrics = score.error_message
    ? score.error_message
    : `NRMSE ${((score.normalized_rmse ?? 0) * 100).toFixed(2)}% · maximum ${((score.normalized_max_error ?? 0) * 100).toFixed(2)}% · ${score.passed ? "PASS" : "FAIL"}`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeSvgText(benchmark.title)} reference and simulation comparison">
  <style>
    text { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; fill: #262626; }
    .title { font-size: 25px; font-weight: 700; }
    .subtitle { font-size: 14px; fill: #525252; }
    .tick { font-size: 13px; fill: #525252; }
    .axis-label { font-size: 15px; font-weight: 600; }
    .grid { stroke: #e5e5e5; stroke-width: 1; }
    .axis { stroke: #737373; stroke-width: 1.5; fill: none; }
    .reference { stroke: #2563eb; stroke-width: 3; fill: none; }
    .result { stroke: #16a34a; stroke-width: 3; fill: none; }
    .legend { font-size: 14px; font-weight: 600; }
  </style>
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${left}" y="38" class="title">${escapeSvgText(benchmark.title)}</text>
  <text x="${left}" y="64" class="subtitle">${escapeSvgText(metrics)}</text>
  ${x_ticks}${y_ticks}
  <rect x="${left}" y="${top}" width="${plot_width}" height="${plot_height}" class="axis"/>
  <defs><clipPath id="plot"><rect x="${left}" y="${top}" width="${plot_width}" height="${plot_height}"/></clipPath></defs>
  <g clip-path="url(#plot)">
    <path d="${reference_path}" class="reference"/>
    <path d="${result_path}" class="result"/>
  </g>
  <line x1="${width - 300}" y1="42" x2="${width - 264}" y2="42" class="reference"/><text x="${width - 254}" y="47" class="legend">Datasheet reference</text>
  <line x1="${width - 300}" y1="66" x2="${width - 264}" y2="66" class="result"/><text x="${width - 254}" y="71" class="legend">Simulation result</text>
  <text x="${left + plot_width / 2}" y="${height - 23}" text-anchor="middle" class="axis-label">Time (ms)</text>
  <text x="24" y="${top + plot_height / 2}" text-anchor="middle" class="axis-label" transform="rotate(-90 24 ${top + plot_height / 2})">Output${y_scale === "log" ? " (log scale)" : ""}</text>
</svg>\n`
}

export async function validateBenchmarkReferenceFiles(
  model_dir: string,
  manifest: BenchmarkManifest,
): Promise<void> {
  await Promise.all(
    manifest.benchmarks.map(async (benchmark) => {
      const points = await readCsvPoints(resolveWorkspaceFile(model_dir, benchmark.reference_file))
      const x_scale = benchmark.x_scale ?? "linear"
      const y_scale = benchmark.y_scale ?? "linear"
      for (const point of points) {
        if (point.x < 0) {
          throw new Error(`${benchmark.id} reference x must be non-negative elapsed time in milliseconds`)
        }
        transform(point.x, x_scale, `${benchmark.id} reference x`)
        transform(point.y, y_scale, `${benchmark.id} reference y`)
      }
    }),
  )
}

export async function scoreModelBenchmarks(
  model_dir: string,
  options: { results_directory_override?: string } = {},
): Promise<ModelValidationReport> {
  const manifest = await readBenchmarkManifest(model_dir)
  const benchmarks = await Promise.all(
    manifest.benchmarks.map((benchmark) => scoreBenchmark(model_dir, benchmark, options)),
  )
  const passing_count = benchmarks.filter((benchmark) => benchmark.passed).length
  const critical_benchmarks = benchmarks.filter((benchmark) => benchmark.critical)
  const critical_passing_count = critical_benchmarks.filter((benchmark) => benchmark.passed).length
  let total_weight = 0
  let weighted_error = 0
  let worst_normalized_error: number | undefined
  for (const [index, result] of benchmarks.entries()) {
    const weight = manifest.benchmarks[index]!.weight
    if (result.normalized_rmse === undefined) continue
    total_weight += weight
    weighted_error += result.normalized_rmse * weight
    worst_normalized_error = Math.max(worst_normalized_error ?? 0, result.normalized_max_error ?? 0)
  }

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    benchmark_count: benchmarks.length,
    passing_count,
    critical_count: critical_benchmarks.length,
    critical_passing_count,
    score: total_weight > 0 ? weighted_error / total_weight : undefined,
    worst_normalized_error,
    all_critical_passed: critical_passing_count === critical_benchmarks.length,
    all_passed: passing_count === benchmarks.length,
    benchmarks,
  }
}
