import { type BenchmarkSeriesDefinition, type Point, resolveWorkspaceFile } from "./parse-benchmark-manifest"
import {
  readBenchmarkManifest,
  readCsvPoints,
  requireBenchmark,
  resolveSeriesResultFile,
  scoreBenchmark,
  transform,
} from "./score-single-model-benchmark"

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

function renderPanel(input: {
  series: BenchmarkSeriesDefinition
  reference_points: Point[]
  result_points: Point[]
  x_scale: "linear" | "log"
  top: number
  score?: { normalized_rmse?: number; normalized_max_error?: number; passed: boolean; error_message?: string }
}): string {
  const { series, reference_points, result_points, x_scale, top, score } = input
  const y_scale = series.y_scale ?? "linear"
  const transformed_reference = reference_points.map((point) => ({
    x: transform({ value: point.x, scale: x_scale, label: "reference x" }),
    y: transform({ value: point.y, scale: y_scale, label: "reference y" }),
  }))
  const transformed_result = result_points.map((point) => ({
    x: transform({ value: point.x, scale: x_scale, label: "result x" }),
    y: transform({ value: point.y, scale: y_scale, label: "result y" }),
  }))
  const all_points = [...transformed_reference, ...transformed_result]
  const raw_x_min = Math.min(...all_points.map((point) => point.x))
  const raw_x_max = Math.max(...all_points.map((point) => point.x))
  const raw_y_min = Math.min(...all_points.map((point) => point.y))
  const raw_y_max = Math.max(...all_points.map((point) => point.y))
  const x_span = Math.max(raw_x_max - raw_x_min, Math.max(Math.abs(raw_x_min), 1) * 1e-9)
  const raw_y_span = Math.max(raw_y_max - raw_y_min, Math.max(Math.abs(raw_y_min), 1) * 1e-9)
  const y_min = raw_y_min - raw_y_span * 0.08
  const y_max = raw_y_max + raw_y_span * 0.08
  const left = 92
  const plot_width = 1_074
  const plot_height = 205
  const plot_top = top + 50
  const mapX = (value: number) => left + ((value - raw_x_min) / x_span) * plot_width
  const mapY = (value: number) => plot_top + (1 - (value - y_min) / (y_max - y_min)) * plot_height
  const makePath = (points: Point[]) =>
    downsamplePoints(points)
      .map(
        (point, index) => `${index === 0 ? "M" : "L"}${mapX(point.x).toFixed(2)},${mapY(point.y).toFixed(2)}`,
      )
      .join(" ")
  const ticks = Array.from({ length: 5 }, (_, index) => index / 4)
  const grid = ticks
    .map((ratio) => {
      const x_value = raw_x_min + ratio * x_span
      const y_value = y_min + ratio * (y_max - y_min)
      const x = mapX(x_value)
      const y = mapY(y_value)
      const x_label = x_scale === "log" ? 10 ** x_value : x_value
      const y_label = y_scale === "log" ? 10 ** y_value : y_value
      return `<line x1="${x}" y1="${plot_top}" x2="${x}" y2="${plot_top + plot_height}" class="grid"/><text x="${x}" y="${plot_top + plot_height + 24}" text-anchor="middle" class="tick">${escapeSvgText(formatAxisValue(x_label))}</text><line x1="${left}" y1="${y}" x2="${left + plot_width}" y2="${y}" class="grid"/><text x="${left - 12}" y="${y + 5}" text-anchor="end" class="tick">${escapeSvgText(formatAxisValue(y_label))}</text>`
    })
    .join("")
  const metrics = score?.error_message
    ? score.error_message
    : `NRMSE ${((score?.normalized_rmse ?? 0) * 100).toFixed(2)}% · maximum ${((score?.normalized_max_error ?? 0) * 100).toFixed(2)}% · ${score?.passed ? "PASS" : "FAIL"}`
  return `<g aria-label="${escapeSvgText(series.title)} comparison">
    <text x="${left}" y="${top + 20}" class="series-title">${escapeSvgText(series.title)} · ${escapeSvgText(series.role)} · ${escapeSvgText(series.unit)}</text>
    <text x="${left}" y="${top + 40}" class="subtitle">${escapeSvgText(metrics)}</text>
    ${grid}
    <rect x="${left}" y="${plot_top}" width="${plot_width}" height="${plot_height}" class="axis"/>
    <path d="${makePath(transformed_reference)}" class="reference"/>
    <path d="${makePath(transformed_result)}" class="result"/>
  </g>`
}

export async function renderModelBenchmarkComparisonSvg(input: {
  model_dir: string
  benchmark_id: string
  result_file_override?: string
  result_files_override?: Record<string, string>
}): Promise<string> {
  const { model_dir, benchmark_id } = input
  const manifest = await readBenchmarkManifest(model_dir)
  const benchmark = requireBenchmark(manifest, benchmark_id)
  const options = {
    result_file_override: input.result_file_override,
    result_files_override: input.result_files_override,
  }
  const score = await scoreBenchmark({ model_dir, benchmark, options })
  const panels = await Promise.all(
    benchmark.series.map(async (series, index) => {
      const [reference_points, result_points] = await Promise.all([
        readCsvPoints(resolveWorkspaceFile(model_dir, series.reference_file)),
        readCsvPoints(resolveSeriesResultFile({ model_dir, benchmark, series, options })),
      ])
      return renderPanel({
        series,
        reference_points,
        result_points,
        x_scale: benchmark.x_scale ?? "linear",
        top: 92 + index * 320,
        score: score.series?.find((candidate) => candidate.series_id === series.id),
      })
    }),
  )
  const width = 1_200
  const height = 150 + benchmark.series.length * 320
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeSvgText(benchmark.title)} multi-series reference and simulation comparison">
  <style>
    text { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; fill: #262626; }
    .title { font-size: 25px; font-weight: 700; }
    .series-title { font-size: 17px; font-weight: 700; }
    .subtitle { font-size: 13px; fill: #525252; }
    .tick { font-size: 12px; fill: #525252; }
    .grid { stroke: #e5e5e5; stroke-width: 1; }
    .axis { stroke: #737373; stroke-width: 1.5; fill: none; }
    .reference { stroke: #2563eb; stroke-width: 2.5; fill: none; }
    .result { stroke: #16a34a; stroke-width: 2.5; fill: none; }
    .legend { font-size: 14px; font-weight: 600; }
  </style>
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="92" y="38" class="title">${escapeSvgText(benchmark.title)}</text>
  <line x1="850" y1="34" x2="886" y2="34" class="reference"/><text x="896" y="39" class="legend">Datasheet reference</text>
  <line x1="850" y1="58" x2="886" y2="58" class="result"/><text x="896" y="63" class="legend">Simulation result</text>
  ${panels.join("\n")}
  <text x="600" y="${height - 18}" text-anchor="middle" class="series-title">Time (ms)</text>
</svg>\n`
}
