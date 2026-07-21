import { resolve, sep } from "node:path"
import type { ModelValidationSummary } from "@/shared/job-types"

export interface Point {
  x: number
  y: number
}

export interface ScoreBenchmarkOptions {
  results_directory_override?: string
  result_file_override?: string
}

export interface BenchmarkDefinition {
  id: string
  title: string
  source: {
    page: number
    figure?: string
    image?: string
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
    const source_image = source.image
    const expected_source_image = `evidence/figures/${String(entry.id)}.png`
    if (source_image !== undefined && source_image !== expected_source_image) {
      throw new Error(`Benchmark ${String(entry.id)} source.image must be ${expected_source_image}`)
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
        image: typeof source_image === "string" ? source_image : undefined,
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

export function resolveWorkspaceFile(model_dir: string, file_path: string): string {
  const resolved_root = resolve(model_dir)
  const resolved_file = resolve(resolved_root, file_path)
  if (!resolved_file.startsWith(`${resolved_root}${sep}`)) {
    throw new Error(`Benchmark file escapes the model workspace: ${file_path}`)
  }
  return resolved_file
}
