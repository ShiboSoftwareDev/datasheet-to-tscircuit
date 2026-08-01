import type { AnyCircuitElement } from "circuit-json"
import { normalizeElectricalPinLabel } from "../pin-label-normalization"
import type { ApplicationConnectivityPlan } from "./application-source-validation"
import { asStringArray, type CircuitRecord } from "./footprint-plan-validation"
import { resolveTypicalApplicationCircuitScope } from "./application-circuit-scope"

interface ResolvedPort {
  id: string
  interchangeable_component_id?: string
}

function optionalRecordId(record: CircuitRecord, field: string): string | undefined {
  const value = record[field]
  return typeof value === "string" && value.trim() ? value : undefined
}

function connectivityScopeKey(record: CircuitRecord, key: string): string {
  return JSON.stringify([optionalRecordId(record, "subcircuit_id") ?? null, key])
}

function resolveExpectedPort(input: {
  endpoint: string
  components_by_name: Map<string, CircuitRecord>
  ports_by_component_id: Map<string, CircuitRecord[]>
  source_nets_by_name: Map<string, CircuitRecord[]>
}): ResolvedPort | string {
  const { endpoint, components_by_name, ports_by_component_id, source_nets_by_name } = input
  const separator = endpoint.indexOf(".")
  if (separator < 0) {
    const matches = source_nets_by_name.get(normalizeElectricalPinLabel(endpoint)) ?? []
    if (matches.length !== 1) {
      return `Expected external terminal ${JSON.stringify(endpoint)} resolved to ${matches.length} source nets`
    }
    const source_net_id = matches[0]?.source_net_id
    if (typeof source_net_id !== "string") {
      return `Expected external terminal ${JSON.stringify(endpoint)} references a source net without an id`
    }
    return { id: source_net_id }
  }
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
    if (typeof port.pin_number === "number" || typeof port.pin_number === "string") {
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

  has(id: string): boolean {
    return this.parent.has(id)
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
  const application_scope = resolveTypicalApplicationCircuitScope(plan, circuit_json)
  const errors = [...application_scope.errors]
  const { records, source_ports, source_nets } = application_scope
  const expected_component_names = new Set(
    plan.components.map((component) => component.reference.trim().toLowerCase()),
  )
  const components_by_name = new Map<string, CircuitRecord>()
  for (const component of application_scope.source_components) {
    const name = typeof component.name === "string" ? component.name.trim().toLowerCase() : ""
    if (!name) {
      errors.push(
        `Unexpected unnamed application component ${String(component.source_component_id ?? "without an id")}`,
      )
      continue
    }
    if (!expected_component_names.has(name)) {
      errors.push(`Unexpected application component ${String(component.name)}`)
      continue
    }
    if (components_by_name.has(name)) {
      errors.push(`Application component ${String(component.name)} is instantiated more than once`)
      continue
    }
    components_by_name.set(name, component)
  }
  for (const expected_component of plan.components) {
    if (!components_by_name.has(expected_component.reference.trim().toLowerCase())) {
      errors.push(`Expected application component ${expected_component.reference} is missing`)
    }
  }

  const ports_by_component_id = new Map<string, CircuitRecord[]>()
  const source_nets_by_name = new Map<string, CircuitRecord[]>()
  const connectivity = new PortConnectivity()
  const endpoints_by_connectivity_key = new Map<string, string[]>()
  for (const port of source_ports) {
    if (typeof port.source_port_id !== "string" || typeof port.source_component_id !== "string") continue
    connectivity.add(port.source_port_id)
    const component_ports = ports_by_component_id.get(port.source_component_id) ?? []
    component_ports.push(port)
    ports_by_component_id.set(port.source_component_id, component_ports)
    if (typeof port.subcircuit_connectivity_map_key === "string") {
      const key = connectivityScopeKey(port, port.subcircuit_connectivity_map_key)
      const connected_ports = endpoints_by_connectivity_key.get(key) ?? []
      connected_ports.push(port.source_port_id)
      endpoints_by_connectivity_key.set(key, connected_ports)
    }
  }
  for (const source_net of source_nets) {
    if (typeof source_net.name === "string" && source_net.name.trim()) {
      const name = normalizeElectricalPinLabel(source_net.name)
      const named_nets = source_nets_by_name.get(name) ?? []
      named_nets.push(source_net)
      source_nets_by_name.set(name, named_nets)
    }
    if (typeof source_net.source_net_id !== "string") continue
    connectivity.add(source_net.source_net_id)
    if (typeof source_net.subcircuit_connectivity_map_key === "string") {
      const key = connectivityScopeKey(source_net, source_net.subcircuit_connectivity_map_key)
      const connected_endpoints = endpoints_by_connectivity_key.get(key) ?? []
      connected_endpoints.push(source_net.source_net_id)
      endpoints_by_connectivity_key.set(key, connected_endpoints)
    }
  }
  for (const connected_endpoints of endpoints_by_connectivity_key.values()) {
    connectivity.connect(connected_endpoints)
  }
  for (const trace of application_scope.source_traces) {
    const explicit_endpoint_ids = [
      ...asStringArray(trace.connected_source_port_ids),
      ...asStringArray(trace.connected_source_net_ids),
    ].filter((id) => connectivity.has(id))
    connectivity.connect(explicit_endpoint_ids)
  }

  const actual_root_by_expected_net = new Map<string, string>()
  const expected_connection_by_root = new Map<string, { net: string; allowed_endpoint_ids: Set<string> }>()
  const known_planned_endpoint_ids = new Set<string>()
  const planned_net_names = new Set(
    plan.connections.map((connection) => normalizeElectricalPinLabel(connection.net)),
  )
  for (const source_net of source_nets) {
    if (
      typeof source_net.source_net_id === "string" &&
      typeof source_net.name === "string" &&
      planned_net_names.has(normalizeElectricalPinLabel(source_net.name))
    ) {
      known_planned_endpoint_ids.add(source_net.source_net_id)
    }
  }
  const assigned_interchangeable_ports = new Set<string>()
  for (const connection of plan.connections) {
    const resolved_ports: ResolvedPort[] = []
    for (const endpoint of connection.pins) {
      const resolved = resolveExpectedPort({
        endpoint,
        components_by_name,
        ports_by_component_id,
        source_nets_by_name,
      })
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
      for (const id of ids) known_planned_endpoint_ids.add(id)
    }
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
    const matched_endpoint_ids = resolved_ports.map(({ id }) => id)
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
      matched_endpoint_ids[index] = assigned
    }
    if (assignment_failed) {
      errors.push(
        `${connection.net}: expected pins are not electrically connected: ${connection.pins.join(", ")}`,
      )
      continue
    }
    for (const id of newly_assigned_ports) assigned_interchangeable_ports.add(id)
    actual_root_by_expected_net.set(connection.net, root)
    const allowed_endpoint_ids = new Set(matched_endpoint_ids)
    const normalized_net = normalizeElectricalPinLabel(connection.net)
    for (const source_net of source_nets) {
      if (
        typeof source_net.source_net_id === "string" &&
        typeof source_net.name === "string" &&
        normalizeElectricalPinLabel(source_net.name) === normalized_net &&
        connectivity.find(source_net.source_net_id) === root
      ) {
        allowed_endpoint_ids.add(source_net.source_net_id)
      }
    }
    expected_connection_by_root.set(root, { net: connection.net, allowed_endpoint_ids })
  }

  const planned_components_by_id = new Map<string, CircuitRecord>()
  for (const component of components_by_name.values()) {
    if (typeof component.source_component_id === "string") {
      planned_components_by_id.set(component.source_component_id, component)
    }
  }
  const public_endpoint_labels = new Map<string, string>()
  for (const port of source_ports) {
    if (typeof port.source_port_id !== "string" || typeof port.source_component_id !== "string") continue
    const component = planned_components_by_id.get(port.source_component_id)
    if (!component) continue
    const component_name = typeof component.name === "string" ? component.name : port.source_component_id
    const port_name =
      typeof port.name === "string"
        ? port.name
        : typeof port.pin_number === "string" || typeof port.pin_number === "number"
          ? `pin${port.pin_number}`
          : port.source_port_id
    public_endpoint_labels.set(port.source_port_id, `${component_name}.${port_name}`)
  }
  for (const source_net of source_nets) {
    if (
      typeof source_net.source_net_id === "string" &&
      typeof source_net.name === "string" &&
      source_net.name.trim()
    ) {
      public_endpoint_labels.set(source_net.source_net_id, source_net.name.trim())
    }
  }

  const public_endpoints_by_root = new Map<string, string[]>()
  for (const id of public_endpoint_labels.keys()) {
    const root = connectivity.find(id)
    const endpoint_ids = public_endpoints_by_root.get(root) ?? []
    endpoint_ids.push(id)
    public_endpoints_by_root.set(root, endpoint_ids)
  }
  for (const [root, endpoint_ids] of public_endpoints_by_root) {
    if (endpoint_ids.length < 2) continue
    const expected_connection = expected_connection_by_root.get(root)
    if (expected_connection) {
      const unexpected_ids = endpoint_ids.filter((id) => !expected_connection.allowed_endpoint_ids.has(id))
      if (unexpected_ids.length > 0) {
        errors.push(
          `${expected_connection.net}: unexpected connected endpoints: ${unexpected_ids
            .map((id) => public_endpoint_labels.get(id) ?? id)
            .sort()
            .join(", ")}`,
        )
      }
      continue
    }
    const unexpected_ids = endpoint_ids.filter((id) => !known_planned_endpoint_ids.has(id))
    if (unexpected_ids.length === 0) continue
    errors.push(
      `Unexpected root-level application connection: ${endpoint_ids
        .map((id) => public_endpoint_labels.get(id) ?? id)
        .sort()
        .join(", ")}`,
    )
  }
  return errors
}
