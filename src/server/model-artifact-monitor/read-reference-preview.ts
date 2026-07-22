import { readdir, readFile, stat } from "node:fs/promises"
import { basename, join, relative } from "node:path"
import type {
  ModelCircuitPreview,
  ModelCurvePoint,
  ModelReferencePreview,
  ModelReferenceSeriesPreview,
} from "@/shared/job-types"
import { scoreSeriesPoints } from "../model-scorer/score-single-model-benchmark"
import { extractSimulationResultPoints, parseSimulationDefinition } from "../model-simulation-validator"

interface BenchmarkPreviewSeriesRecord {
  id: string
  title: string
  role: "response" | "stimulus"
  quantity: string
  unit: string
  reference_file: string
  y_scale: "linear" | "log"
  tolerance?: number
  max_error_tolerance?: number
  simulation?: unknown
}

interface BenchmarkPreviewRecord {
  id?: string
  title?: string
  x_scale?: "linear" | "log"
  series: BenchmarkPreviewSeriesRecord[]
  reference_file?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function parseBenchmarks(value: unknown): BenchmarkPreviewRecord[] {
  if (!isRecord(value) || !Array.isArray(value.benchmarks)) return []
  return value.benchmarks.flatMap((benchmark) => {
    if (!isRecord(benchmark)) return []
    const id = typeof benchmark.id === "string" ? benchmark.id : undefined
    const title = typeof benchmark.title === "string" ? benchmark.title : id
    const x_scale = benchmark.x_scale === "log" ? "log" : "linear"
    const tolerance = positiveNumber(benchmark.tolerance)
    const max_error_tolerance = positiveNumber(benchmark.max_error_tolerance)
    const parsed_series = Array.isArray(benchmark.series)
      ? benchmark.series.flatMap((series): BenchmarkPreviewSeriesRecord[] => {
          if (
            !isRecord(series) ||
            typeof series.id !== "string" ||
            typeof series.reference_file !== "string" ||
            (series.role !== "response" && series.role !== "stimulus")
          )
            return []
          return [
            {
              id: series.id,
              title: typeof series.title === "string" ? series.title : series.id,
              role: series.role,
              quantity: typeof series.quantity === "string" ? series.quantity : "voltage",
              unit: typeof series.unit === "string" ? series.unit : "V",
              reference_file: series.reference_file,
              y_scale:
                series.y_scale === "log" || (series.y_scale === undefined && benchmark.y_scale === "log")
                  ? "log"
                  : "linear",
              tolerance: positiveNumber(series.tolerance) ?? tolerance,
              max_error_tolerance: positiveNumber(series.max_error_tolerance) ?? max_error_tolerance,
              simulation: series.simulation,
            },
          ]
        })
      : []
    const legacy_reference_file =
      typeof benchmark.reference_file === "string" ? benchmark.reference_file : undefined
    const series =
      parsed_series.length > 0
        ? parsed_series
        : legacy_reference_file
          ? [
              {
                id: "result",
                title: title ?? "Result",
                role: "response" as const,
                quantity: "voltage",
                unit: "V",
                reference_file: legacy_reference_file,
                y_scale: benchmark.y_scale === "log" ? ("log" as const) : ("linear" as const),
                tolerance,
                max_error_tolerance,
                simulation: benchmark.simulation,
              },
            ]
          : []
    return series.length > 0
      ? [{ id, title, x_scale, series, reference_file: series[0]?.reference_file }]
      : []
  })
}

export async function readBenchmarkRecords(model_dir: string): Promise<BenchmarkPreviewRecord[]> {
  for (const file_name of ["benchmarks.json", "benchmark-draft.json"]) {
    const value = await readFile(join(model_dir, file_name), "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => undefined)
    const benchmarks = parseBenchmarks(value)
    if (benchmarks.length > 0) return benchmarks
  }
  return []
}

function downsampleCurvePoints(points: ModelCurvePoint[]): ModelCurvePoint[] {
  if (points.length <= 600) return points
  const stride = Math.ceil(points.length / 600)
  return points.filter((_, index) => index % stride === 0 || index === points.length - 1)
}

function parseCurveCsv(text: string): ModelCurvePoint[] {
  return text
    .split(/\r?\n/)
    .slice(1)
    .flatMap((line) => {
      const [raw_x, raw_y] = line.split(",")
      const x = Number(raw_x?.trim())
      const y = Number(raw_y?.trim())
      return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : []
    })
}

export async function listFiles(directory: string, suffix: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entry_path = join(directory, entry.name)
      if (entry.isDirectory()) return listFiles(entry_path, suffix)
      return entry.name.endsWith(suffix) ? [entry_path] : []
    }),
  )
  return nested.flat()
}

export async function newestFile(files: string[]): Promise<string | undefined> {
  const dated = await Promise.all(
    files.map(async (file) => ({
      file,
      modified_at: (await stat(file).catch(() => undefined))?.mtimeMs ?? 0,
    })),
  )
  return dated.sort((first, second) => second.modified_at - first.modified_at)[0]?.file
}

export async function readReferencePreview(input: {
  model_dir: string
  current_benchmark?: string
  require_exact?: boolean
  circuit_preview?: ModelCircuitPreview
}): Promise<ModelReferencePreview | undefined> {
  const benchmarks = await readBenchmarkRecords(input.model_dir)
  const normalized_current = input.current_benchmark?.replace(/\.circuit\.tsx$/i, "")
  let selected = benchmarks.find(
    (benchmark) =>
      benchmark.id === normalized_current ||
      benchmark.series.some((series) => series.reference_file.includes(normalized_current ?? "\u0000")),
  )
  if (input.require_exact && !selected) return undefined
  selected ??= benchmarks.find((benchmark) => benchmark.series.length > 0)

  if (!selected) {
    const newest_curve = await newestFile(
      await listFiles(join(input.model_dir, "evidence", "curves"), ".csv"),
    )
    if (!newest_curve) return undefined
    const reference_file = relative(input.model_dir, newest_curve)
    selected = {
      id: basename(reference_file, ".csv"),
      title: basename(reference_file, ".csv"),
      x_scale: "linear",
      reference_file,
      series: [
        {
          id: "result",
          title: basename(reference_file, ".csv"),
          role: "response",
          quantity: "voltage",
          unit: "V",
          reference_file,
          y_scale: "linear",
        },
      ],
    }
  }
  const selected_benchmark = selected

  const series_previews = (
    await Promise.all(
      selected_benchmark.series.map(
        async (
          series,
        ): Promise<
          | {
              preview: ModelReferenceSeriesPreview
              modified_at: number
            }
          | undefined
        > => {
          const reference_path = join(input.model_dir, series.reference_file)
          const [reference_text, reference_stat] = await Promise.all([
            readFile(reference_path, "utf8").catch(() => undefined),
            stat(reference_path).catch(() => undefined),
          ])
          if (!reference_text) return undefined
          const reference_points = parseCurveCsv(reference_text)
          if (reference_points.length === 0) return undefined
          const result_points = (() => {
            if (!input.circuit_preview?.circuit_json || !series.simulation) return undefined
            try {
              return extractSimulationResultPoints(
                input.circuit_preview.circuit_json,
                parseSimulationDefinition(series.simulation, {
                  role: series.role,
                  quantity: series.quantity,
                }),
              )
            } catch {
              return undefined
            }
          })()
          const legacy = selected_benchmark.series.length === 1 && series.id === "result"
          const verified_result_file = legacy
            ? `results/verified/${selected_benchmark.id}.csv`
            : `results/verified/${selected_benchmark.id}/${series.id}.csv`
          const comparison =
            result_points?.length && series.tolerance
              ? scoreSeriesPoints({
                  series: {
                    id: series.id,
                    title: series.title,
                    role: series.role,
                    unit: series.unit,
                    tolerance: series.tolerance,
                    max_error_tolerance: series.max_error_tolerance,
                    y_scale: series.y_scale,
                  },
                  reference_points,
                  result_points,
                  x_scale: selected_benchmark.x_scale,
                })
              : undefined
          return {
            preview: {
              series_id: series.id,
              title: series.title,
              role: series.role,
              quantity: series.quantity,
              unit: series.unit,
              source_file: series.reference_file,
              result_file: result_points?.length ? verified_result_file : undefined,
              y_scale: series.y_scale,
              reference_points: downsampleCurvePoints(reference_points),
              result_points: result_points?.length ? downsampleCurvePoints(result_points) : undefined,
              matches_reference: comparison?.passed,
            },
            modified_at: reference_stat?.mtimeMs ?? 0,
          }
        },
      ),
    )
  ).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
  if (series_previews.length === 0) return undefined

  const primary =
    series_previews.find((entry) => entry.preview.role === "response")?.preview ?? series_previews[0]!.preview
  const has_results = series_previews.some((entry) => entry.preview.result_points?.length)
  const series_match_results = series_previews.flatMap((entry) =>
    entry.preview.matches_reference === undefined ? [] : [entry.preview.matches_reference],
  )
  const matches_reference = series_match_results.some((matches) => !matches)
    ? false
    : series_match_results.length === series_previews.length
      ? true
      : undefined
  const is_stale = Boolean(input.circuit_preview?.is_stale)
  const result_origin = has_results ? input.circuit_preview?.snapshot_origin : undefined
  const result_status = has_results
    ? is_stale
      ? "deprecated"
      : result_origin === "workspace"
        ? "unverified"
        : input.circuit_preview?.build_status === "ready"
          ? "verified"
          : input.circuit_preview?.build_status === "building"
            ? "partial"
            : "unverified"
    : undefined
  return {
    benchmark_id: selected_benchmark.id,
    title: selected_benchmark.title ?? selected_benchmark.id ?? basename(primary.source_file, ".csv"),
    source_file: primary.source_file,
    result_file: result_status === "verified" ? primary.result_file : undefined,
    x_scale: selected_benchmark.x_scale ?? "linear",
    y_scale: primary.y_scale,
    reference_points: primary.reference_points,
    result_points: primary.result_points,
    series: series_previews.map((entry) => entry.preview),
    result_status,
    result_origin,
    matches_reference,
    is_stale,
    updated_at:
      (has_results ? input.circuit_preview?.updated_at : undefined) ??
      new Date(Math.max(...series_previews.map((entry) => entry.modified_at))).toISOString(),
  }
}
