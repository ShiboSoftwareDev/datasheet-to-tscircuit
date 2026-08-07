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
 * experiment and retained at least one time-domain voltage or current
 * waveform. A schematic-only Circuit JSON document must never be treated as a
 * simulation result.
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
    graph_records.some(
      ({ type }) =>
        type !== "simulation_transient_voltage_graph" && type !== "simulation_transient_current_graph",
    )
  ) {
    return false
  }

  const voltage_probes = circuit_json.flatMap((element) => {
    const record = asRecord(element)
    return record.type === "simulation_voltage_probe" &&
      typeof record.simulation_voltage_probe_id === "string"
      ? [record.simulation_voltage_probe_id]
      : []
  })
  const current_probes = circuit_json.flatMap((element) => {
    const record = asRecord(element)
    return record.type === "simulation_current_probe" &&
      typeof record.simulation_current_probe_id === "string"
      ? [record.simulation_current_probe_id]
      : []
  })
  if (
    new Set(voltage_probes).size !== voltage_probes.length ||
    new Set(current_probes).size !== current_probes.length
  ) {
    return false
  }
  const graph_probe_keys = new Set<string>()
  for (const graph of graph_records) {
    const is_voltage = graph.type === "simulation_transient_voltage_graph"
    const probes = is_voltage ? voltage_probes : current_probes
    const levels = is_voltage ? graph.voltage_levels : graph.current_levels
    const probe_id = graph.source_probe_id
    const probe_key = `${is_voltage ? "voltage" : "current"}:${String(probe_id)}`
    if (
      graph.simulation_experiment_id !== experiment.simulation_experiment_id ||
      typeof probe_id !== "string" ||
      probes.filter((candidate) => candidate === probe_id).length !== 1 ||
      graph_probe_keys.has(probe_key) ||
      !isFiniteNumberArray(graph.timestamps_ms) ||
      !isStrictlyIncreasing(graph.timestamps_ms) ||
      !isFiniteNumberArray(levels) ||
      levels.length !== graph.timestamps_ms.length
    ) {
      return false
    }
    graph_probe_keys.add(probe_key)
  }
  return true
}
