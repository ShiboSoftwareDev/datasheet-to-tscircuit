import type { AnyCircuitElement } from "circuit-json"
import type { FixtureElement, SpiceEndpoint } from "../../spice-validation/types"
import { asRecord } from "./errors"
import type { CircuitRecord } from "./types"
import type { ResolvedEndpoint } from "./waveform-probes"

export type PulsedSourceFixture = Extract<FixtureElement, { type: "voltage_source" | "current_source" }> & {
  pulse: NonNullable<Extract<FixtureElement, { type: "voltage_source" | "current_source" }>["pulse"]>
}

type FixtureTerminal = {
  spice_node: "POS" | "NEG"
  native_port: "pin1" | "pin2"
  endpoint: SpiceEndpoint
  side: "positive" | "negative" | "anode" | "cathode"
}

export function expectedPulseFixtureSource(fixture: PulsedSourceFixture): string {
  const subcircuit_name = `VALIDATION_${fixture.id.toUpperCase()}`
  const source_name = fixture.type === "voltage_source" ? "VDRIVE" : "IDRIVE"
  const dc_value = fixture.type === "voltage_source" ? fixture.dc_volts : fixture.dc_amps
  const pulse = fixture.pulse
  return `.SUBCKT ${subcircuit_name} POS NEG\n${source_name} POS NEG DC ${dc_value} PULSE(${[
    pulse.low,
    pulse.high,
    pulse.delay,
    pulse.rise,
    pulse.fall,
    pulse.width,
    pulse.period,
  ].join(" ")})\n.ENDS ${subcircuit_name}`
}

export function normalizedSpiceSource(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim()
}

export function fixtureTerminals(fixture: FixtureElement): [FixtureTerminal, FixtureTerminal] {
  if (fixture.type === "diode") {
    return [
      { spice_node: "POS", native_port: "pin1", endpoint: fixture.anode, side: "anode" },
      { spice_node: "NEG", native_port: "pin2", endpoint: fixture.cathode, side: "cathode" },
    ]
  }
  return [
    { spice_node: "POS", native_port: "pin1", endpoint: fixture.positive, side: "positive" },
    { spice_node: "NEG", native_port: "pin2", endpoint: fixture.negative, side: "negative" },
  ]
}

export function expectedNativeFixtureIdentity(fixture: FixtureElement): {
  ftype: string
  field?: string
  value?: number | string
} {
  switch (fixture.type) {
    case "resistor":
      return { ftype: "simple_resistor", field: "resistance", value: fixture.resistance_ohms }
    case "capacitor":
      return { ftype: "simple_capacitor", field: "capacitance", value: fixture.capacitance_farads }
    case "inductor":
      // The installed core retains the exact source quantity string for an
      // inductor, unlike resistor/capacitor values which it normalizes.
      return { ftype: "simple_inductor", field: "inductance", value: `${fixture.inductance_henries}H` }
    case "voltage_source":
      return { ftype: "simple_voltage_source", field: "voltage", value: fixture.dc_volts }
    case "current_source":
      return { ftype: "simple_current_source", field: "current", value: fixture.dc_amps }
    case "diode":
      return { ftype: "simple_diode" }
  }
}

export function namedFixtureComponents(input: {
  fixture: FixtureElement
  circuit_json: readonly AnyCircuitElement[]
}): CircuitRecord[] {
  return input.circuit_json.flatMap((element) => {
    const record = asRecord(element)
    return record.type === "source_component" && record.name === input.fixture.id ? [record] : []
  })
}

export function fixtureComponentPorts(input: {
  circuit_json: readonly AnyCircuitElement[]
  component_id: string
}): CircuitRecord[] {
  return input.circuit_json.flatMap((element) => {
    const record = asRecord(element)
    return record.type === "source_port" && record.source_component_id === input.component_id ? [record] : []
  })
}

export function nativeFixturePort(input: {
  circuit_json: readonly AnyCircuitElement[]
  component_id: string
  port_name: "pin1" | "pin2"
}): CircuitRecord | undefined {
  const ports = input.circuit_json.flatMap((element) => {
    const record = asRecord(element)
    const hints = Array.isArray(record.port_hints) ? record.port_hints : []
    return record.type === "source_port" &&
      record.source_component_id === input.component_id &&
      (record.name === input.port_name || hints.includes(input.port_name))
      ? [record]
      : []
  })
  return ports.length === 1 ? ports[0] : undefined
}

export function fixturePort(input: {
  circuit_json: readonly AnyCircuitElement[]
  component_id: string
  model: CircuitRecord
  spice_node: "POS" | "NEG"
}): CircuitRecord | undefined {
  const mapping = input.model.spice_pin_to_source_port_map
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return undefined
  const port_id = (mapping as Record<string, unknown>)[input.spice_node]
  if (typeof port_id !== "string") return undefined
  const ports = input.circuit_json.flatMap((element) => {
    const record = asRecord(element)
    const hints = Array.isArray(record.port_hints) ? record.port_hints : []
    return record.type === "source_port" &&
      record.source_port_id === port_id &&
      record.source_component_id === input.component_id &&
      hints.includes(input.spice_node)
      ? [record]
      : []
  })
  return ports.length === 1 ? ports[0] : undefined
}

export function traceExactlyConnectsFixturePort(input: {
  circuit_json: readonly AnyCircuitElement[]
  fixture_port_id: string
  endpoint: ResolvedEndpoint
}): boolean {
  const connected_traces = input.circuit_json.flatMap((element) => {
    const trace = asRecord(element)
    if (trace.type !== "source_trace") return []
    const port_ids = Array.isArray(trace.connected_source_port_ids)
      ? trace.connected_source_port_ids.filter((id): id is string => typeof id === "string")
      : []
    const net_ids = Array.isArray(trace.connected_source_net_ids)
      ? trace.connected_source_net_ids.filter((id): id is string => typeof id === "string")
      : []
    return port_ids.includes(input.fixture_port_id) ? [{ port_ids, net_ids }] : []
  })
  if (connected_traces.length !== 1) return false
  const trace = connected_traces[0]!
  if (input.endpoint.kind === "source_port") {
    return (
      trace.net_ids.length === 0 &&
      trace.port_ids.length === 2 &&
      new Set(trace.port_ids).size === 2 &&
      trace.port_ids.includes(input.endpoint.id)
    )
  }
  const expected_net_ids =
    input.endpoint.kind === "source_net" ? new Set([input.endpoint.id]) : input.endpoint.ids
  return (
    trace.port_ids.length === 1 &&
    trace.port_ids[0] === input.fixture_port_id &&
    trace.net_ids.length === 1 &&
    expected_net_ids.has(trace.net_ids[0]!)
  )
}
