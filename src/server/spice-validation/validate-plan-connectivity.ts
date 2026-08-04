import { getFixtureEndpoints, parseEndpointSyntax } from "./identifiers"
import type { ValidationModelDefinition } from "./model-definition"
import type { ValidationCollector } from "./parse-helpers"
import type { ReferenceContract, ValidationCase } from "./types"

function validateCurveAnalysisRange(input: {
  validation_case: ValidationCase
  reference: Extract<ReferenceContract, { type: "curve" }>
  path: string
  collector: ValidationCollector
}): void {
  if (input.reference.points.length === 0) return
  const analysis = input.validation_case.analysis
  if (analysis.type === "operating_point") return
  const analysis_min =
    analysis.type === "dc_sweep" ? Math.min(analysis.start, analysis.stop) : (analysis.start ?? 0)
  const analysis_max = analysis.type === "dc_sweep" ? Math.max(analysis.start, analysis.stop) : analysis.stop
  const reference_x = input.reference.points.map(({ x }) => x)
  const reference_min = Math.min(...reference_x)
  const reference_max = Math.max(...reference_x)
  const magnitude = Math.max(
    1,
    Math.abs(analysis_min),
    Math.abs(analysis_max),
    Math.abs(reference_min),
    Math.abs(reference_max),
  )
  const epsilon = magnitude * Number.EPSILON * 32
  if (reference_min < analysis_min - epsilon || reference_max > analysis_max + epsilon) {
    input.collector.add(
      input.path,
      "reference_curve_outside_analysis_range",
      `curve x range [${reference_min}, ${reference_max}] must fit inside the ${analysis.type} range [${analysis_min}, ${analysis_max}]`,
    )
  }
}

function addDuplicateErrors(values: string[], base_path: string, collector: ValidationCollector): void {
  const first_index = new Map<string, number>()
  values.forEach((value, index) => {
    const existing = first_index.get(value)
    if (existing === undefined) {
      first_index.set(value, index)
      return
    }
    collector.add(
      `${base_path}[${index}]`,
      "duplicate_id",
      `duplicates ${base_path}[${existing}] (${JSON.stringify(value)})`,
    )
  })
}

function isVoltageClamped(validation_case: ValidationCase, positive: string, negative: string): boolean {
  const voltage_adjacency = new Map<string, Set<string>>()
  const connect = (left: string, right: string) => {
    const left_neighbors = voltage_adjacency.get(left) ?? new Set<string>()
    left_neighbors.add(right)
    voltage_adjacency.set(left, left_neighbors)
    const right_neighbors = voltage_adjacency.get(right) ?? new Set<string>()
    right_neighbors.add(left)
    voltage_adjacency.set(right, right_neighbors)
  }
  for (const fixture of validation_case.fixtures) {
    if (fixture.type === "voltage_source") connect(fixture.positive, fixture.negative)
  }
  for (const group of validation_case.application_fixture?.node_groups ?? []) {
    const node = group.is_ground ? "gnd" : `net.${group.id}`
    for (const endpoint of group.dut_endpoints) connect(endpoint, node)
  }
  for (const overlay of validation_case.application_fixture?.condition_overlays ?? []) {
    connect(overlay.endpoint, overlay.reference)
  }
  const pending = [positive]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current || visited.has(current)) continue
    if (current === negative) return true
    visited.add(current)
    for (const neighbor of voltage_adjacency.get(current) ?? []) pending.push(neighbor)
  }
  return false
}

function validateLogReference(
  reference: ReferenceContract,
  path: string,
  collector: ValidationCollector,
): void {
  if (reference.type === "target" && reference.target <= 0) {
    collector.add(`${path}.target`, "invalid_log_reference", "must be positive for log scale")
  }
  if (reference.type === "bounds" && reference.min !== undefined && reference.min <= 0) {
    collector.add(`${path}.min`, "invalid_log_reference", "must be positive for log scale")
  }
  if (reference.type === "bounds" && reference.max !== undefined && reference.max <= 0) {
    collector.add(`${path}.max`, "invalid_log_reference", "must be positive for log scale")
  }
  if (reference.type === "curve") {
    reference.points.forEach((point, index) => {
      if (point.y <= 0) {
        collector.add(`${path}.points[${index}].y`, "invalid_log_reference", "must be positive for log scale")
      }
    })
  }
}

export function validateCaseConnectivity(input: {
  validation_case: ValidationCase
  case_index: number
  model: ValidationModelDefinition
  covered_dut_pins: Set<string>
  collector: ValidationCollector
}): void {
  const { validation_case, case_index, model, covered_dut_pins, collector } = input
  const case_path = `cases[${case_index}]`
  const manifest_nodes = new Set(model.pins.map((pin) => pin.spice_node))
  const declared_nets = new Map(validation_case.nets.map((net, index) => [net, index]))
  addDuplicateErrors(validation_case.nets, `${case_path}.nets`, collector)
  addDuplicateErrors(
    validation_case.fixtures.map((fixture) => fixture.id),
    `${case_path}.fixtures`,
    collector,
  )
  addDuplicateErrors(
    validation_case.observations.map((observation) => observation.id),
    `${case_path}.observations`,
    collector,
  )

  const fixture_by_id = new Map(validation_case.fixtures.map((fixture) => [fixture.id, fixture]))
  const adjacency = new Map<string, Set<string>>()
  const connect = (first: string, second: string): void => {
    if (first === "gnd" || second === "gnd") return
    const first_neighbors = adjacency.get(first) ?? new Set<string>()
    first_neighbors.add(second)
    adjacency.set(first, first_neighbors)
    const second_neighbors = adjacency.get(second) ?? new Set<string>()
    second_neighbors.add(first)
    adjacency.set(second, second_neighbors)
  }
  const reaches_dut = (endpoint: string): boolean => {
    if (endpoint === "gnd") return false
    const pending = [endpoint]
    const visited = new Set<string>()
    while (pending.length > 0) {
      const current = pending.pop()
      if (!current || visited.has(current)) continue
      visited.add(current)
      if (parseEndpointSyntax(current)?.scope === "dut") return true
      for (const neighbor of adjacency.get(current) ?? []) pending.push(neighbor)
    }
    return false
  }
  const net_terminal_counts = new Map<string, number>()
  let has_ground = false
  const validate_endpoint = (endpoint: string, path: string, counts_as_terminal: boolean): void => {
    const parsed = parseEndpointSyntax(endpoint)
    if (!parsed) return
    if (parsed.scope === "gnd") {
      if (counts_as_terminal) has_ground = true
      return
    }
    if (parsed.scope === "dut") {
      if (!manifest_nodes.has(parsed.identifier)) {
        collector.add(path, "unknown_dut_pin", `does not match a manifest spice_node (${parsed.identifier})`)
      } else if (counts_as_terminal) {
        covered_dut_pins.add(parsed.identifier)
      }
      return
    }
    if (!declared_nets.has(parsed.identifier)) {
      collector.add(path, "unknown_net", `references undeclared net ${JSON.stringify(parsed.identifier)}`)
    } else if (counts_as_terminal) {
      net_terminal_counts.set(parsed.identifier, (net_terminal_counts.get(parsed.identifier) ?? 0) + 1)
    }
  }

  for (const [group_index, group] of (validation_case.application_fixture?.node_groups ?? []).entries()) {
    const group_path = `${case_path}.application_fixture.node_groups[${group_index}]`
    const group_node = group.is_ground ? "gnd" : `net.${group.id}`
    if (group.is_ground) has_ground = true
    else if (!declared_nets.has(group.id)) {
      collector.add(
        `${group_path}.id`,
        "unknown_application_net",
        `application node group ${JSON.stringify(group.id)} must be declared in case.nets`,
      )
    }
    for (const [endpoint_index, endpoint] of group.dut_endpoints.entries()) {
      validate_endpoint(endpoint, `${group_path}.dut_endpoints[${endpoint_index}]`, true)
      if (!group.is_ground) {
        connect(endpoint, group_node)
        net_terminal_counts.set(group.id, (net_terminal_counts.get(group.id) ?? 0) + 1)
      }
    }
  }
  for (const [overlay_index, overlay] of (
    validation_case.application_fixture?.condition_overlays ?? []
  ).entries()) {
    const overlay_path = `${case_path}.application_fixture.condition_overlays[${overlay_index}]`
    validate_endpoint(overlay.endpoint, `${overlay_path}.endpoint`, true)
    validate_endpoint(overlay.reference, `${overlay_path}.reference`, false)
    connect(overlay.endpoint, overlay.reference)
  }

  validation_case.fixtures.forEach((fixture, fixture_index) => {
    const fixture_path = `${case_path}.fixtures[${fixture_index}]`
    const [first, second] = getFixtureEndpoints(fixture)
    connect(first, second)
    validate_endpoint(first, `${fixture_path}.${fixture.type === "diode" ? "anode" : "positive"}`, true)
    validate_endpoint(second, `${fixture_path}.${fixture.type === "diode" ? "cathode" : "negative"}`, true)
    if (first === second) {
      collector.add(fixture_path, "shorted_fixture", "both terminals resolve to the same endpoint")
    }
  })

  validation_case.nets.forEach((net, net_index) => {
    const count = net_terminal_counts.get(net) ?? 0
    if (count < 2) {
      collector.add(
        `${case_path}.nets[${net_index}]`,
        "insufficient_net_connections",
        `must be used by at least two fixture terminals; found ${count}`,
      )
    }
  })
  if (!has_ground) {
    collector.add(
      `${case_path}.fixtures`,
      "missing_ground",
      "must connect at least one fixture terminal to gnd",
    )
  }

  if (validation_case.analysis.type === "dc_sweep") {
    const source = fixture_by_id.get(validation_case.analysis.source_id)
    if (!source) {
      collector.add(
        `${case_path}.analysis.source_id`,
        "unknown_sweep_source",
        "must reference a fixture source in the same case",
      )
    } else if (source.type !== "voltage_source" && source.type !== "current_source") {
      collector.add(
        `${case_path}.analysis.source_id`,
        "invalid_sweep_source",
        "must reference a voltage_source or current_source",
      )
    }
  }

  validation_case.observations.forEach((observation, observation_index) => {
    const observation_path = `${case_path}.observations[${observation_index}]`
    if (observation.reference.type === "curve") {
      validateCurveAnalysisRange({
        validation_case,
        reference: observation.reference,
        path: `${observation_path}.reference.points`,
        collector,
      })
    }
    if (observation.type === "voltage") {
      validate_endpoint(observation.positive, `${observation_path}.positive`, false)
      validate_endpoint(observation.negative, `${observation_path}.negative`, false)
      if (observation.positive === observation.negative) {
        collector.add(observation_path, "zero_differential", "positive and negative endpoints must differ")
      }
      if (!reaches_dut(observation.positive) && !reaches_dut(observation.negative)) {
        collector.add(
          observation_path,
          "disconnected_observation",
          "must observe a node in the DUT-connected fixture graph; ground alone does not connect independent branches",
        )
      }
      if (isVoltageClamped(validation_case, observation.positive, observation.negative)) {
        collector.add(
          observation_path,
          "insensitive_voltage_observation",
          "an ideal voltage-source path fixes the measured voltage independently of the DUT",
        )
      }
    } else {
      const fixture = fixture_by_id.get(observation.element_id)
      if (!fixture) {
        collector.add(
          `${observation_path}.element_id`,
          "unknown_observation_element",
          "must reference a fixture element in the same case",
        )
      } else {
        if (fixture.type === "current_source") {
          collector.add(
            observation_path,
            "insensitive_current_observation",
            "current through an ideal current-source fixture is fixed independently of the DUT",
          )
        }
        const [first, second] = getFixtureEndpoints(fixture)
        if (!reaches_dut(first) && !reaches_dut(second)) {
          collector.add(
            observation_path,
            "disconnected_observation",
            "must observe an element in the DUT-connected fixture graph; ground alone does not connect independent branches",
          )
        }
      }
    }
    if (observation.scale === "log") {
      validateLogReference(observation.reference, `${observation_path}.reference`, collector)
    }
  })
}

export function validatePlanCoverage(input: {
  model: ValidationModelDefinition
  covered_dut_pins: Set<string>
  modeled_requirement_ids: readonly string[]
  covered_requirement_ids: Set<string>
  collector: ValidationCollector
}): void {
  input.model.pins.forEach((pin, index) => {
    if (!input.covered_dut_pins.has(pin.spice_node)) {
      input.collector.add(
        `model.pins[${index}]`,
        "uncovered_dut_pin",
        `manifest pin ${JSON.stringify(pin.spice_node)} is not connected by any validation case`,
      )
    }
  })
  input.modeled_requirement_ids.forEach((requirement_id, index) => {
    if (!input.covered_requirement_ids.has(requirement_id)) {
      input.collector.add(
        `modeled_requirement_ids[${index}]`,
        "uncovered_requirement",
        `modeled requirement ${JSON.stringify(requirement_id)} is not covered by any validation case`,
      )
    }
  })
}
