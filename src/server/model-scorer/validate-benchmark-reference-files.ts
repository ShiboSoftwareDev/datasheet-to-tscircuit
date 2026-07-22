import { BenchmarkManifest, resolveWorkspaceFile } from "./parse-benchmark-manifest"
import { readCsvPoints, transform } from "./score-single-model-benchmark"

export async function validateBenchmarkReferenceFiles(
  model_dir: string,
  manifest: BenchmarkManifest,
): Promise<void> {
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
  for (const { benchmark, series, points } of validated_series) {
    if (series.role !== "response") continue
    const signature = JSON.stringify({
      quantity: series.quantity.trim().toLowerCase(),
      unit: series.unit.trim().toLowerCase(),
      points,
    })
    const previous = response_curves.get(signature)
    const current = `${benchmark.id}/${series.id}`
    if (previous && !previous.startsWith(`${benchmark.id}/`)) {
      throw new Error(
        `Response reference ${current} is an exact duplicate of ${previous}; independently digitize each datasheet figure instead of reusing one graph's channel for another`,
      )
    }
    response_curves.set(signature, current)
  }
}
