import type { TypicalApplicationPlan } from "../../component-workflow/application-plan"
import { normalizeElectricalPinLabel } from "../../pin-label-normalization"
import type { ModelInterface, ModelInterfacePin, ModelPublicElectricalEndpoint } from "../types"
import { parseApplicationEngineeringValue } from "./engineering-value"
import { hashApplicationFixtureContract } from "./hashing"
import { requiredSha256 } from "./schema-helpers"
import {
  ApplicationFixtureContractError,
  type ApplicationFixtureContract,
  type ApplicationFixtureContractPayload,
  type ApplicationNonExecutableComponent,
  type ApplicationFixtureNodeEndpoint,
  type ApplicationFixtureNodeGroup,
  type ApplicationPassiveFixture,
} from "./types"

const GROUND_IDENTITIES = new Set([
  "0",
  "agnd",
  "analogground",
  "dgnd",
  "digitalground",
  "gnd",
  "ground",
  "pgnd",
  "powerground",
  "vss",
  "vssa",
  "vssd",
])

function normalizeKind(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
}

function passiveType(kind: string): ApplicationPassiveFixture["type"] | undefined {
  const normalized = normalizeKind(kind)
  if (normalized.includes("resistor")) return "resistor"
  if (normalized.includes("capacitor")) return "capacitor"
  if (normalized.includes("inductor") || normalized.includes("ferrite")) return "inductor"
  if (normalized.includes("diode")) return "diode"
  return undefined
}

function componentKey(value: string): string {
  return value.trim().toLowerCase()
}

function endpointParts(value: string): { reference: string; terminal: string } | undefined {
  const separator = value.indexOf(".")
  if (separator <= 0 || separator === value.length - 1) return undefined
  return { reference: value.slice(0, separator), terminal: value.slice(separator + 1) }
}

function naturalTerminalCompare(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })
}

function nodeGroupId(index: number): string {
  return `app_net_${String(index + 1).padStart(3, "0")}`
}

function fixtureId(reference: string): string {
  const suffix = reference
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
  if (!suffix) {
    throw new ApplicationFixtureContractError(
      `typical application component reference ${JSON.stringify(reference)} cannot form a fixture id`,
    )
  }
  return `app_${suffix}`
}

function interfacePinForLabel(label: string, model_interface: ModelInterface): ModelInterfacePin {
  const normalized = normalizeElectricalPinLabel(label)
  const matches = model_interface.pins.filter((pin) =>
    [pin.component_pin, pin.spice_node, ...pin.labels].some(
      (candidate) => normalizeElectricalPinLabel(candidate) === normalized,
    ),
  )
  if (matches.length !== 1) {
    throw new ApplicationFixtureContractError(
      `typical application endpoint U1.${label} resolves to ${matches.length} public model-interface pins; expected exactly one`,
    )
  }
  return matches[0]!
}

function interfaceEndpointForLabel(
  label: string,
  model_interface: ModelInterface,
): ModelPublicElectricalEndpoint {
  return `dut.${interfacePinForLabel(label, model_interface).spice_node}`
}

function isGroundIdentity(value: string): boolean {
  return GROUND_IDENTITIES.has(normalizeElectricalPinLabel(value))
}

function applicationNodeEndpoint(group: ApplicationFixtureNodeGroup): ApplicationFixtureNodeEndpoint {
  return group.is_ground ? "gnd" : `net.${group.id}`
}

function compilePassiveFixture(input: {
  component: TypicalApplicationPlan["components"][number]
  endpoints: Array<{
    source_endpoint: string
    terminal: string
    node_group: ApplicationFixtureNodeGroup
  }>
}): ApplicationPassiveFixture {
  const type = passiveType(input.component.kind)
  if (!type) {
    throw new ApplicationFixtureContractError("compilePassiveFixture requires a supported passive kind")
  }
  if (input.endpoints.length !== 2) {
    throw new ApplicationFixtureContractError(
      `typical application ${type} ${input.component.reference} must have exactly two connected terminals; found ${input.endpoints.length}`,
    )
  }
  const ordered = [...input.endpoints].sort((left, right) =>
    naturalTerminalCompare(left.terminal, right.terminal),
  ) as [(typeof input.endpoints)[number], (typeof input.endpoints)[number]]
  const source_terminals: [string, string] = [ordered[0].source_endpoint, ordered[1].source_endpoint]
  const first = applicationNodeEndpoint(ordered[0].node_group)
  const second = applicationNodeEndpoint(ordered[1].node_group)
  if (first === second) {
    throw new ApplicationFixtureContractError(
      `typical application ${type} ${input.component.reference} has both terminals on ${first}`,
    )
  }
  const base = {
    id: fixtureId(input.component.reference),
    reference: input.component.reference,
    source_terminals,
  }
  if (type === "diode") {
    const normalized_terminals = ordered.map(({ terminal }) => normalizeElectricalPinLabel(terminal))
    const first_is_anode = ["1", "a", "anode", "pos", "positive"].includes(normalized_terminals[0]!)
    const second_is_cathode = ["2", "c", "cathode", "k", "neg", "negative"].includes(normalized_terminals[1]!)
    if (!first_is_anode || !second_is_cathode) {
      throw new ApplicationFixtureContractError(
        `typical application diode ${input.component.reference} terminals must identify anode/1 and cathode/2; found ${source_terminals.join(", ")}`,
      )
    }
    return { ...base, type, anode: first, cathode: second }
  }
  const value = parseApplicationEngineeringValue(input.component.value)
  if (value === undefined) {
    throw new ApplicationFixtureContractError(
      `typical application ${type} ${input.component.reference} must declare a positive SI value; found ${JSON.stringify(input.component.value)}`,
    )
  }
  if (type === "resistor") {
    return { ...base, type, positive: first, negative: second, resistance_ohms: value }
  }
  if (type === "capacitor") {
    return { ...base, type, positive: first, negative: second, capacitance_farads: value }
  }
  return { ...base, type, positive: first, negative: second, inductance_henries: value }
}

interface UnclassifiedNodeGroup extends Omit<ApplicationFixtureNodeGroup, "is_ground"> {
  has_explicit_ground_terminal: boolean
  has_ground_net_name: boolean
}

function classifyGroundNodeGroups(groups: UnclassifiedNodeGroup[]): ApplicationFixtureNodeGroup[] {
  const candidates = groups.filter(
    ({ has_explicit_ground_terminal, has_ground_net_name }) =>
      has_explicit_ground_terminal || has_ground_net_name,
  )
  if (candidates.length === 0) {
    throw new ApplicationFixtureContractError(
      "documented typical application must identify an external or authoritative DUT ground node group",
    )
  }
  const primary = candidates[0]!
  const ground_ids = new Set(candidates.map(({ id }) => id))
  const merged_ground: UnclassifiedNodeGroup = {
    id: primary.id,
    source_net: primary.source_net,
    source_endpoints: candidates.flatMap(({ source_endpoints }) => source_endpoints),
    dut_endpoints: candidates.flatMap(({ dut_endpoints }) => dut_endpoints),
    external_terminals: candidates.flatMap(({ external_terminals }) => external_terminals),
    has_explicit_ground_terminal: candidates.some(
      ({ has_explicit_ground_terminal }) => has_explicit_ground_terminal,
    ),
    has_ground_net_name: candidates.some(({ has_ground_net_name }) => has_ground_net_name),
  }
  return groups.flatMap((group) => {
    if (group.id !== primary.id && ground_ids.has(group.id)) return []
    const selected = group.id === primary.id ? merged_ground : group
    const { has_explicit_ground_terminal: _explicit, has_ground_net_name: _named, ...node_group } = selected
    return [{ ...node_group, is_ground: selected.id === primary.id }]
  })
}

function compileNonExecutableComponent(input: {
  component: TypicalApplicationPlan["components"][number]
  endpoints: Array<{ source_endpoint: string; terminal: string }>
  reason: ApplicationNonExecutableComponent["reason"]
}): ApplicationNonExecutableComponent {
  if (input.endpoints.length === 0) {
    throw new ApplicationFixtureContractError(
      `typical application component ${input.component.reference} has no connected terminals`,
    )
  }
  return {
    reference: input.component.reference,
    kind: input.component.kind,
    source_terminals: [...input.endpoints]
      .sort((left, right) => naturalTerminalCompare(left.terminal, right.terminal))
      .map(({ source_endpoint }) => source_endpoint),
    reason: input.reason,
  }
}

/**
 * Compiles only canonical v4 input into an immutable, deterministic electrical contract.
 * It refuses incomplete U1 coverage and guessed electrical behavior. Printed
 * ground aliases are merged into the one SPICE reference node. Components that
 * cannot be represented by the supported passive subset remain explicit as
 * non-executable source components instead of aborting model preparation.
 */
export function compileApplicationFixtureContract(input: {
  plan: TypicalApplicationPlan
  model_interface: ModelInterface
  source_plan_sha256: string
  source_pdf_sha256: string
}): ApplicationFixtureContract {
  const source_plan_sha256 = requiredSha256(input.source_plan_sha256, "source_plan_sha256")
  const source_pdf_sha256 = requiredSha256(input.source_pdf_sha256, "source_pdf_sha256")
  if (input.plan.version !== 4) {
    throw new ApplicationFixtureContractError("typical application plan must have canonical version 4")
  }
  if (input.plan.availability === "not_present") {
    const payload: ApplicationFixtureContractPayload = {
      version: 1,
      availability: "not_present",
      source_plan_sha256,
      source_pdf_sha256,
      target_component: "U1",
      ground_node_group_id: null,
      node_groups: [],
      fixtures: [],
    }
    return { ...payload, contract_sha256: hashApplicationFixtureContract(payload) }
  }

  const unclassified_groups: UnclassifiedNodeGroup[] = input.plan.connections.map((connection, index) => {
    const source_endpoints = [...connection.pins]
    const external_terminals = source_endpoints.filter((endpoint) => !endpointParts(endpoint))
    const dut_pins = source_endpoints.flatMap((source_endpoint) => {
      const parsed = endpointParts(source_endpoint)
      if (!parsed || componentKey(parsed.reference) !== "u1") return []
      return [interfacePinForLabel(parsed.terminal, input.model_interface)]
    })
    const dut_endpoints = dut_pins.map(
      ({ spice_node }) => `dut.${spice_node}` as ModelPublicElectricalEndpoint,
    )
    if (new Set(dut_endpoints).size !== dut_endpoints.length) {
      throw new ApplicationFixtureContractError(
        `typical application net ${connection.net} maps more than one U1 endpoint to the same public model pin`,
      )
    }
    return {
      id: nodeGroupId(index),
      source_net: connection.net,
      source_endpoints,
      dut_endpoints,
      external_terminals,
      has_explicit_ground_terminal:
        external_terminals.some(isGroundIdentity) ||
        dut_pins.some(
          (pin) =>
            isGroundIdentity(pin.role) ||
            [pin.component_pin, pin.spice_node, ...pin.labels].some(isGroundIdentity),
        ),
      has_ground_net_name: isGroundIdentity(connection.net),
    }
  })
  const node_groups = classifyGroundNodeGroups(unclassified_groups)
  const ground_group = node_groups.find(({ is_ground }) => is_ground)!
  const all_dut_endpoints = node_groups.flatMap(({ dut_endpoints }) => dut_endpoints)
  if (new Set(all_dut_endpoints).size !== all_dut_endpoints.length) {
    throw new ApplicationFixtureContractError(
      "documented typical application maps a public U1 endpoint into more than one node group",
    )
  }
  const expected_dut_endpoints = input.model_interface.pins.map(
    ({ spice_node }) => `dut.${spice_node}` as ModelPublicElectricalEndpoint,
  )
  const missing_dut_endpoints = expected_dut_endpoints.filter(
    (endpoint) => !all_dut_endpoints.includes(endpoint),
  )
  if (missing_dut_endpoints.length > 0) {
    throw new ApplicationFixtureContractError(
      `documented typical application omits public U1 endpoints: ${missing_dut_endpoints.join(", ")}`,
    )
  }

  const components_by_reference = new Map(
    input.plan.components.map((component) => [componentKey(component.reference), component]),
  )
  const terminal_occurrences = new Map<
    string,
    Array<{ source_endpoint: string; terminal: string; node_group: ApplicationFixtureNodeGroup }>
  >()
  for (const node_group of node_groups) {
    for (const source_endpoint of node_group.source_endpoints) {
      const parsed = endpointParts(source_endpoint)
      if (!parsed || componentKey(parsed.reference) === "u1") continue
      const component = components_by_reference.get(componentKey(parsed.reference))
      if (!component) {
        throw new ApplicationFixtureContractError(
          `typical application endpoint ${source_endpoint} references an unlisted component`,
        )
      }
      const key = componentKey(component.reference)
      const existing = terminal_occurrences.get(key) ?? []
      existing.push({ source_endpoint, terminal: parsed.terminal, node_group })
      terminal_occurrences.set(key, existing)
    }
  }
  const external_components = input.plan.components.filter(
    ({ reference }) => componentKey(reference) !== "u1",
  )
  const fixtures: ApplicationPassiveFixture[] = []
  const non_executable_components: ApplicationNonExecutableComponent[] = []
  for (const component of external_components) {
    const endpoints = terminal_occurrences.get(componentKey(component.reference)) ?? []
    const type = passiveType(component.kind)
    if (!type) {
      non_executable_components.push(
        compileNonExecutableComponent({
          component,
          endpoints,
          reason: "unsupported_component_kind",
        }),
      )
      continue
    }
    if (endpoints.length !== 2) {
      throw new ApplicationFixtureContractError(
        `typical application ${type} ${component.reference} must have exactly two connected terminals; found ${endpoints.length}`,
      )
    }
    if (type !== "diode" && parseApplicationEngineeringValue(component.value) === undefined) {
      non_executable_components.push(
        compileNonExecutableComponent({
          component,
          endpoints,
          reason: "missing_positive_si_value",
        }),
      )
      continue
    }
    fixtures.push(compilePassiveFixture({ component, endpoints }))
  }
  if (new Set(fixtures.map(({ id }) => id)).size !== fixtures.length) {
    throw new ApplicationFixtureContractError(
      "typical application component references produce duplicate fixture identifiers",
    )
  }
  const payload: ApplicationFixtureContractPayload = {
    version: 1,
    availability: "documented",
    source_plan_sha256,
    source_pdf_sha256,
    target_component: "U1",
    ground_node_group_id: ground_group.id,
    node_groups,
    fixtures,
    ...(non_executable_components.length > 0 ? { non_executable_components } : {}),
  }
  return { ...payload, contract_sha256: hashApplicationFixtureContract(payload) }
}
