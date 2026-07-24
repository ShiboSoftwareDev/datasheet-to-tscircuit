import { BenchmarkManifest, resolveWorkspaceFile } from "./parse-benchmark-manifest"
import { readCsvPoints, transform } from "./score-single-model-benchmark"

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
): Promise<string[]> {
  const validated_series = await Promise.all(
    manifest.benchmarks.flatMap((benchmark) =>
      benchmark.series.map(async (series) => {
        const points = await readCsvPoints(resolveWorkspaceFile(model_dir, series.reference_file))
        const x_scale = benchmark.x_scale ?? "linear"
        const y_scale = series.y_scale ?? "linear"
        for (const point of points) {
          if (point.x < 0) {
            throw new Error(
              `${benchmark.id}/${series.id} reference x must be non-negative elapsed time in milliseconds`,
            )
          }
          transform({ value: point.x, scale: x_scale, label: `${benchmark.id}/${series.id} reference x` })
          transform({ value: point.y, scale: y_scale, label: `${benchmark.id}/${series.id} reference y` })
        }
        return { benchmark, series, points }
      }),
    ),
  )
  const response_curves = new Map<string, string>()
  const comparable_responses: Array<{
    benchmark_id: string
    label: string
    quantity: string
    unit: string
    points: Array<{ x: number; y: number }>
  }> = []
  const warnings: string[] = []
  for (const { benchmark, series, points } of validated_series) {
    if (series.role !== "response") continue
    const quantity = series.quantity.trim().toLowerCase()
    const unit = series.unit.trim().toLowerCase()
    const signature = JSON.stringify({
      quantity,
      unit,
      points,
    })
    const previous = response_curves.get(signature)
    const current = `${benchmark.id}/${series.id}`
    if (previous && !previous.startsWith(`${benchmark.id}/`)) {
      warnings.push(
        `Evidence quality: response reference ${current} is an exact duplicate of ${previous}; independently digitize each datasheet figure instead of reusing one graph's channel for another. The output remains available, but this duplicated evidence cannot support an accuracy claim.`,
      )
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
    response_curves.set(signature, current)
    comparable_responses.push({
      benchmark_id: benchmark.id,
      label: current,
      quantity,
      unit,
      points,
    })
  }
  return [...new Set(warnings)]
}
