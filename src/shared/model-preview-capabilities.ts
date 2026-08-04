import type { AnyCircuitElement } from "circuit-json"

type CircuitRecord = AnyCircuitElement & Record<string, unknown>

function asRecord(element: AnyCircuitElement): CircuitRecord {
  return element as CircuitRecord
}

function isFiniteNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  )
}

function isStrictlyIncreasing(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value > values[index - 1]!)
}

/**
 * The analog viewer is useful only when tscircuit actually ran a transient
 * experiment and retained at least one time-domain voltage waveform. The
 * installed runtime does not emit current graphs, and a schematic-only Circuit
 * JSON document must never be treated as a simulation result.
 */
export function hasCompletedTransientSimulation(circuit_json: readonly AnyCircuitElement[]): boolean {
  const experiments = circuit_json.flatMap((element) => {
    const record = asRecord(element)
    return record.type === "simulation_experiment" ? [record] : []
  })
  const experiment = experiments[0]
  if (
    experiments.length !== 1 ||
    experiment?.experiment_type !== "spice_transient_analysis" ||
    typeof experiment.simulation_experiment_id !== "string"
  ) {
    return false
  }

  if (circuit_json.some((element) => element.type === "simulation_unknown_experiment_error")) {
    return false
  }
  const graph_records = circuit_json.flatMap((element) => {
    const record = asRecord(element)
    return typeof record.type === "string" &&
      record.type.startsWith("simulation_") &&
      record.type.endsWith("_graph")
      ? [record]
      : []
  })
  if (
    graph_records.length === 0 ||
    graph_records.some(({ type }) => type !== "simulation_transient_voltage_graph")
  ) {
    return false
  }

  const probes = circuit_json.flatMap((element) => {
    const record = asRecord(element)
    return record.type === "simulation_voltage_probe" &&
      typeof record.simulation_voltage_probe_id === "string"
      ? [record.simulation_voltage_probe_id]
      : []
  })
  if (new Set(probes).size !== probes.length) return false
  const graph_probe_ids = new Set<string>()
  for (const graph of graph_records) {
    const probe_id = graph.source_probe_id
    if (
      graph.simulation_experiment_id !== experiment.simulation_experiment_id ||
      typeof probe_id !== "string" ||
      probes.filter((candidate) => candidate === probe_id).length !== 1 ||
      graph_probe_ids.has(probe_id) ||
      !isFiniteNumberArray(graph.timestamps_ms) ||
      !isStrictlyIncreasing(graph.timestamps_ms) ||
      !isFiniteNumberArray(graph.voltage_levels) ||
      graph.voltage_levels.length !== graph.timestamps_ms.length
    ) {
      return false
    }
    graph_probe_ids.add(probe_id)
  }
  return true
}
