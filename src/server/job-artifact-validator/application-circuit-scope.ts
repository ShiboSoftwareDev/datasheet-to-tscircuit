import type { AnyCircuitElement } from "circuit-json"
import type { ApplicationConnectivityPlan } from "./application-source-validation"
import { asRecord, type CircuitRecord } from "./footprint-plan-validation"

export interface TypicalApplicationCircuitScope {
  records: CircuitRecord[]
  source_group_id?: string
  subcircuit_id?: string
  source_components: CircuitRecord[]
  source_ports: CircuitRecord[]
  source_nets: CircuitRecord[]
  source_traces: CircuitRecord[]
  errors: string[]
}

function optionalRecordId(record: CircuitRecord, field: string): string | undefined {
  const value = record[field]
  return typeof value === "string" && value.trim() ? value : undefined
}

function sameOptionalId(left: string | undefined, right: string | undefined): boolean {
  return left === right
}

/**
 * Resolves the application-owned Circuit JSON records once, so every
 * application validator observes the same group/subcircuit boundary.
 * Ordinary nested groups remain in scope; implementation groups owned by a
 * child subcircuit do not.
 */
export function resolveTypicalApplicationCircuitScope(
  plan: ApplicationConnectivityPlan,
  circuit_json: AnyCircuitElement[],
): TypicalApplicationCircuitScope {
  const errors: string[] = []
  const records = circuit_json.map(asRecord)
  const all_source_components = records.filter((element) => element.type === "source_component")
  const all_source_ports = records.filter((element) => element.type === "source_port")
  const all_source_nets = records.filter((element) => element.type === "source_net")
  const source_groups = records.filter((element) => element.type === "source_group")
  const expected_component_names = new Set(
    plan.components.map((component) => component.reference.trim().toLowerCase()),
  )
  const unscoped_group = "\u0000unscoped"
  const groups_by_id = new Map<string, CircuitRecord>()
  for (const group of source_groups) {
    const source_group_id = optionalRecordId(group, "source_group_id")
    if (!source_group_id) {
      errors.push("Application contains a source group without source_group_id")
      continue
    }
    if (groups_by_id.has(source_group_id)) {
      errors.push(`Application source group ${source_group_id} is duplicated`)
      continue
    }
    groups_by_id.set(source_group_id, group)
  }

  const invalid_group_paths = new Set<string>()
  const applicationRootForGroup = (source_group_id: string): string | undefined => {
    const visited = new Set<string>()
    let current_id = source_group_id
    while (true) {
      if (visited.has(current_id)) {
        const signature = [...visited, current_id].join(" -> ")
        if (!invalid_group_paths.has(signature)) {
          invalid_group_paths.add(signature)
          errors.push(`Application source-group ancestry contains a cycle: ${signature}`)
        }
        return undefined
      }
      visited.add(current_id)
      const group = groups_by_id.get(current_id)
      if (!group) {
        const signature = `missing:${current_id}`
        if (!invalid_group_paths.has(signature)) {
          invalid_group_paths.add(signature)
          errors.push(`Application component references missing source group ${current_id}`)
        }
        return undefined
      }
      if (optionalRecordId(group, "parent_subcircuit_id")) return undefined
      const parent_group_id = optionalRecordId(group, "parent_source_group_id")
      if (!parent_group_id) return current_id
      current_id = parent_group_id
    }
  }

  const root_group_ids = new Set(
    [...groups_by_id].flatMap(([source_group_id, group]) =>
      !optionalRecordId(group, "parent_source_group_id") && !optionalRecordId(group, "parent_subcircuit_id")
        ? [source_group_id]
        : [],
    ),
  )
  const matching_components_by_group = new Map<string, CircuitRecord[]>()
  for (const component of all_source_components) {
    const name = typeof component.name === "string" ? component.name.trim().toLowerCase() : ""
    if (!expected_component_names.has(name)) continue
    const component_group_id = optionalRecordId(component, "source_group_id")
    const group = component_group_id ? applicationRootForGroup(component_group_id) : unscoped_group
    if (!group || (root_group_ids.size > 0 && !root_group_ids.has(group))) continue
    const matches = matching_components_by_group.get(group) ?? []
    matches.push(component)
    matching_components_by_group.set(group, matches)
  }

  let selected_group_key: string | undefined
  let best_score = -1
  const best_groups: string[] = []
  for (const [group, components] of matching_components_by_group) {
    const score = new Set(
      components.flatMap((component) =>
        typeof component.name === "string" ? [component.name.trim().toLowerCase()] : [],
      ),
    ).size
    if (score > best_score) {
      best_score = score
      best_groups.splice(0, best_groups.length, group)
    } else if (score === best_score) {
      best_groups.push(group)
    }
  }
  if (best_groups.length === 1) {
    selected_group_key = best_groups[0]
  } else if (best_groups.length > 1) {
    errors.push(
      `Application component scope is ambiguous across source groups: ${best_groups
        .map((group) => (group === unscoped_group ? "<unscoped>" : group))
        .sort()
        .join(", ")}`,
    )
    selected_group_key = [...best_groups].sort()[0]
  } else if (root_group_ids.size === 1) {
    selected_group_key = [...root_group_ids][0]
  } else if (root_group_ids.size > 1) {
    errors.push(`Application root source group is ambiguous: ${[...root_group_ids].sort().join(", ")}`)
    selected_group_key = [...root_group_ids].sort()[0]
  } else {
    selected_group_key = unscoped_group
  }

  const source_group_id =
    selected_group_key && selected_group_key !== unscoped_group ? selected_group_key : undefined
  const source_components = all_source_components.filter((component) => {
    const component_group_id = optionalRecordId(component, "source_group_id")
    if (!source_group_id) return component_group_id === undefined
    return Boolean(component_group_id && applicationRootForGroup(component_group_id) === source_group_id)
  })
  const selected_components = new Set(source_components)
  for (const component of all_source_components) {
    if (selected_components.has(component)) continue
    const component_group_id = optionalRecordId(component, "source_group_id")
    const application_root = component_group_id ? applicationRootForGroup(component_group_id) : unscoped_group
    // A missing root here denotes an implementation group owned by an
    // instantiated child subcircuit. Every other root is part of this compiled
    // application and must not hide components outside the selected scope.
    if (application_root === undefined) continue
    const label =
      typeof component.name === "string" && component.name.trim()
        ? component.name.trim()
        : String(component.source_component_id ?? "<unnamed>")
    errors.push(
      `Application component ${label} is outside the selected root scope ${source_group_id ?? "<unscoped>"}`,
    )
  }
  const group_record = source_group_id ? groups_by_id.get(source_group_id) : undefined
  let subcircuit_id = group_record ? optionalRecordId(group_record, "subcircuit_id") : undefined
  if (!subcircuit_id) {
    const component_ids = new Set(
      source_components.flatMap((component) =>
        typeof component.source_component_id === "string" ? [component.source_component_id] : [],
      ),
    )
    const port_subcircuits = new Set(
      all_source_ports.flatMap((port) => {
        const port_subcircuit_id = optionalRecordId(port, "subcircuit_id")
        return typeof port.source_component_id === "string" &&
          component_ids.has(port.source_component_id) &&
          port_subcircuit_id
          ? [port_subcircuit_id]
          : []
      }),
    )
    if (port_subcircuits.size === 1) subcircuit_id = [...port_subcircuits][0]
    else if (port_subcircuits.size > 1) {
      errors.push(
        `Application component scope spans multiple subcircuits: ${[...port_subcircuits].sort().join(", ")}`,
      )
    }
  }
  const in_application_subcircuit = (record: CircuitRecord): boolean =>
    sameOptionalId(optionalRecordId(record, "subcircuit_id"), subcircuit_id)
  return {
    records,
    ...(source_group_id ? { source_group_id } : {}),
    ...(subcircuit_id ? { subcircuit_id } : {}),
    source_components,
    source_ports: all_source_ports.filter(in_application_subcircuit),
    source_nets: all_source_nets.filter(in_application_subcircuit),
    source_traces: records.filter(
      (element) => element.type === "source_trace" && in_application_subcircuit(element),
    ),
    errors,
  }
}
