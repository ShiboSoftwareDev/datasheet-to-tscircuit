import type { AnyCircuitElement } from "circuit-json"
import { normalizeElectricalPinLabel } from "../pin-label-normalization"
import { CircuitRecord, asRecord, asStringArray } from "./footprint-plan-validation"
import { ApplicationConnectivityPlan } from "./application-source-validation"

interface ResolvedPort {
  id: string
  interchangeable_component_id?: string
}

function resolveExpectedPort(input: {
  endpoint: string
  components_by_name: Map<string, CircuitRecord>
  ports_by_component_id: Map<string, CircuitRecord[]>
}): ResolvedPort | string {
  const { endpoint, components_by_name, ports_by_component_id } = input
  const separator = endpoint.indexOf(".")
  if (separator < 1 || separator === endpoint.length - 1) {
    return `Expected pin ${JSON.stringify(endpoint)} must use component.port syntax`
  }
  const component_name = endpoint.slice(0, separator).trim().toLowerCase()
  const port_name = endpoint.slice(separator + 1).trim()
  const normalized_port_name = normalizeElectricalPinLabel(port_name)
  const component = components_by_name.get(component_name)
  if (!component || typeof component.source_component_id !== "string") {
    return `Expected pin ${JSON.stringify(endpoint)} references missing component ${JSON.stringify(
      endpoint.slice(0, separator),
    )}`
  }
  const matches = (ports_by_component_id.get(component.source_component_id) ?? []).filter((port) => {
    const aliases = new Set<string>()
    if (typeof port.name === "string") aliases.add(port.name)
    if (typeof port.pin_number === "number") {
      aliases.add(String(port.pin_number))
      aliases.add(`pin${port.pin_number}`)
    }
    for (const hint of asStringArray(port.port_hints)) aliases.add(hint)
    return [...aliases].some((alias) => normalizeElectricalPinLabel(alias) === normalized_port_name)
  })
  if (matches.length !== 1 || typeof matches[0]?.source_port_id !== "string") {
    return `Expected pin ${JSON.stringify(endpoint)} resolved to ${matches.length} source ports`
  }
  return {
    id: matches[0].source_port_id,
    ...(component.are_pins_interchangeable === true
      ? { interchangeable_component_id: component.source_component_id }
      : {}),
  }
}

class PortConnectivity {
  private readonly parent = new Map<string, string>()

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id)
  }

  find(id: string): string {
    this.add(id)
    const parent = this.parent.get(id) as string
    if (parent === id) return id
    const root = this.find(parent)
    this.parent.set(id, root)
    return root
  }

  connect(ids: string[]): void {
    const first = ids[0]
    if (!first) return
    const root = this.find(first)
    for (const id of ids.slice(1)) this.parent.set(this.find(id), root)
  }
}

export function getTypicalApplicationConnectivityErrors(
  plan: ApplicationConnectivityPlan,
  circuit_json: AnyCircuitElement[],
): string[] {
  const errors: string[] = []
  const records = circuit_json.map(asRecord)
  const source_components = records.filter((element) => element.type === "source_component")
  const source_ports = records.filter((element) => element.type === "source_port")
  const components_by_name = new Map<string, CircuitRecord>()
  for (const component of source_components) {
    if (typeof component.name === "string") components_by_name.set(component.name.toLowerCase(), component)
  }
  for (const expected_component of plan.components) {
    if (!components_by_name.has(expected_component.reference.toLowerCase())) {
      errors.push(`Expected application component ${expected_component.reference} is missing`)
    }
  }

  const ports_by_component_id = new Map<string, CircuitRecord[]>()
  const connectivity = new PortConnectivity()
  const ports_by_connectivity_key = new Map<string, string[]>()
  for (const port of source_ports) {
    if (typeof port.source_port_id !== "string" || typeof port.source_component_id !== "string") continue
    connectivity.add(port.source_port_id)
    const component_ports = ports_by_component_id.get(port.source_component_id) ?? []
    component_ports.push(port)
    ports_by_component_id.set(port.source_component_id, component_ports)
    if (typeof port.subcircuit_connectivity_map_key === "string") {
      const connected_ports = ports_by_connectivity_key.get(port.subcircuit_connectivity_map_key) ?? []
      connected_ports.push(port.source_port_id)
      ports_by_connectivity_key.set(port.subcircuit_connectivity_map_key, connected_ports)
    }
  }
  for (const connected_ports of ports_by_connectivity_key.values()) connectivity.connect(connected_ports)
  for (const trace of records.filter((element) => element.type === "source_trace")) {
    connectivity.connect(asStringArray(trace.connected_source_port_ids))
  }

  const actual_root_by_expected_net = new Map<string, string>()
  const assigned_interchangeable_ports = new Set<string>()
  for (const connection of plan.connections) {
    const resolved_ports: ResolvedPort[] = []
    for (const endpoint of connection.pins) {
      const resolved = resolveExpectedPort({ endpoint, components_by_name, ports_by_component_id })
      if (typeof resolved === "string") errors.push(`${connection.net}: ${resolved}`)
      else resolved_ports.push(resolved)
    }
    if (resolved_ports.length !== connection.pins.length) continue
    let candidate_roots: Set<string> | undefined
    const candidate_port_ids = resolved_ports.map((port) => {
      if (!port.interchangeable_component_id) return [port.id]
      return (ports_by_component_id.get(port.interchangeable_component_id) ?? []).flatMap((candidate) =>
        typeof candidate.source_port_id === "string" &&
        !assigned_interchangeable_ports.has(candidate.source_port_id)
          ? [candidate.source_port_id]
          : [],
      )
    })
    for (const ids of candidate_port_ids) {
      const roots = new Set(ids.map((id) => connectivity.find(id)))
      candidate_roots =
        candidate_roots === undefined
          ? roots
          : new Set([...candidate_roots].filter((root) => roots.has(root)))
    }
    const used_roots = new Set(actual_root_by_expected_net.values())
    const root = [...(candidate_roots ?? [])].find((candidate) => !used_roots.has(candidate))
    if (!root) {
      const collapsed_net = [...actual_root_by_expected_net.entries()].find(([, other_root]) =>
        candidate_roots?.has(other_root),
      )
      if (collapsed_net) {
        errors.push(`${connection.net}: unexpectedly shorted to expected net ${collapsed_net[0]}`)
        continue
      }
      errors.push(
        `${connection.net}: expected pins are not electrically connected: ${connection.pins.join(", ")}`,
      )
      continue
    }
    const newly_assigned_ports: string[] = []
    let assignment_failed = false
    for (const [index, port] of resolved_ports.entries()) {
      if (!port.interchangeable_component_id) continue
      const assigned = candidate_port_ids[index]?.find(
        (id) => connectivity.find(id) === root && !newly_assigned_ports.includes(id),
      )
      if (!assigned) {
        assignment_failed = true
        break
      }
      newly_assigned_ports.push(assigned)
    }
    if (assignment_failed) {
      errors.push(
        `${connection.net}: expected pins are not electrically connected: ${connection.pins.join(", ")}`,
      )
      continue
    }
    for (const id of newly_assigned_ports) assigned_interchangeable_ports.add(id)
    actual_root_by_expected_net.set(connection.net, root)
  }
  return errors
}
