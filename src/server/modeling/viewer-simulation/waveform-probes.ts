import type { AnyCircuitElement } from "circuit-json"
import type {
  SpiceEndpoint,
  ValidationCase,
  ValidationExecutionError,
  ValidationSeriesPoint,
} from "../../spice-validation/types"
import { asRecord, simulatorError } from "./errors"
import type { CircuitRecord } from "./types"

export function graphPoints(
  graph: CircuitRecord,
  observation: ValidationCase["observations"][number],
): ValidationSeriesPoint[] | ValidationExecutionError {
  const timestamps = graph.timestamps_ms
  const levels = observation.type === "voltage" ? graph.voltage_levels : graph.current_levels
  if (!Array.isArray(timestamps) || !Array.isArray(levels)) {
    return simulatorError(
      "viewer_waveform_missing_samples",
      `tscircuit produced no sampled ${observation.type} waveform for ${observation.id}`,
      `observations.${observation.id}`,
    )
  }
  if (timestamps.length < 2 || levels.length !== timestamps.length) {
    return simulatorError(
      "viewer_waveform_shape_mismatch",
      `tscircuit waveform ${observation.id} has ${timestamps.length} timestamps and ${levels.length} values; at least two aligned samples are required`,
      `observations.${observation.id}`,
    )
  }
  const points: ValidationSeriesPoint[] = []
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp_ms = timestamps[index]
    const value = levels[index]
    if (
      typeof timestamp_ms !== "number" ||
      !Number.isFinite(timestamp_ms) ||
      typeof value !== "number" ||
      !Number.isFinite(value)
    ) {
      return simulatorError(
        "viewer_waveform_non_finite",
        `tscircuit waveform ${observation.id} contains a non-finite sample at index ${index}`,
        `observations.${observation.id}`,
      )
    }
    const previous = points.at(-1)
    const time_seconds = timestamp_ms / 1_000
    if (previous && time_seconds <= previous.x) {
      return simulatorError(
        "viewer_waveform_time_not_increasing",
        `tscircuit waveform ${observation.id} does not have a strictly increasing time axis at index ${index}`,
        `observations.${observation.id}`,
      )
    }
    points.push({ x: time_seconds, y: value })
  }
  return points
}

export type ResolvedEndpoint =
  | { kind: "source_port"; id: string; planned: SpiceEndpoint }
  | { kind: "source_net"; id: string; planned: SpiceEndpoint }
  | { kind: "ground"; ids: ReadonlySet<string>; planned: "gnd" }

type EndpointResolution =
  | { endpoint: ResolvedEndpoint; error?: never }
  | { endpoint?: never; error: ValidationExecutionError }

export function resolvePlannedEndpoint(input: {
  circuit_json: readonly AnyCircuitElement[]
  endpoint: SpiceEndpoint
  subject: string
  path: string
}): EndpointResolution {
  const { circuit_json, endpoint, subject, path } = input
  if (endpoint === "gnd") {
    const ids = new Set(
      circuit_json.flatMap((element) => {
        const record = asRecord(element)
        const is_ground =
          record.type === "source_net" &&
          (record.is_ground === true ||
            (typeof record.name === "string" && record.name.trim().toLowerCase() === "gnd"))
        return is_ground && typeof record.source_net_id === "string" ? [record.source_net_id] : []
      }),
    )
    return { endpoint: { kind: "ground", ids, planned: endpoint } }
  }
  if (endpoint.startsWith("net.")) {
    const name = endpoint.slice("net.".length)
    const nets = circuit_json.flatMap((element) => {
      const record = asRecord(element)
      return record.type === "source_net" && record.name === name ? [record] : []
    })
    const id = nets[0]?.source_net_id
    if (nets.length !== 1 || typeof id !== "string") {
      return {
        error: simulatorError(
          "viewer_probe_endpoint_unresolved",
          `Planned endpoint ${endpoint} for ${subject} resolved to ${nets.length} Circuit JSON source nets; exactly one identified net is required`,
          path,
        ),
      }
    }
    return { endpoint: { kind: "source_net", id, planned: endpoint } }
  }

  const node = endpoint.slice("dut.".length)
  const dut_components = circuit_json.flatMap((element) => {
    const record = asRecord(element)
    return record.type === "source_component" && record.name === "DUT" ? [record] : []
  })
  const dut_id = dut_components[0]?.source_component_id
  if (dut_components.length !== 1 || typeof dut_id !== "string") {
    return {
      error: simulatorError(
        "viewer_probe_endpoint_unresolved",
        `Planned endpoint ${endpoint} for ${subject} cannot be resolved because Circuit JSON contains ${dut_components.length} named DUT source components; exactly one is required`,
        path,
      ),
    }
  }
  const ports = circuit_json.flatMap((element) => {
    const record = asRecord(element)
    const hints = Array.isArray(record.port_hints) ? record.port_hints : []
    return record.type === "source_port" &&
      record.source_component_id === dut_id &&
      (record.name === node || hints.includes(node))
      ? [record]
      : []
  })
  const id = ports[0]?.source_port_id
  if (ports.length !== 1 || typeof id !== "string") {
    return {
      error: simulatorError(
        "viewer_probe_endpoint_unresolved",
        `Planned endpoint ${endpoint} for ${subject} resolved to ${ports.length} DUT source ports; exactly one identified port is required`,
        path,
      ),
    }
  }
  return { endpoint: { kind: "source_port", id, planned: endpoint } }
}

function probeEndpointMatches(input: {
  probe: CircuitRecord
  endpoint: ResolvedEndpoint
  side: "positive" | "negative"
}): boolean {
  const { probe, endpoint, side } = input
  const port_field = side === "positive" ? "signal_input_source_port_id" : "reference_input_source_port_id"
  const net_field = side === "positive" ? "signal_input_source_net_id" : "reference_input_source_net_id"
  const port_id = probe[port_field]
  const net_id = probe[net_field]
  if (endpoint.kind === "ground" && side === "negative" && port_id === undefined && net_id === undefined) {
    // Circuit JSON defines an omitted voltage-probe reference as ground. This
    // is also what the installed tscircuit runtime emits for referenceTo=GND.
    return true
  }
  if (endpoint.kind === "source_port") {
    return port_id === endpoint.id && net_id === undefined
  }
  if (endpoint.kind === "source_net") {
    return net_id === endpoint.id && port_id === undefined
  }
  return typeof net_id === "string" && endpoint.ids.has(net_id) && port_id === undefined
}

function probeEndpointDescription(probe: CircuitRecord, side: "positive" | "negative"): string {
  const port_field = side === "positive" ? "signal_input_source_port_id" : "reference_input_source_port_id"
  const net_field = side === "positive" ? "signal_input_source_net_id" : "reference_input_source_net_id"
  const port_id = probe[port_field]
  const net_id = probe[net_field]
  if (typeof port_id === "string" && typeof net_id === "string") {
    return `both source port ${port_id} and source net ${net_id}`
  }
  if (typeof port_id === "string") return `source port ${port_id}`
  if (typeof net_id === "string") return `source net ${net_id}`
  return "no explicit endpoint"
}

export function probeForObservation(input: {
  circuit_json: readonly AnyCircuitElement[]
  observation: Extract<ValidationCase["observations"][number], { type: "voltage" }>
}):
  | {
      probe: CircuitRecord & { simulation_voltage_probe_id: string }
      error?: never
    }
  | { probe?: never; error: ValidationExecutionError } {
  const { circuit_json, observation } = input
  const expected_probe_name = `probe_${observation.id}`
  const probes = circuit_json.flatMap((element) => {
    const record = asRecord(element)
    return record.type === "simulation_voltage_probe" && record.name === expected_probe_name ? [record] : []
  })
  if (probes.length !== 1) {
    return {
      error: simulatorError(
        "viewer_probe_count",
        `Observation ${observation.id} resolved to ${probes.length} named tscircuit voltage probes; exactly one ${expected_probe_name} probe is required`,
        `observations.${observation.id}`,
      ),
    }
  }
  const probe = probes[0]!
  if (typeof probe.simulation_voltage_probe_id !== "string") {
    return {
      error: simulatorError(
        "viewer_probe_missing_id",
        `Voltage probe ${expected_probe_name} has no traceable simulation_voltage_probe_id`,
        `observations.${observation.id}`,
      ),
    }
  }
  for (const side of ["positive", "negative"] as const) {
    const resolved = resolvePlannedEndpoint({
      circuit_json,
      endpoint: observation[side],
      subject: `observation ${observation.id}`,
      path: `observations.${observation.id}.${side}`,
    })
    if (resolved.error) return { error: resolved.error }
    if (!probeEndpointMatches({ probe, endpoint: resolved.endpoint, side })) {
      return {
        error: simulatorError(
          "viewer_probe_endpoint_mismatch",
          `Voltage probe ${expected_probe_name} measures ${probeEndpointDescription(probe, side)} on its ${side} side instead of planned endpoint ${observation[side]}`,
          `observations.${observation.id}.${side}`,
        ),
      }
    }
  }
  return {
    probe: probe as CircuitRecord & { simulation_voltage_probe_id: string },
  }
}

export function graphsForProbe(input: {
  circuit_json: readonly AnyCircuitElement[]
  experiment_id: string
  probe_id: string
}): CircuitRecord[] {
  const { circuit_json, experiment_id, probe_id } = input
  return circuit_json.flatMap((element) => {
    const graph = asRecord(element)
    return graph.type === "simulation_transient_voltage_graph" &&
      graph.simulation_experiment_id === experiment_id &&
      graph.source_probe_id === probe_id
      ? [graph]
      : []
  })
}
