import { join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import { isRecord } from "./parse-simulation-definition"

function normalizeModelSource(source: string): string {
  return source.replace(/\r\n?/g, "\n").trim()
}

function parseSubcircuits(model_source: string): Array<{ name: string; pins: string[] }> {
  const lines = model_source.replace(/\r\n?/g, "\n").split("\n")
  const subcircuits: Array<{ name: string; pins: string[] }> = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.match(/^\s*\.\s*subckt\s+(\S+)(?:\s+(.*))?$/i)
    if (!match) continue
    const tokens = (match[2] ?? "").trim().split(/\s+/).filter(Boolean)
    while (index + 1 < lines.length) {
      const continuation = lines[index + 1]!.match(/^\s*\+\s*(.*)$/)
      if (!continuation) break
      index += 1
      tokens.push(...continuation[1]!.trim().split(/\s+/).filter(Boolean))
    }
    const parameter_index = tokens.findIndex(
      (token) => /^params?:/i.test(token) || token.includes("=") || /^[;$]/.test(token),
    )
    subcircuits.push({
      name: match[1]!,
      pins: parameter_index < 0 ? tokens : tokens.slice(0, parameter_index),
    })
  }
  return subcircuits
}

export function assertNoSyntheticBenchmarkChannel(model_source: string): void {
  const comments = model_source
    .split(/\r?\n/)
    .filter((line) => /^\s*[*;$]/.test(line))
    .join("\n")
  if (/\b(selector|telemetry|benchmark[_ -]?code|metric[_ -]?channel|selected metric)\b/i.test(comments)) {
    throw new Error("model.lib declares a synthetic benchmark selector or telemetry channel")
  }
}

class Connectivity {
  private parent = new Map<string, string>()

  private root(value: string): string {
    const parent = this.parent.get(value)
    if (!parent) {
      this.parent.set(value, value)
      return value
    }
    if (parent === value) return value
    const root = this.root(parent)
    this.parent.set(value, root)
    return root
  }

  connect(values: string[]): void {
    const [first, ...rest] = values
    if (!first) return
    const first_root = this.root(first)
    for (const value of rest) this.parent.set(this.root(value), first_root)
  }

  connected(first: string, second: string): boolean {
    return this.root(first) === this.root(second)
  }
}

function portKey(port_id: string): string {
  return `port:${port_id}`
}

function netKey(net_id: string): string {
  return `net:${net_id}`
}

function getProbeEndpointKey(
  probe: Record<string, unknown>,
  prefix: "signal" | "reference",
): string | undefined {
  const port_id = probe[`${prefix}_input_source_port_id`]
  if (typeof port_id === "string") return portKey(port_id)
  const net_id = probe[`${prefix}_input_source_net_id`]
  return typeof net_id === "string" ? netKey(net_id) : undefined
}

function buildConnectivity(records: Record<string, unknown>[]): Connectivity {
  const connectivity = new Connectivity()
  for (const trace of records) {
    if (trace.type !== "source_trace") continue
    connectivity.connect([
      ...(Array.isArray(trace.connected_source_port_ids)
        ? trace.connected_source_port_ids.filter((id): id is string => typeof id === "string").map(portKey)
        : []),
      ...(Array.isArray(trace.connected_source_net_ids)
        ? trace.connected_source_net_ids.filter((id): id is string => typeof id === "string").map(netKey)
        : []),
    ])
  }
  return connectivity
}

function currentUnitFactor(unit: string): number | undefined {
  const normalized = unit.trim().replace("μ", "u").replace("µ", "u").toLowerCase()
  return ({ a: 1, ma: 1e3, ua: 1e6, na: 1e9 } as Record<string, number>)[normalized]
}

function assertNoDirectVoltageForcingAtCurrentPin(model_source: string, dut_spice_node: string): void {
  const executable_lines: string[] = []
  let inside_canonical_subcircuit = false
  for (const line of model_source.replace(/\r\n?/g, "\n").split("\n")) {
    if (!inside_canonical_subcircuit) {
      if (/^\s*\.\s*subckt\b/i.test(line)) inside_canonical_subcircuit = true
      continue
    }
    if (/^\s*\.\s*ends?\b/i.test(line)) break
    if (!/^\s*[*;$]/.test(line)) executable_lines.push(line)
  }
  const escaped_node = dut_spice_node.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const direct_voltage_source = new RegExp(
    `^\\s*[bve][^\\s]*\\s+(?:${escaped_node}\\s+(?:0|gnd)|(?:0|gnd)\\s+${escaped_node})(?:\\s|$)`,
    "i",
  )
  if (executable_lines.some((line) => direct_voltage_source.test(line))) {
    throw new Error(
      `canonical DUT current pin ${dut_spice_node} is forced directly by an internal voltage source instead of producing physical branch current`,
    )
  }
}

export function assertSenseResistorMeasurement(input: {
  circuit_json: AnyCircuitElement[]
  probe_name: string
  sense_resistor: string
  scale: number
  unit: string
  expected_dut_port_id?: string
}): void {
  const records = input.circuit_json
    .map((element): Record<string, unknown> => ({ ...element }))
    .filter(isRecord)
  const probes = records.filter(
    (element) => element.type === "simulation_voltage_probe" && element.name === input.probe_name,
  )
  if (probes.length !== 1 || !isRecord(probes[0])) {
    throw new Error(`simulation must contain exactly one voltage probe named ${input.probe_name}`)
  }
  const signal_key = getProbeEndpointKey(probes[0], "signal")
  const reference_key = getProbeEndpointKey(probes[0], "reference")
  if (!signal_key || !reference_key) {
    throw new Error(
      `${input.probe_name} must be a differential voltage probe across sense resistor ${input.sense_resistor}`,
    )
  }
  const resistors = records.filter(
    (element) =>
      element.type === "source_component" &&
      element.name === input.sense_resistor &&
      element.ftype === "simple_resistor",
  )
  if (
    resistors.length !== 1 ||
    typeof resistors[0]?.source_component_id !== "string" ||
    typeof resistors[0]?.resistance !== "number" ||
    !Number.isFinite(resistors[0].resistance) ||
    resistors[0].resistance <= 0
  ) {
    throw new Error(`${input.sense_resistor} must be exactly one explicit positive-resistance sense resistor`)
  }
  const resistor_id = resistors[0].source_component_id
  const resistor_port_keys = records
    .filter(
      (element) =>
        element.type === "source_port" &&
        element.source_component_id === resistor_id &&
        typeof element.source_port_id === "string",
    )
    .map((element) => portKey(element.source_port_id as string))
  if (resistor_port_keys.length !== 2) {
    throw new Error(`sense resistor ${input.sense_resistor} must expose exactly two source ports`)
  }
  const connectivity = buildConnectivity(records)
  const signal_port = resistor_port_keys.find((port) => connectivity.connected(signal_key, port))
  const reference_port = resistor_port_keys.find((port) => connectivity.connected(reference_key, port))
  if (!signal_port || !reference_port || signal_port === reference_port) {
    throw new Error(
      `${input.probe_name} must measure differentially across the two distinct terminals of sense resistor ${input.sense_resistor}`,
    )
  }
  const dut_components = records.filter(
    (element) => element.type === "source_component" && element.name === "DUT",
  )
  const dut_id =
    dut_components.length === 1 && typeof dut_components[0]?.source_component_id === "string"
      ? dut_components[0].source_component_id
      : undefined
  const eligible_dut_port_keys = input.expected_dut_port_id
    ? [portKey(input.expected_dut_port_id)]
    : records
        .filter(
          (element) =>
            element.type === "source_port" &&
            element.source_component_id === dut_id &&
            typeof element.source_port_id === "string",
        )
        .map((element) => portKey(element.source_port_id as string))
  if (
    eligible_dut_port_keys.length === 0 ||
    !resistor_port_keys.some((resistor_port) =>
      eligible_dut_port_keys.some((dut_port) => connectivity.connected(resistor_port, dut_port)),
    )
  ) {
    throw new Error(
      `sense resistor ${input.sense_resistor} is not in series at the declared DUT current path`,
    )
  }
  const unit_factor = currentUnitFactor(input.unit)
  if (!unit_factor) {
    throw new Error(`current series unit ${input.unit} is unsupported; use A, mA, uA, or nA`)
  }
  const expected_scale = unit_factor / resistors[0].resistance
  const relative_error = Math.abs(Math.abs(input.scale) - expected_scale) / expected_scale
  if (relative_error > 1e-6) {
    throw new Error(
      `${input.probe_name} simulation.scale must equal ${expected_scale} (or its negative for reversed polarity) for ${resistors[0].resistance} ohm ${input.sense_resistor} in ${input.unit}`,
    )
  }
}

export function assertSimulationProbeExists(input: {
  circuit_json: AnyCircuitElement[]
  probe_name: string
}): void {
  const matches = input.circuit_json.filter(
    (element) => element.type === "simulation_voltage_probe" && element.name === input.probe_name,
  )
  if (matches.length !== 1) {
    throw new Error(`simulation must contain exactly one voltage probe named ${input.probe_name}`)
  }
}

export function assertCanonicalDutSimulation(input: {
  circuit_json: AnyCircuitElement[]
  model_source: string
  probe_name: string
  dut_spice_node: string
  sense_resistor?: string
  scale?: number
  unit?: string
}): void {
  const { circuit_json, model_source, probe_name, dut_spice_node } = input
  const records = circuit_json.map((element): Record<string, unknown> => ({ ...element })).filter(isRecord)
  const dut_components = records.filter(
    (element) => element.type === "source_component" && element.name === "DUT",
  )
  if (dut_components.length !== 1 || typeof dut_components[0]?.source_component_id !== "string") {
    throw new Error("simulation must contain exactly one source component named DUT")
  }
  const dut_id = dut_components[0].source_component_id
  const dut_ports = records.filter(
    (element) =>
      element.type === "source_port" &&
      element.source_component_id === dut_id &&
      typeof element.source_port_id === "string",
  )
  if (dut_ports.length === 0) throw new Error("DUT has no source ports in simulation output")

  const spice_models = records.filter(
    (element) => element.type === "simulation_spice_subcircuit" && element.source_component_id === dut_id,
  )
  if (spice_models.length !== 1 || !isRecord(spice_models[0])) {
    throw new Error("DUT must have exactly one canonical simulation_spice_subcircuit")
  }
  const spice_model = spice_models[0]
  if (
    typeof spice_model.subcircuit_source !== "string" ||
    normalizeModelSource(spice_model.subcircuit_source) !== normalizeModelSource(model_source)
  ) {
    throw new Error("DUT simulation does not use the canonical model.lib source")
  }
  if (!isRecord(spice_model.spice_pin_to_source_port_map)) {
    throw new Error("DUT SPICE pin mapping is missing")
  }
  const dut_port_ids = new Set(dut_ports.map((port) => port.source_port_id as string))
  const mapped_spice_pins = Object.keys(spice_model.spice_pin_to_source_port_map)
  const mapped_port_ids = Object.values(spice_model.spice_pin_to_source_port_map)
  if (
    mapped_port_ids.length === 0 ||
    new Set(mapped_port_ids).size !== mapped_port_ids.length ||
    mapped_port_ids.some((port_id) => typeof port_id !== "string" || !dut_port_ids.has(port_id))
  ) {
    throw new Error("DUT SPICE pin mapping does not resolve exclusively to DUT ports")
  }
  const first_subcircuit = parseSubcircuits(model_source)[0]
  const sorted_mapping = [...mapped_spice_pins].sort()
  if (
    !first_subcircuit ||
    first_subcircuit.pins.length === 0 ||
    JSON.stringify([...first_subcircuit.pins].sort()) !== JSON.stringify(sorted_mapping)
  ) {
    throw new Error(
      "DUT SPICE pin mapping must cover every .SUBCKT pin in the first declaration exactly once with matching case",
    )
  }

  const probes = records.filter(
    (element) => element.type === "simulation_voltage_probe" && element.name === probe_name,
  )
  if (probes.length !== 1 || !isRecord(probes[0])) {
    throw new Error(`simulation must contain exactly one voltage probe named ${probe_name}`)
  }
  const probe = probes[0]
  const signal_key = getProbeEndpointKey(probe, "signal")
  if (!signal_key) throw new Error(`${probe_name} has no signal input connectivity`)

  const connectivity = buildConnectivity(records)
  const expected_mapping = Object.entries(spice_model.spice_pin_to_source_port_map).find(
    ([spice_pin]) => spice_pin.toLowerCase() === dut_spice_node.toLowerCase(),
  )
  const expected_port_id = expected_mapping?.[1]
  if (typeof expected_port_id !== "string") {
    throw new Error(`simulation.dut_spice_node ${dut_spice_node} is not mapped by the canonical DUT`)
  }
  if (input.sense_resistor) {
    assertNoDirectVoltageForcingAtCurrentPin(model_source, dut_spice_node)
    assertSenseResistorMeasurement({
      circuit_json,
      probe_name,
      sense_resistor: input.sense_resistor,
      scale: input.scale ?? 0,
      unit: input.unit ?? "",
      expected_dut_port_id: expected_port_id,
    })
    return
  }
  if (!connectivity.connected(signal_key, portKey(expected_port_id))) {
    throw new Error(
      `${probe_name} must measure canonical DUT SPICE node ${dut_spice_node}, not another DUT pin`,
    )
  }

  const voltage_source_endpoint_keys = records
    .filter((element) => element.type === "simulation_voltage_source")
    .flatMap((source) => {
      const keys: string[] = []
      for (const field of [
        "positive_source_port_id",
        "negative_source_port_id",
        "terminal1_source_port_id",
        "terminal2_source_port_id",
      ] as const) {
        if (typeof source[field] === "string") keys.push(portKey(source[field]))
      }
      for (const field of [
        "positive_source_net_id",
        "negative_source_net_id",
        "terminal1_source_net_id",
        "terminal2_source_net_id",
      ] as const) {
        if (typeof source[field] === "string") keys.push(netKey(source[field]))
      }
      return keys
    })
  if (voltage_source_endpoint_keys.some((endpoint) => connectivity.connected(signal_key, endpoint))) {
    throw new Error(`${probe_name} is tied directly to an independent voltage source`)
  }
}
