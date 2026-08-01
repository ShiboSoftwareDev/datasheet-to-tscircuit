import { stableStringify } from "../../spice-validation/hashing"
import type { ModelPublicElectricalEndpoint, ModelReferenceElectricalBinding } from "../types"
import { hashResolvedApplicationFixture } from "./hashing"
import { parseApplicationFixtureContract } from "./parser"
import { record, requiredSha256 } from "./schema-helpers"
import {
  ApplicationConditionConflictError,
  ApplicationFixtureContractError,
  type ApplicationConditionOverlay,
  type ApplicationFixtureContract,
  type ResolvedApplicationFixture,
  type ResolvedApplicationFixturePayload,
  type ResolvedApplicationNodeGroup,
} from "./types"

function conditionConflict(message: string, endpoint?: ModelPublicElectricalEndpoint): never {
  throw new ApplicationConditionConflictError(message, endpoint)
}

function hasExecutableAnchorAfterDetach(group: ResolvedApplicationNodeGroup): boolean {
  return group.is_ground || group.dut_endpoints.length > 0
}

/**
 * Applies only explicit logic-state conditions. A detachable leaf is one atomic,
 * uniquely mapped U1 endpoint whose removal leaves its original application node
 * electrically anchored by ground or another U1 pin. This prevents an override
 * from silently orphaning a required passive branch.
 */
export function resolveApplicationFixtureForBinding(input: {
  contract: ApplicationFixtureContract
  binding: ModelReferenceElectricalBinding
}): ResolvedApplicationFixture {
  const contract = parseApplicationFixtureContract(input.contract)
  if (contract.availability !== "documented") {
    conditionConflict("a reference experiment cannot use an unavailable typical-application fixture")
  }
  const groups: ResolvedApplicationNodeGroup[] = contract.node_groups.map((group) => ({
    id: group.id,
    source_net: group.source_net,
    is_ground: group.is_ground,
    dut_endpoints: [...group.dut_endpoints],
    external_terminals: [...group.external_terminals],
  }))
  const condition_overlays: ApplicationConditionOverlay[] = []
  const conditioned_endpoints = new Set<ModelPublicElectricalEndpoint>()
  for (const fixture of input.binding.auxiliary_fixtures ?? []) {
    if (fixture.type !== "logic_state") continue
    const endpoint = fixture.endpoint
    if (endpoint === "gnd") {
      conditionConflict("logic-state condition cannot detach the global ground endpoint", endpoint)
    }
    if (conditioned_endpoints.has(endpoint)) {
      conditionConflict(`logic-state endpoint ${endpoint} is conditioned more than once`, endpoint)
    }
    conditioned_endpoints.add(endpoint)
    if (fixture.reference === endpoint) {
      conditionConflict(`logic-state endpoint ${endpoint} cannot reference itself`, endpoint)
    }
    if (fixture.state === "low" && fixture.reference !== "gnd") {
      conditionConflict(`logic-low endpoint ${endpoint} must reference gnd`, endpoint)
    }
    if (fixture.state === "high" && fixture.reference === "gnd") {
      conditionConflict(`logic-high endpoint ${endpoint} must reference a public supply endpoint`, endpoint)
    }
    const containing_groups = groups.filter((group) => group.dut_endpoints.includes(endpoint))
    if (containing_groups.length !== 1) {
      conditionConflict(
        `logic-state endpoint ${endpoint} belongs to ${containing_groups.length} application node groups; expected one uniquely detachable U1 leaf`,
        endpoint,
      )
    }
    if (
      fixture.reference !== "gnd" &&
      !groups.some((group) => group.dut_endpoints.includes(fixture.reference))
    ) {
      conditionConflict(
        `logic-state reference ${fixture.reference} is not present in the application topology`,
        endpoint,
      )
    }
    const containing_group = containing_groups[0]!
    containing_group.dut_endpoints = containing_group.dut_endpoints.filter(
      (candidate) => candidate !== endpoint,
    )
    if (!hasExecutableAnchorAfterDetach(containing_group)) {
      conditionConflict(
        `logic-state endpoint ${endpoint} is the only electrical anchor for non-ground application node ${containing_group.source_net}; detaching it would orphan a required passive/network`,
        endpoint,
      )
    }
    condition_overlays.push({
      type: "logic_state",
      endpoint,
      reference: fixture.reference,
      state: fixture.state,
      detached_from_node_group_id: containing_group.id,
    })
  }
  for (const overlay of condition_overlays) {
    if (
      overlay.reference !== "gnd" &&
      !groups.some((group) => group.dut_endpoints.includes(overlay.reference))
    ) {
      conditionConflict(
        `logic-state reference ${overlay.reference} was detached by another condition and no longer anchors the application topology`,
        overlay.endpoint,
      )
    }
  }
  const payload: ResolvedApplicationFixturePayload = {
    version: 1,
    contract_sha256: contract.contract_sha256,
    node_groups: groups,
    fixtures: contract.fixtures.map((fixture) => ({
      ...fixture,
      source_terminals: [...fixture.source_terminals] as [string, string],
    })),
    condition_overlays,
  }
  return { ...payload, topology_sha256: hashResolvedApplicationFixture(payload) }
}

export function assertResolvedApplicationFixtureMatches(input: {
  value: unknown
  contract: ApplicationFixtureContract
  binding: ModelReferenceElectricalBinding
  path?: string
}): ResolvedApplicationFixture {
  const expected = resolveApplicationFixtureForBinding({
    contract: input.contract,
    binding: input.binding,
  })
  const path = input.path ?? "resolved_application_fixture"
  const actual = record(input.value, path)
  const topology_sha256 = requiredSha256(actual.topology_sha256, `${path}.topology_sha256`)
  if (topology_sha256 !== expected.topology_sha256 || stableStringify(input.value) !== stableStringify(expected)) {
    throw new ApplicationFixtureContractError(
      `${path} must exactly match server-resolved application topology ${expected.topology_sha256}`,
    )
  }
  return expected
}
