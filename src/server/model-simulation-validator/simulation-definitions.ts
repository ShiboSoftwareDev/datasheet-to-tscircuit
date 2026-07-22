import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { isRecord, parseSimulationDefinition } from "./parse-simulation-definition"
import { SimulationExtractionDefinition, SimulationSeriesDefinition } from "./types"

function findBenchmark(manifest: unknown, benchmark_id: string): Record<string, unknown> {
  if (!isRecord(manifest) || !Array.isArray(manifest.benchmarks) || manifest.benchmarks.length === 0) {
    throw new Error("benchmarks.json has no benchmark list")
  }
  const benchmark = manifest.benchmarks.find(
    (candidate) => isRecord(candidate) && candidate.id === benchmark_id,
  )
  if (!isRecord(benchmark)) throw new Error(`benchmarks.json has no ${benchmark_id} benchmark`)
  return benchmark
}

export async function getSimulationRunCount(model_dir: string): Promise<number> {
  const manifest: unknown = JSON.parse(await readFile(join(model_dir, "benchmarks.json"), "utf8"))
  if (!isRecord(manifest) || !Array.isArray(manifest.benchmarks) || manifest.benchmarks.length === 0) {
    throw new Error("benchmarks.json has no benchmark list")
  }
  for (const benchmark of manifest.benchmarks) {
    if (!isRecord(benchmark) || typeof benchmark.id !== "string") {
      throw new Error("benchmarks.json contains an invalid benchmark")
    }
    await readSimulationDefinitions(model_dir, benchmark.id)
  }
  return manifest.benchmarks.length
}

export async function readSimulationDefinitions(
  model_dir: string,
  benchmark_id: string,
): Promise<SimulationSeriesDefinition[]> {
  const manifest: unknown = JSON.parse(await readFile(join(model_dir, "benchmarks.json"), "utf8"))
  const benchmark = findBenchmark(manifest, benchmark_id)
  if (Array.isArray(benchmark.series)) {
    if (benchmark.series.length === 0) throw new Error(`Benchmark ${benchmark_id} has no series`)
    return benchmark.series.map((value, index) => {
      if (!isRecord(value)) throw new Error(`Benchmark ${benchmark_id} series ${index + 1} is invalid`)
      if (typeof value.id !== "string" || !value.id.trim()) {
        throw new Error(`Benchmark ${benchmark_id} series ${index + 1} has no id`)
      }
      if (value.role !== "response" && value.role !== "stimulus") {
        throw new Error(`Benchmark ${benchmark_id} series ${value.id} has an invalid role`)
      }
      const quantity =
        typeof value.quantity === "string" && value.quantity.trim() ? value.quantity.trim() : "voltage"
      const unit = typeof value.unit === "string" && value.unit.trim() ? value.unit.trim() : "V"
      return {
        series_id: value.id.trim(),
        role: value.role,
        quantity,
        unit,
        ...parseSimulationDefinition(value.simulation, {
          role: value.role,
          quantity,
        }),
      }
    })
  }
  return [
    {
      series_id: "result",
      role: "response",
      quantity: "voltage",
      unit: "V",
      ...parseSimulationDefinition(benchmark.simulation),
    },
  ]
}

/** Returns the primary DUT response for legacy single-output checks. */
export async function readSimulationDefinition(
  model_dir: string,
  benchmark_id: string,
): Promise<SimulationExtractionDefinition> {
  const definitions = await readSimulationDefinitions(model_dir, benchmark_id)
  const primary = definitions.find((definition) => definition.role === "response")
  if (!primary) throw new Error(`Benchmark ${benchmark_id} has no DUT response series`)
  return primary
}

export async function validateSimulationDefinitions(
  model_dir: string,
  benchmark_ids: string[],
): Promise<void> {
  await Promise.all(benchmark_ids.map((benchmark_id) => readSimulationDefinitions(model_dir, benchmark_id)))
}
