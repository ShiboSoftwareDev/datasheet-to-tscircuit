import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rewritePspiceCompatibilitySyntax } from "@tscircuit/ngspice-spice-engine"
import type { SpiceEngine, SpiceEngineSimulationResult } from "@tscircuit/props"

interface ProbeMetadata {
  simulation_voltage_probe_id?: string
  simulation_current_probe_id?: string
  name?: string
  spice_vector: string
  source_node_name?: string
  reference_node_name?: string
  source_component_id?: string
  source_trace_id?: string
}

interface RawVector {
  name: string
  type: string
  values: number[]
}

interface TransientParameters {
  step_seconds: number
  stop_seconds: number
  start_seconds: number
}

const SI_MULTIPLIERS: Record<string, number> = {
  t: 1e12,
  g: 1e9,
  meg: 1e6,
  k: 1e3,
  m: 1e-3,
  u: 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
}

function parseSpiceNumber(value: string): number | undefined {
  const match = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([a-z]+)?$/i)
  if (!match) return undefined
  const amount = Number(match[1])
  const suffix = (match[2] ?? "").toLowerCase()
  const multiplier = suffix ? (SI_MULTIPLIERS[suffix] ?? SI_MULTIPLIERS[suffix.replace(/s$/, "")]) : 1
  return Number.isFinite(amount) && multiplier !== undefined ? amount * multiplier : undefined
}

function parseTransientParameters(spice_source: string): TransientParameters {
  const line = spice_source
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => /^\.tran\b/i.test(candidate))
  const values = line
    ?.split(/\s+/)
    .slice(1)
    .flatMap((token) => {
      const parsed = parseSpiceNumber(token)
      return parsed === undefined ? [] : [parsed]
    })
  const step_seconds = values?.[0]
  const stop_seconds = values?.[1]
  if (!(step_seconds && step_seconds > 0) || !(stop_seconds && stop_seconds > 0)) {
    throw new Error("The local ngspice engine requires a positive .tran step and stop time")
  }
  const start_seconds = values?.[2] ?? 0
  if (start_seconds < 0 || start_seconds >= stop_seconds) {
    throw new Error("The local ngspice engine requires .tran start time to precede stop time")
  }
  return {
    step_seconds,
    stop_seconds,
    start_seconds,
  }
}

function parseProbeMetadata(spice_source: string): ProbeMetadata[] {
  return spice_source.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*\*\s*tscircuit_probe\s+(.+)\s*$/i)
    if (!match?.[1]) return []
    try {
      const value: unknown = JSON.parse(match[1])
      if (
        typeof value !== "object" ||
        value === null ||
        !("spice_vector" in value) ||
        typeof value.spice_vector !== "string"
      ) {
        return []
      }
      return [value as ProbeMetadata]
    } catch {
      return []
    }
  })
}

function parseAsciiRawFile(raw_source: string): RawVector[] {
  const plot_index = raw_source.lastIndexOf("Plotname: Transient Analysis")
  const transient_source = plot_index >= 0 ? raw_source.slice(plot_index) : raw_source
  if (/^Flags:\s*complex/im.test(transient_source)) {
    throw new Error("The local ngspice engine received complex data for a transient analysis")
  }
  const variable_count = Number(transient_source.match(/^No\. Variables:\s*(\d+)/im)?.[1])
  const variables_index = transient_source.indexOf("Variables:")
  const values_index = transient_source.indexOf("Values:")
  if (!Number.isInteger(variable_count) || variable_count < 2 || variables_index < 0 || values_index < 0) {
    throw new Error("ngspice did not produce a readable transient raw file")
  }
  const variables = transient_source
    .slice(variables_index + "Variables:".length, values_index)
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)/)
      if (!match?.[1] || !match[2] || !match[3]) return []
      return [{ index: Number(match[1]), name: match[2], type: match[3] }]
    })
    .sort((left, right) => left.index - right.index)
  if (variables.length !== variable_count) {
    throw new Error(`ngspice declared ${variable_count} transient vectors but described ${variables.length}`)
  }

  const rows: number[][] = []
  let row: number[] | undefined
  for (const line of transient_source.slice(values_index + "Values:".length).split(/\r?\n/)) {
    const indexed_value = line.match(/^\s*\d+\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*$/i)
    if (indexed_value) {
      if (row && row.length === variable_count) rows.push(row)
      row = [Number(indexed_value[1])]
      continue
    }
    const continued_value = line.match(/^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*$/i)
    if (!continued_value || !row) continue
    row.push(Number(continued_value[1]))
    if (row.length === variable_count) {
      rows.push(row)
      row = undefined
    }
  }
  if (row?.length === variable_count) rows.push(row)
  if (rows.length < 2) throw new Error("ngspice produced fewer than two transient samples")
  return variables.map((variable, index) => ({
    name: variable.name,
    type: variable.type,
    values: rows.map((values) => getRequiredNumber(values, index, variable.name)),
  }))
}

function getRequiredNumber(values: number[], index: number, context: string): number {
  const value = values[index]
  if (value === undefined || !Number.isFinite(value)) {
    throw new Error(`ngspice produced an invalid ${context} value at sample ${index}`)
  }
  return value
}

function normalizeVectorName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "")
}

function getVectorValues(vectors: RawVector[], requested_name: string): number[] | undefined {
  const by_name = new Map(vectors.map((vector) => [normalizeVectorName(vector.name), vector.values]))
  const normalized = normalizeVectorName(requested_name)
  const direct = by_name.get(normalized)
  if (direct) return direct

  const differential = normalized.match(/^v\(([^,]+),([^)]+)\)$/)
  if (differential) {
    const combined = by_name.get(`v(${differential[1]})-v(${differential[2]})`)
    if (combined) return combined
    const positive = by_name.get(`v(${differential[1]})`)
    const negative = by_name.get(`v(${differential[2]})`)
    if (positive && negative) {
      return positive.map((value, index) => value - getRequiredNumber(negative, index, requested_name))
    }
  }

  const current = normalized.match(/^i\(([^)]+)\)$/)
  if (current) return by_name.get(`${current[1]}#branch`)
  return undefined
}

function resampleVector(input: {
  raw_times: number[]
  raw_values: number[]
  output_times: number[]
}): number[] {
  const { raw_times, raw_values, output_times } = input
  if (raw_times.length < 2 || raw_values.length !== raw_times.length) {
    throw new Error("ngspice returned inconsistent transient time and probe vectors")
  }
  let right_index = 1
  return output_times.map((time) => {
    const first_time = getRequiredNumber(raw_times, 0, "time")
    const last_time = getRequiredNumber(raw_times, raw_times.length - 1, "time")
    if (time <= first_time) return getRequiredNumber(raw_values, 0, "probe")
    if (time >= last_time) {
      return getRequiredNumber(raw_values, raw_values.length - 1, "probe")
    }
    while (right_index < raw_times.length - 1 && getRequiredNumber(raw_times, right_index, "time") < time) {
      right_index += 1
    }
    const left_index = Math.max(0, right_index - 1)
    const left_time = getRequiredNumber(raw_times, left_index, "time")
    const right_time = getRequiredNumber(raw_times, right_index, "time")
    if (right_time === left_time) return getRequiredNumber(raw_values, right_index, "probe")
    const ratio = (time - left_time) / (right_time - left_time)
    const left_value = getRequiredNumber(raw_values, left_index, "probe")
    const right_value = getRequiredNumber(raw_values, right_index, "probe")
    return left_value + ratio * (right_value - left_value)
  })
}

function buildSimulationCircuitJson(input: {
  spice_source: string
  vectors: RawVector[]
}): SpiceEngineSimulationResult["simulationResultCircuitJson"] {
  const parameters = parseTransientParameters(input.spice_source)
  const raw_times = input.vectors.find((vector) => vector.name.toLowerCase() === "time")?.values
  if (!raw_times) throw new Error("ngspice transient raw data has no time vector")
  const sample_count =
    Math.floor((parameters.stop_seconds - parameters.start_seconds) / parameters.step_seconds + 1e-9) + 1
  const output_times = Array.from({ length: sample_count }, (_, index) =>
    Math.min(parameters.stop_seconds, parameters.start_seconds + index * parameters.step_seconds),
  )
  const last_output_time = output_times.at(-1)
  if (last_output_time === undefined || last_output_time < parameters.stop_seconds) {
    output_times.push(parameters.stop_seconds)
  }

  return parseProbeMetadata(input.spice_source).flatMap<Record<string, unknown>>((probe, index) => {
    const raw_values = getVectorValues(input.vectors, probe.spice_vector)
    if (!raw_values) return []
    const values = resampleVector({ raw_times, raw_values, output_times })
    if (probe.simulation_current_probe_id) {
      return [
        {
          type: "simulation_transient_current_graph",
          simulation_experiment_id: "placeholder_simulation_experiment_id",
          simulation_transient_current_graph_id: `simulation_graph_${probe.simulation_current_probe_id}`,
          name: probe.name ?? probe.spice_vector,
          current_levels: values,
          timestamps_ms: output_times.map((time) => time * 1e3),
          start_time_ms: parameters.start_seconds * 1e3,
          time_per_step: parameters.step_seconds * 1e3,
          end_time_ms: parameters.stop_seconds * 1e3,
          source_probe_id: probe.simulation_current_probe_id,
          source_probe_name: probe.name,
          source_component_id: probe.source_component_id,
          source_trace_id: probe.source_trace_id,
        },
      ]
    }
    return [
      {
        type: "simulation_transient_voltage_graph",
        simulation_experiment_id: "placeholder_simulation_experiment_id",
        simulation_transient_voltage_graph_id: `simulation_graph_${
          probe.simulation_voltage_probe_id ?? index
        }`,
        name: probe.name ?? probe.spice_vector,
        voltage_levels: values,
        timestamps_ms: output_times.map((time) => time * 1e3),
        start_time_ms: parameters.start_seconds * 1e3,
        time_per_step: parameters.step_seconds * 1e3,
        end_time_ms: parameters.stop_seconds * 1e3,
        source_probe_id: probe.simulation_voltage_probe_id,
        source_probe_name: probe.name,
        source_node_name: probe.source_node_name,
        reference_node_name: probe.reference_node_name,
      },
    ]
  })
}

async function simulateWithLocalNgspice(spice_source: string): Promise<SpiceEngineSimulationResult> {
  const workspace = await mkdtemp(join(tmpdir(), "datasheet-local-ngspice-"))
  const circuit_path = join(workspace, "circuit.cir")
  const raw_path = join(workspace, "result.raw")
  try {
    const compatible_source = rewritePspiceCompatibilitySyntax(spice_source)
    await Promise.all([
      Bun.write(circuit_path, compatible_source),
      Bun.write(join(workspace, ".spiceinit"), "set filetype=ascii\n"),
    ])
    const ngspice_bin = process.env.NGSPICE_BIN?.trim() || "ngspice"
    const child_process = Bun.spawn([ngspice_bin, "-b", "-r", raw_path, circuit_path], {
      cwd: workspace,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exit_code, stdout, stderr] = await Promise.all([
      child_process.exited,
      new Response(child_process.stdout).text(),
      new Response(child_process.stderr).text(),
    ])
    const process_output = `${stdout}\n${stderr}`.trim()
    if (
      exit_code !== 0 ||
      /fatal error:|doanalyses:.*(?:aborted|failed)|run simulation\(s\) aborted/i.test(process_output)
    ) {
      throw new Error(
        `Local ngspice failed${exit_code !== 0 ? ` with code ${exit_code}` : ""}: ${process_output.slice(-4_000)}`,
      )
    }
    const vectors = parseAsciiRawFile(await readFile(raw_path, "utf8"))
    return {
      engineVersionString: "local ngspice executable",
      simulationResultCircuitJson: buildSimulationCircuitJson({
        spice_source: compatible_source,
        vectors,
      }),
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

export async function createLocalNgspiceSpiceEngine(): Promise<SpiceEngine> {
  return { simulate: simulateWithLocalNgspice }
}
