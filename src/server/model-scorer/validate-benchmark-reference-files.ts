import { BenchmarkManifest, resolveWorkspaceFile } from "./parse-benchmark-manifest"
import { getReferenceTimeAxisError, readCsvPoints, transform } from "./score-single-model-benchmark"
import { validateFigureTraceColorCoverage, validateTraceProvenance } from "./validate-trace-provenance"

function normalizedCurveSamples(points: Array<{ x: number; y: number }>): number[] | undefined {
  if (points.length < 3) return undefined
  const x_min = points[0]!.x
  const x_max = points.at(-1)!.x
  const y_values = points.map((point) => point.y)
  const y_min = Math.min(...y_values)
  const y_max = Math.max(...y_values)
  const x_span = x_max - x_min
  const y_span = y_max - y_min
  if (!(x_span > 0) || !(y_span > 0)) return undefined

  let segment = 0
  return Array.from({ length: 41 }, (_, index) => {
    const x = x_min + (x_span * index) / 40
    while (segment + 1 < points.length - 1 && points[segment + 1]!.x < x) segment += 1
    const first = points[segment]!
    const second = points[Math.min(segment + 1, points.length - 1)]!
    const fraction = second.x === first.x ? 0 : (x - first.x) / (second.x - first.x)
    const y = first.y + (second.y - first.y) * Math.max(0, Math.min(1, fraction))
    return (y - y_min) / y_span
  })
}

function curvesHaveNearIdenticalShape(
  first: Array<{ x: number; y: number }>,
  second: Array<{ x: number; y: number }>,
): boolean {
  const first_samples = normalizedCurveSamples(first)
  const second_samples = normalizedCurveSamples(second)
  if (!first_samples || !second_samples || first_samples.length !== second_samples.length) return false
  const mean_squared_error =
    first_samples.reduce((total, value, index) => {
      const difference = value - second_samples[index]!
      return total + difference * difference
    }, 0) / first_samples.length
  return Math.sqrt(mean_squared_error) <= 0.01
}

export async function validateBenchmarkReferenceFiles(
  model_dir: string,
  manifest: BenchmarkManifest,
  options: { require_trace_provenance?: boolean } = {},
): Promise<string[]> {
  if (options.require_trace_provenance) {
    for (const benchmark of manifest.benchmarks) {
      if (!benchmark.source.subplot_count) {
        throw new Error(
          `Benchmark ${benchmark.id} source.subplot_count must record every distinct plotted pane in the source figure`,
        )
      }
      if (!benchmark.source.image) {
        throw new Error(`Benchmark ${benchmark.id} must retain its complete source figure image`)
      }
      for (const series of benchmark.series) {
        if (!series.subplot_index) {
          throw new Error(
            `Benchmark ${benchmark.id} series ${series.id} must declare which source subplot it traces`,
          )
        }
        if (!series.trace_file) {
          throw new Error(
            `Benchmark ${benchmark.id} series ${series.id} must declare trace_file as evidence/traces/${benchmark.id}/${series.id}.json`,
          )
        }
      }
    }
  }
  const validated_series = await Promise.all(
    manifest.benchmarks.flatMap((benchmark) =>
      benchmark.series.map(async (series) => {
        const points = await readCsvPoints(resolveWorkspaceFile(model_dir, series.reference_file))
        const x_scale = benchmark.x_scale ?? "linear"
        const y_scale = series.y_scale ?? "linear"
        const time_axis_error = getReferenceTimeAxisError(points, `${benchmark.id}/${series.id} reference x`)
        if (time_axis_error) throw new Error(time_axis_error)
        for (const point of points) {
          transform({ value: point.x, scale: x_scale, label: `${benchmark.id}/${series.id} reference x` })
          transform({ value: point.y, scale: y_scale, label: `${benchmark.id}/${series.id} reference y` })
        }
        return { benchmark, series, points }
      }),
    ),
  )
  if (options.require_trace_provenance) {
    for (const benchmark of manifest.benchmarks) {
      const trace_colors = await Promise.all(
        validated_series
          .filter(({ benchmark: candidate }) => candidate.id === benchmark.id)
          .map(({ series, points }) =>
            validateTraceProvenance({
              model_dir,
              benchmark_id: benchmark.id,
              series_id: series.id,
              source_image: series.source_image!,
              trace_file: series.trace_file!,
              points,
              x_scale: benchmark.x_scale ?? "linear",
              y_scale: series.y_scale ?? benchmark.y_scale ?? "linear",
              role: series.role,
            }),
          ),
      )
      await validateFigureTraceColorCoverage({
        model_dir,
        benchmark_id: benchmark.id,
        source_image: benchmark.source.image!,
        trace_colors,
      })
    }
  }
  const response_curves = new Map<string, { label: string; critical: boolean; source_key: string }>()
  const comparable_responses: Array<{
    benchmark_id: string
    label: string
    quantity: string
    unit: string
    points: Array<{ x: number; y: number }>
  }> = []
  const warnings: string[] = []
  const blocking_duplicates: string[] = []
  for (const { benchmark, series, points } of validated_series) {
    if (series.role !== "response") continue
    const quantity = series.quantity.trim().toLowerCase()
    const unit = series.unit.trim().toLowerCase()
    const response_target = series.simulation.dut_spice_node?.trim().toLowerCase() ?? ""
    const signature = JSON.stringify({
      quantity,
      unit,
      response_target,
      points,
    })
    const previous = response_curves.get(signature)
    const current = `${benchmark.id}/${series.id}`
    const source_key = JSON.stringify({
      page: benchmark.source.page,
      figure: benchmark.source.figure,
      image: benchmark.source.image,
    })
    if (previous && !previous.label.startsWith(`${benchmark.id}/`) && previous.source_key !== source_key) {
      const message =
        `Evidence quality: response reference ${current} is an exact duplicate of ${previous.label} despite coming from a distinct datasheet figure; ` +
        "independently digitize each figure or mark the unsupported benchmark non-critical/evidence-only."
      if (series.critical || previous.critical) blocking_duplicates.push(message)
      else warnings.push(`${message} The non-critical output remains available as weak evidence.`)
    } else {
      const near_duplicate = comparable_responses.find(
        (candidate) =>
          candidate.benchmark_id !== benchmark.id &&
          candidate.quantity === quantity &&
          candidate.unit === unit &&
          curvesHaveNearIdenticalShape(candidate.points, points),
      )
      if (near_duplicate) {
        warnings.push(
          `Evidence quality: response reference ${current} has a near-identical normalized shape to ${near_duplicate.label}; verify both curves against their separate datasheet figures. The output remains available, but this evidence similarity weakens the accuracy claim.`,
        )
      }
    }
    response_curves.set(signature, {
      label: current,
      critical: series.critical,
      source_key,
    })
    comparable_responses.push({
      benchmark_id: benchmark.id,
      label: current,
      quantity,
      unit,
      points,
    })
  }
  if (blocking_duplicates.length > 0) {
    throw new Error(
      `Critical benchmark reference evidence contains ${blocking_duplicates.length} copied response curve${
        blocking_duplicates.length === 1 ? "" : "s"
      }:\n${[...new Set(blocking_duplicates)].map((error) => `- ${error}`).join("\n")}`,
    )
  }
  return [...new Set(warnings)]
}
