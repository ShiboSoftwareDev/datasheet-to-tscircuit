import type { ModelPublicElectricalEndpoint } from "../types"
import { hashApplicationFixtureContract } from "./hashing"
import {
  exactKeys,
  finitePositive,
  parseNodeEndpoint,
  parsePublicEndpoint,
  parseStringArray,
  record,
  requiredSha256,
  requiredString,
  safeIdentifier,
} from "./schema-helpers"
import {
  ApplicationFixtureContractError,
  type ApplicationFixtureContract,
  type ApplicationNonExecutableComponent,
  type ApplicationFixtureNodeEndpoint,
  type ApplicationFixtureNodeGroup,
  type ApplicationPassiveFixture,
} from "./types"

function parseNodeGroup(value: unknown, path: string): ApplicationFixtureNodeGroup {
  const group = record(value, path)
  exactKeys(
    group,
    ["id", "source_net", "is_ground", "source_endpoints", "dut_endpoints", "external_terminals"],
    path,
  )
  if (typeof group.is_ground !== "boolean") {
    throw new ApplicationFixtureContractError(`${path}.is_ground must be a boolean`)
  }
  if (!Array.isArray(group.dut_endpoints)) {
    throw new ApplicationFixtureContractError(`${path}.dut_endpoints must be an array`)
  }
  const dut_endpoints = group.dut_endpoints.map((entry, index) =>
    parsePublicEndpoint(entry, `${path}.dut_endpoints[${index}]`),
  )
  if (dut_endpoints.includes("gnd")) {
    throw new ApplicationFixtureContractError(`${path}.dut_endpoints must name DUT endpoints, not gnd`)
  }
  if (new Set(dut_endpoints).size !== dut_endpoints.length) {
    throw new ApplicationFixtureContractError(`${path}.dut_endpoints must be unique`)
  }
  return {
    id: safeIdentifier(group.id, `${path}.id`),
    source_net: requiredString(group.source_net, `${path}.source_net`),
    is_ground: group.is_ground,
    source_endpoints: parseStringArray(group.source_endpoints, `${path}.source_endpoints`),
    dut_endpoints,
    external_terminals: parseStringArray(group.external_terminals, `${path}.external_terminals`),
  }
}

function parseSourceTerminals(value: unknown, path: string): [string, string] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new ApplicationFixtureContractError(`${path} must contain exactly two source terminals`)
  }
  const first = requiredString(value[0], `${path}[0]`)
  const second = requiredString(value[1], `${path}[1]`)
  if (first.toLowerCase() === second.toLowerCase()) {
    throw new ApplicationFixtureContractError(`${path} terminals must be distinct`)
  }
  return [first, second]
}

function parseNonExecutableComponent(value: unknown, path: string): ApplicationNonExecutableComponent {
  const component = record(value, path)
  exactKeys(component, ["reference", "kind", "source_terminals", "reason"], path)
  if (component.reason !== "unsupported_component_kind" && component.reason !== "missing_positive_si_value") {
    throw new ApplicationFixtureContractError(
      `${path}.reason must be unsupported_component_kind or missing_positive_si_value`,
    )
  }
  const source_terminals = parseStringArray(component.source_terminals, `${path}.source_terminals`)
  if (source_terminals.length === 0) {
    throw new ApplicationFixtureContractError(`${path}.source_terminals must not be empty`)
  }
  return {
    reference: requiredString(component.reference, `${path}.reference`),
    kind: requiredString(component.kind, `${path}.kind`),
    source_terminals,
    reason: component.reason,
  }
}

function parsePassiveFixture(value: unknown, path: string): ApplicationPassiveFixture {
  const fixture = record(value, path)
  const base_keys = ["id", "reference", "source_terminals", "type"]
  const base = {
    id: safeIdentifier(fixture.id, `${path}.id`),
    reference: requiredString(fixture.reference, `${path}.reference`),
    source_terminals: parseSourceTerminals(fixture.source_terminals, `${path}.source_terminals`),
  }
  if (fixture.type === "diode") {
    exactKeys(fixture, [...base_keys, "anode", "cathode"], path)
    const anode = parseNodeEndpoint(fixture.anode, `${path}.anode`)
    const cathode = parseNodeEndpoint(fixture.cathode, `${path}.cathode`)
    if (anode === cathode) throw new ApplicationFixtureContractError(`${path} endpoints must differ`)
    return { ...base, type: "diode", anode, cathode }
  }
  const endpoint_keys = [...base_keys, "positive", "negative"]
  const positive = parseNodeEndpoint(fixture.positive, `${path}.positive`)
  const negative = parseNodeEndpoint(fixture.negative, `${path}.negative`)
  if (positive === negative) throw new ApplicationFixtureContractError(`${path} endpoints must differ`)
  if (fixture.type === "resistor") {
    exactKeys(fixture, [...endpoint_keys, "resistance_ohms"], path)
    return {
      ...base,
      type: "resistor",
      positive,
      negative,
      resistance_ohms: finitePositive(fixture.resistance_ohms, `${path}.resistance_ohms`),
    }
  }
  if (fixture.type === "capacitor") {
    exactKeys(fixture, [...endpoint_keys, "capacitance_farads"], path)
    return {
      ...base,
      type: "capacitor",
      positive,
      negative,
      capacitance_farads: finitePositive(fixture.capacitance_farads, `${path}.capacitance_farads`),
    }
  }
  if (fixture.type === "inductor") {
    exactKeys(fixture, [...endpoint_keys, "inductance_henries"], path)
    return {
      ...base,
      type: "inductor",
      positive,
      negative,
      inductance_henries: finitePositive(fixture.inductance_henries, `${path}.inductance_henries`),
    }
  }
  throw new ApplicationFixtureContractError(`${path}.type must be resistor, capacitor, inductor, or diode`)
}

function componentEndpoint(value: string): { reference: string; terminal: string } | undefined {
  const match = value.match(/^([^.\s]+)\.([^.\s]+)$/)
  return match ? { reference: match[1]!, terminal: match[2]! } : undefined
}

function fixtureEndpoints(
  fixture: ApplicationPassiveFixture,
): [ApplicationFixtureNodeEndpoint, ApplicationFixtureNodeEndpoint] {
  return fixture.type === "diode" ? [fixture.anode, fixture.cathode] : [fixture.positive, fixture.negative]
}

function assertParsedContractTopology(contract: ApplicationFixtureContract, path: string): void {
  if (contract.availability === "not_present") {
    if (
      contract.ground_node_group_id !== null ||
      contract.node_groups.length !== 0 ||
      contract.fixtures.length !== 0 ||
      (contract.non_executable_components?.length ?? 0) !== 0
    ) {
      throw new ApplicationFixtureContractError(
        `${path} not_present contract must have null ground and empty topology`,
      )
    }
    return
  }
  const group_ids = contract.node_groups.map(({ id }) => id)
  if (new Set(group_ids).size !== group_ids.length) {
    throw new ApplicationFixtureContractError(`${path}.node_groups ids must be unique`)
  }
  const ground_groups = contract.node_groups.filter(({ is_ground }) => is_ground)
  if (
    ground_groups.length !== 1 ||
    contract.ground_node_group_id === null ||
    ground_groups[0]!.id !== contract.ground_node_group_id
  ) {
    throw new ApplicationFixtureContractError(
      `${path}.ground_node_group_id must identify the only ground node group`,
    )
  }
  const dut_endpoints = contract.node_groups.flatMap(({ dut_endpoints }) => dut_endpoints)
  if (new Set(dut_endpoints).size !== dut_endpoints.length) {
    throw new ApplicationFixtureContractError(`${path} DUT endpoints must belong to exactly one node group`)
  }
  const fixture_ids = contract.fixtures.map(({ id }) => id)
  if (new Set(fixture_ids).size !== fixture_ids.length) {
    throw new ApplicationFixtureContractError(`${path}.fixtures ids must be unique`)
  }
  const non_executable_components = contract.non_executable_components ?? []
  const projected_references = [
    ...contract.fixtures.map(({ reference }) => reference.toLowerCase()),
    ...non_executable_components.map(({ reference }) => reference.toLowerCase()),
  ]
  if (new Set(projected_references).size !== projected_references.length) {
    throw new ApplicationFixtureContractError(
      `${path} component references must appear in exactly one executable or non-executable projection`,
    )
  }

  const source_endpoint_to_node = new Map<string, ApplicationFixtureNodeEndpoint>()
  const non_u1_source_endpoints: string[] = []
  for (const group of contract.node_groups) {
    const external = group.source_endpoints.filter((endpoint) => !componentEndpoint(endpoint))
    if (stableLowercase(external) !== stableLowercase(group.external_terminals)) {
      throw new ApplicationFixtureContractError(
        `${path}.node_groups.${group.id}.external_terminals must exactly match its bare source endpoints`,
      )
    }
    const u1_sources = group.source_endpoints.filter(
      (endpoint) => componentEndpoint(endpoint)?.reference.toLowerCase() === "u1",
    )
    if (u1_sources.length !== group.dut_endpoints.length) {
      throw new ApplicationFixtureContractError(
        `${path}.node_groups.${group.id} must map every U1 source endpoint to exactly one dut endpoint`,
      )
    }
    const node: ApplicationFixtureNodeEndpoint = group.is_ground ? "gnd" : `net.${group.id}`
    for (const source_endpoint of group.source_endpoints) {
      const key = source_endpoint.toLowerCase()
      if (source_endpoint_to_node.has(key)) {
        throw new ApplicationFixtureContractError(
          `${path} source endpoint ${source_endpoint} appears in more than one node group`,
        )
      }
      source_endpoint_to_node.set(key, node)
      const parsed = componentEndpoint(source_endpoint)
      if (parsed && parsed.reference.toLowerCase() !== "u1") {
        non_u1_source_endpoints.push(key)
      }
    }
  }

  const valid_node_endpoints = new Set<ApplicationFixtureNodeEndpoint>([
    "gnd",
    ...contract.node_groups.filter(({ is_ground }) => !is_ground).map(({ id }) => `net.${id}` as const),
  ])
  const fixture_source_endpoints: string[] = []
  for (const fixture of contract.fixtures) {
    const endpoints = fixtureEndpoints(fixture)
    for (const [index, endpoint] of endpoints.entries()) {
      if (!valid_node_endpoints.has(endpoint)) {
        throw new ApplicationFixtureContractError(
          `${path}.fixtures.${fixture.id} references unknown application node ${endpoint}`,
        )
      }
      const source_terminal = fixture.source_terminals[index]!
      const parsed_terminal = componentEndpoint(source_terminal)
      if (!parsed_terminal || parsed_terminal.reference.toLowerCase() !== fixture.reference.toLowerCase()) {
        throw new ApplicationFixtureContractError(
          `${path}.fixtures.${fixture.id}.source_terminals must belong to ${fixture.reference}`,
        )
      }
      const expected_node = source_endpoint_to_node.get(source_terminal.toLowerCase())
      if (expected_node !== endpoint) {
        throw new ApplicationFixtureContractError(
          `${path}.fixtures.${fixture.id} changes source terminal ${source_terminal} from ${expected_node ?? "missing"} to ${endpoint}`,
        )
      }
      fixture_source_endpoints.push(source_terminal.toLowerCase())
    }
  }
  const non_executable_source_endpoints: string[] = []
  for (const component of non_executable_components) {
    for (const source_terminal of component.source_terminals) {
      const parsed_terminal = componentEndpoint(source_terminal)
      if (!parsed_terminal || parsed_terminal.reference.toLowerCase() !== component.reference.toLowerCase()) {
        throw new ApplicationFixtureContractError(
          `${path}.non_executable_components.${component.reference}.source_terminals must belong to ${component.reference}`,
        )
      }
      const expected_node = source_endpoint_to_node.get(source_terminal.toLowerCase())
      if (!expected_node) {
        throw new ApplicationFixtureContractError(
          `${path}.non_executable_components.${component.reference} references source terminal ${source_terminal} outside the application node groups`,
        )
      }
      non_executable_source_endpoints.push(source_terminal.toLowerCase())
    }
  }
  const projected_source_endpoints = [...fixture_source_endpoints, ...non_executable_source_endpoints]
  if (new Set(projected_source_endpoints).size !== projected_source_endpoints.length) {
    throw new ApplicationFixtureContractError(
      `${path} non-U1 source terminals must appear in exactly one executable or non-executable projection`,
    )
  }
  if (stableLowercase(non_u1_source_endpoints) !== stableLowercase(projected_source_endpoints)) {
    throw new ApplicationFixtureContractError(
      `${path} executable and non-executable projections must cover every non-U1 component terminal exactly once`,
    )
  }
}

function stableLowercase(values: readonly string[]): string {
  return [...values]
    .map((value) => value.toLowerCase())
    .sort()
    .join("\0")
}

export function parseApplicationFixtureContract(
  value: unknown,
  path = "application-fixture-contract.json",
): ApplicationFixtureContract {
  const contract = record(value, path)
  exactKeys(
    contract,
    [
      "version",
      "availability",
      "source_plan_sha256",
      "source_pdf_sha256",
      "target_component",
      "ground_node_group_id",
      "node_groups",
      "fixtures",
      "non_executable_components",
      "contract_sha256",
    ],
    path,
  )
  if (contract.version !== 1) throw new ApplicationFixtureContractError(`${path}.version must be 1`)
  if (contract.availability !== "documented" && contract.availability !== "not_present") {
    throw new ApplicationFixtureContractError(`${path}.availability is invalid`)
  }
  if (contract.target_component !== "U1") {
    throw new ApplicationFixtureContractError(`${path}.target_component must be U1`)
  }
  if (!Array.isArray(contract.node_groups) || !Array.isArray(contract.fixtures)) {
    throw new ApplicationFixtureContractError(`${path}.node_groups and fixtures must be arrays`)
  }
  if (
    contract.non_executable_components !== undefined &&
    !Array.isArray(contract.non_executable_components)
  ) {
    throw new ApplicationFixtureContractError(`${path}.non_executable_components must be an array`)
  }
  const parsed: ApplicationFixtureContract = {
    version: 1,
    availability: contract.availability,
    source_plan_sha256: requiredSha256(contract.source_plan_sha256, `${path}.source_plan_sha256`),
    source_pdf_sha256: requiredSha256(contract.source_pdf_sha256, `${path}.source_pdf_sha256`),
    target_component: "U1",
    ground_node_group_id:
      contract.ground_node_group_id === null
        ? null
        : safeIdentifier(contract.ground_node_group_id, `${path}.ground_node_group_id`),
    node_groups: contract.node_groups.map((group, index) =>
      parseNodeGroup(group, `${path}.node_groups[${index}]`),
    ),
    fixtures: contract.fixtures.map((fixture, index) =>
      parsePassiveFixture(fixture, `${path}.fixtures[${index}]`),
    ),
    ...(contract.non_executable_components === undefined
      ? {}
      : {
          non_executable_components: contract.non_executable_components.map((component, index) =>
            parseNonExecutableComponent(component, `${path}.non_executable_components[${index}]`),
          ),
        }),
    contract_sha256: requiredSha256(contract.contract_sha256, `${path}.contract_sha256`),
  }
  assertParsedContractTopology(parsed, path)
  const expected = hashApplicationFixtureContract(parsed)
  if (parsed.contract_sha256 !== expected) {
    throw new ApplicationFixtureContractError(
      `${path}.contract_sha256 does not match the exact application topology`,
    )
  }
  return parsed
}
