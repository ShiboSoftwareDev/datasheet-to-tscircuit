import { resolve, sep } from "node:path"
import type { ModelValidationSummary } from "@/shared/job-types"

export interface Point {
  x: number
  y: number
}

export interface ScoreBenchmarkOptions {
  results_directory_override?: string
  result_file_override?: string
  result_files_override?: Record<string, string>
}

export type BenchmarkSeriesRole = "response" | "stimulus"

export interface BenchmarkSimulationDefinition {
  kind: "transient_voltage"
  x_axis: "time_ms"
  probe_name: string
  dut_spice_node?: string
  sense_resistor?: string
  scale?: number
  offset?: number
}

export interface BenchmarkSeriesDefinition {
  id: string
  title: string
  role: BenchmarkSeriesRole
  quantity: string
  unit: string
  critical: boolean
  weight: number
  tolerance: number
  max_error_tolerance?: number
  y_scale?: "linear" | "log"
  source_image?: string
  reference_file: string
  result_file: string
  simulation: BenchmarkSimulationDefinition
}

export interface BenchmarkDefinition {
  id: string
  title: string
  source: {
    page: number
    figure?: string
    image?: string
    channel_count?: number
  }
  critical: boolean
  weight: number
  tolerance: number
  max_error_tolerance?: number
  x_scale?: "linear" | "log"
  y_scale?: "linear" | "log"
  series: BenchmarkSeriesDefinition[]
  /** Legacy aliases for callers that intentionally operate on the primary response series. */
  reference_file: string
  result_file: string
  simulation: BenchmarkSimulationDefinition & { dut_spice_node: string }
}

export interface BenchmarkManifest {
  version: 1 | 2
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

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function validateId(value: unknown, label: string): string {
  const id = requiredString(value, label)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error(`${label} is invalid`)
  return id
}

function positiveNumber(value: unknown, label: string, error_message?: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(error_message ?? `${label} must be a positive finite number`)
  }
  return value
}

function optionalPositiveNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : positiveNumber(value, label)
}

function scale(value: unknown, label: string): "linear" | "log" | undefined {
  if (value === undefined) return undefined
  if (value !== "linear" && value !== "log") throw new Error(`${label} must be linear or log`)
  return value
}

function assertWorkspaceRelativePath(value: string, prefix: string, label: string): void {
  if (
    !value.startsWith(prefix) ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must stay under ${prefix}`)
  }
}

function parseSimulation(
  value: unknown,
  label: string,
  role: BenchmarkSeriesRole,
  quantity: string,
): BenchmarkSimulationDefinition {
  if (!isRecord(value) || value.kind !== "transient_voltage" || value.x_axis !== "time_ms") {
    throw new Error(`${label} must define one transient_voltage simulation with x_axis "time_ms"`)
  }
  const probe_name = requiredString(value.probe_name, `${label}.probe_name`)
  const dut_spice_node =
    value.dut_spice_node === undefined
      ? undefined
      : requiredString(value.dut_spice_node, `${label}.dut_spice_node`)
  if (role === "response" && !dut_spice_node) {
    throw new Error(`${label}.dut_spice_node is required for a DUT response series`)
  }
  const is_current = quantity.trim().toLowerCase() === "current"
  const sense_resistor =
    value.sense_resistor === undefined
      ? undefined
      : requiredString(value.sense_resistor, `${label}.sense_resistor`)
  if (is_current && !sense_resistor) {
    throw new Error(`${label}.sense_resistor is required for a current series`)
  }
  if (!is_current && sense_resistor) {
    throw new Error(`${label}.sense_resistor is only valid for a current series`)
  }
  if (is_current && (typeof value.scale !== "number" || !Number.isFinite(value.scale) || value.scale === 0)) {
    throw new Error(`${label}.scale must be a non-zero finite current conversion factor`)
  }
  if (is_current && value.offset !== undefined && value.offset !== 0) {
    throw new Error(`${label}.offset must be zero or omitted for a physical current measurement`)
  }
  for (const key of ["scale", "offset"] as const) {
    const number = value[key]
    if (number !== undefined && (typeof number !== "number" || !Number.isFinite(number))) {
      throw new Error(`${label}.${key} must be finite`)
    }
  }
  return {
    kind: "transient_voltage",
    x_axis: "time_ms",
    probe_name,
    dut_spice_node,
    sense_resistor,
    scale: typeof value.scale === "number" ? value.scale : undefined,
    offset: typeof value.offset === "number" ? value.offset : undefined,
  }
}

function parseLegacySeries(input: {
  entry: Record<string, unknown>
  benchmark_id: string
  title: string
  critical: boolean
  weight: number
  tolerance: number
  max_error_tolerance?: number
  y_scale?: "linear" | "log"
}): BenchmarkSeriesDefinition[] {
  const { entry, benchmark_id, title, critical, weight, tolerance, max_error_tolerance, y_scale } = input
  const reference_file = requiredString(entry.reference_file, `Benchmark ${benchmark_id} reference_file`)
  assertWorkspaceRelativePath(reference_file, "evidence/", `Benchmark ${benchmark_id} reference_file`)
  const result_file = requiredString(entry.result_file, `Benchmark ${benchmark_id} result_file`)
  if (result_file !== `results/champion/${benchmark_id}.csv`) {
    throw new Error(`Benchmark ${benchmark_id} result_file must be results/champion/${benchmark_id}.csv`)
  }
  return [
    {
      id: "result",
      title,
      role: "response",
      quantity: "voltage",
      unit: "V",
      critical,
      weight,
      tolerance,
      max_error_tolerance,
      y_scale,
      reference_file,
      result_file,
      simulation: parseSimulation(
        entry.simulation,
        `Benchmark ${benchmark_id} simulation`,
        "response",
        "voltage",
      ),
    },
  ]
}

function parseMultiSeries(input: {
  entry: Record<string, unknown>
  benchmark_id: string
  critical: boolean
  tolerance: number
  max_error_tolerance?: number
  y_scale?: "linear" | "log"
  channel_count: number
}): BenchmarkSeriesDefinition[] {
  const { entry, benchmark_id, critical, tolerance, max_error_tolerance, y_scale, channel_count } = input
  if (!Array.isArray(entry.series) || entry.series.length === 0) {
    throw new Error(`Benchmark ${benchmark_id} must declare every visible channel in series[]`)
  }
  if (entry.series.length !== channel_count) {
    throw new Error(
      `Benchmark ${benchmark_id} source.channel_count=${channel_count} but series[] contains ${entry.series.length} channels`,
    )
  }
  const series = entry.series.map((raw, index): BenchmarkSeriesDefinition => {
    if (!isRecord(raw)) throw new Error(`Benchmark ${benchmark_id} series ${index + 1} must be an object`)
    const id = validateId(raw.id, `Benchmark ${benchmark_id} series ${index + 1} id`)
    const role = raw.role
    if (role !== "response" && role !== "stimulus") {
      throw new Error(`Benchmark ${benchmark_id} series ${id} role must be response or stimulus`)
    }
    const reference_file = requiredString(
      raw.reference_file,
      `Benchmark ${benchmark_id} series ${id} reference_file`,
    )
    const expected_reference_file = `evidence/curves/${benchmark_id}/${id}.csv`
    if (reference_file !== expected_reference_file) {
      throw new Error(
        `Benchmark ${benchmark_id} series ${id} reference_file must be ${expected_reference_file}`,
      )
    }
    const result_file = requiredString(raw.result_file, `Benchmark ${benchmark_id} series ${id} result_file`)
    const expected_result_file = `results/champion/${benchmark_id}/${id}.csv`
    if (result_file !== expected_result_file) {
      throw new Error(`Benchmark ${benchmark_id} series ${id} result_file must be ${expected_result_file}`)
    }
    const source_image = requiredString(
      raw.source_image,
      `Benchmark ${benchmark_id} series ${id} source_image`,
    )
    const expected_source_image = `evidence/figures/${benchmark_id}/${id}.png`
    if (source_image !== expected_source_image) {
      throw new Error(`Benchmark ${benchmark_id} series ${id} source_image must be ${expected_source_image}`)
    }
    const series_critical = typeof raw.critical === "boolean" ? raw.critical : critical
    const series_tolerance =
      raw.tolerance === undefined
        ? tolerance
        : positiveNumber(raw.tolerance, `Benchmark ${benchmark_id} series ${id} tolerance`)
    const series_max_error_tolerance =
      raw.max_error_tolerance === undefined
        ? max_error_tolerance
        : positiveNumber(
            raw.max_error_tolerance,
            `Benchmark ${benchmark_id} series ${id} max_error_tolerance`,
          )
    const series_weight =
      role === "response"
        ? raw.weight === undefined
          ? 1
          : positiveNumber(raw.weight, `Benchmark ${benchmark_id} series ${id} weight`)
        : 0
    if (role === "stimulus" && raw.weight !== undefined && raw.weight !== 0) {
      throw new Error(`Benchmark ${benchmark_id} stimulus series ${id} weight must be 0 or omitted`)
    }
    const quantity = requiredString(raw.quantity, `Benchmark ${benchmark_id} series ${id} quantity`)
    const unit = requiredString(raw.unit, `Benchmark ${benchmark_id} series ${id} unit`)
    const normalized_unit = unit.trim().replace("μ", "u").replace("µ", "u").toLowerCase()
    const uses_current_unit = ["a", "ma", "ua", "na"].includes(normalized_unit)
    const is_current = quantity.trim().toLowerCase() === "current"
    if (uses_current_unit !== is_current) {
      throw new Error(
        `Benchmark ${benchmark_id} series ${id} quantity and unit must consistently identify current`,
      )
    }
    return {
      id,
      title: requiredString(raw.title, `Benchmark ${benchmark_id} series ${id} title`),
      role,
      quantity,
      unit,
      critical: series_critical,
      weight: series_weight,
      tolerance: series_tolerance,
      max_error_tolerance: series_max_error_tolerance,
      y_scale: scale(raw.y_scale, `Benchmark ${benchmark_id} series ${id} y_scale`) ?? y_scale,
      source_image,
      reference_file,
      result_file,
      simulation: parseSimulation(
        raw.simulation,
        `Benchmark ${benchmark_id} series ${id} simulation`,
        role,
        quantity,
      ),
    }
  })
  if (new Set(series.map((entry) => entry.id)).size !== series.length) {
    throw new Error(`Benchmark ${benchmark_id} series ids must be unique`)
  }
  if (new Set(series.map((entry) => entry.simulation.probe_name)).size !== series.length) {
    throw new Error(`Benchmark ${benchmark_id} series probe names must be unique`)
  }
  if (!series.some((entry) => entry.role === "response")) {
    throw new Error(`Benchmark ${benchmark_id} must contain at least one DUT response series`)
  }
  return series
}

export function parseBenchmarkManifest(value: unknown): BenchmarkManifest {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2) ||
    typeof value.locked_at !== "string" ||
    !value.locked_at.trim() ||
    !Number.isFinite(new Date(value.locked_at).valueOf())
  ) {
    throw new Error("benchmarks.json must contain a version 1 or 2 locked benchmark manifest")
  }
  if (!Array.isArray(value.benchmarks) || value.benchmarks.length === 0) {
    throw new Error("benchmarks.json must contain at least one benchmark")
  }

  const version = value.version
  const benchmarks = value.benchmarks.map((entry, index): BenchmarkDefinition => {
    if (!isRecord(entry)) throw new Error(`Benchmark ${index + 1} must be an object`)
    const id = validateId(entry.id, `Benchmark ${index + 1} id`)
    const title = requiredString(entry.title, `Benchmark ${id} title`)
    const source = entry.source
    if (!isRecord(source) || !Number.isInteger(source.page) || (source.page as number) < 1) {
      throw new Error(`Benchmark ${id} must cite a datasheet page`)
    }
    const expected_source_image = `evidence/figures/${id}.png`
    if (source.image !== undefined && source.image !== expected_source_image) {
      throw new Error(`Benchmark ${id} source.image must be ${expected_source_image}`)
    }
    if (version === 2 && source.image !== expected_source_image) {
      throw new Error(`Benchmark ${id} source.image must be ${expected_source_image}`)
    }
    if (typeof entry.critical !== "boolean")
      throw new Error(`Benchmark ${id} must declare whether it is critical`)
    const weight = positiveNumber(
      entry.weight,
      `Benchmark ${id} weight`,
      version === 1 ? `Benchmark ${id} has an invalid weight` : undefined,
    )
    const tolerance = positiveNumber(
      entry.tolerance,
      `Benchmark ${id} tolerance`,
      version === 1 ? `Benchmark ${id} has an invalid tolerance` : undefined,
    )
    const max_error_tolerance = optionalPositiveNumber(
      entry.max_error_tolerance,
      `Benchmark ${id} max_error_tolerance`,
    )
    const x_scale = scale(entry.x_scale, `Benchmark ${id} x_scale`)
    if (x_scale === "log") throw new Error(`Benchmark ${id} must use a linear elapsed-time x axis`)
    const y_scale = scale(entry.y_scale, `Benchmark ${id} y_scale`)
    const channel_count =
      version === 2
        ? Number.isInteger(source.channel_count) && (source.channel_count as number) > 0
          ? (source.channel_count as number)
          : (() => {
              throw new Error(`Benchmark ${id} source.channel_count must be a positive integer`)
            })()
        : 1
    const series =
      version === 2
        ? parseMultiSeries({
            entry,
            benchmark_id: id,
            critical: entry.critical,
            tolerance,
            max_error_tolerance,
            y_scale,
            channel_count,
          })
        : parseLegacySeries({
            entry,
            benchmark_id: id,
            title,
            critical: entry.critical,
            weight,
            tolerance,
            max_error_tolerance,
            y_scale,
          })
    const primary = series.find((candidate) => candidate.role === "response")!
    return {
      id,
      title,
      source: {
        page: source.page as number,
        figure: typeof source.figure === "string" ? source.figure : undefined,
        image: typeof source.image === "string" ? source.image : undefined,
        channel_count,
      },
      critical: entry.critical,
      weight,
      tolerance,
      max_error_tolerance,
      x_scale,
      y_scale,
      series,
      reference_file: primary.reference_file,
      result_file: primary.result_file,
      simulation: primary.simulation as BenchmarkSimulationDefinition & { dut_spice_node: string },
    }
  })

  if (new Set(benchmarks.map((benchmark) => benchmark.id)).size !== benchmarks.length) {
    throw new Error("Benchmark ids must be unique")
  }
  return { version, locked_at: value.locked_at, benchmarks }
}

export function resolveWorkspaceFile(model_dir: string, file_path: string): string {
  const resolved_root = resolve(model_dir)
  const resolved_file = resolve(resolved_root, file_path)
  if (!resolved_file.startsWith(`${resolved_root}${sep}`)) {
    throw new Error(`Benchmark file escapes the model workspace: ${file_path}`)
  }
  return resolved_file
}
