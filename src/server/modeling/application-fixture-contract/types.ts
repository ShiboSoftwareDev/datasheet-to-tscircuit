import type { TypicalApplicationPlan } from "../../component-workflow/application-plan"
import type { ModelPublicElectricalEndpoint } from "../types"

export const APPLICATION_FIXTURE_CONTRACT_VERSION = 1 as const
export const RESOLVED_APPLICATION_FIXTURE_VERSION = 1 as const

export type ApplicationFixtureNodeEndpoint = "gnd" | `net.${string}`

export interface ApplicationFixtureNodeGroup {
  id: string
  source_net: string
  is_ground: boolean
  source_endpoints: string[]
  dut_endpoints: ModelPublicElectricalEndpoint[]
  external_terminals: string[]
}

interface ApplicationPassiveBase {
  id: string
  reference: string
  source_terminals: [string, string]
}

export type ApplicationPassiveFixture =
  | (ApplicationPassiveBase & {
      type: "resistor"
      positive: ApplicationFixtureNodeEndpoint
      negative: ApplicationFixtureNodeEndpoint
      resistance_ohms: number
    })
  | (ApplicationPassiveBase & {
      type: "capacitor"
      positive: ApplicationFixtureNodeEndpoint
      negative: ApplicationFixtureNodeEndpoint
      capacitance_farads: number
    })
  | (ApplicationPassiveBase & {
      type: "inductor"
      positive: ApplicationFixtureNodeEndpoint
      negative: ApplicationFixtureNodeEndpoint
      inductance_henries: number
    })
  | (ApplicationPassiveBase & {
      type: "diode"
      anode: ApplicationFixtureNodeEndpoint
      cathode: ApplicationFixtureNodeEndpoint
    })

export type ApplicationNonExecutableReason = "unsupported_component_kind" | "missing_positive_si_value"

/**
 * A source-documented application component whose connectivity remains bound by
 * the source-plan hash, but which cannot be projected into the supported passive
 * SPICE subset without inventing behavior or a value.
 */
export interface ApplicationNonExecutableComponent {
  reference: string
  kind: string
  source_terminals: string[]
  reason: ApplicationNonExecutableReason
}

export interface ApplicationFixtureContractPayload {
  version: typeof APPLICATION_FIXTURE_CONTRACT_VERSION
  availability: TypicalApplicationPlan["availability"]
  source_plan_sha256: string
  source_pdf_sha256: string
  target_component: "U1"
  ground_node_group_id: string | null
  node_groups: ApplicationFixtureNodeGroup[]
  fixtures: ApplicationPassiveFixture[]
  non_executable_components?: ApplicationNonExecutableComponent[]
}

/**
 * Server-owned, executable projection of the canonical TypicalApplicationPlan.
 * Its digest excludes only the digest field itself.
 */
export interface ApplicationFixtureContract extends ApplicationFixtureContractPayload {
  contract_sha256: string
}

export interface ApplicationConditionOverlay {
  type: "logic_state"
  endpoint: ModelPublicElectricalEndpoint
  reference: ModelPublicElectricalEndpoint
  state: "low" | "high"
  detached_from_node_group_id: string
}

export interface ResolvedApplicationNodeGroup {
  id: string
  source_net: string
  is_ground: boolean
  dut_endpoints: ModelPublicElectricalEndpoint[]
  external_terminals: string[]
}

export interface ResolvedApplicationFixturePayload {
  version: typeof RESOLVED_APPLICATION_FIXTURE_VERSION
  contract_sha256: string
  node_groups: ResolvedApplicationNodeGroup[]
  fixtures: ApplicationPassiveFixture[]
  condition_overlays: ApplicationConditionOverlay[]
}

/** Exact topology for one printed experiment after detachable conditions are applied. */
export interface ResolvedApplicationFixture extends ResolvedApplicationFixturePayload {
  topology_sha256: string
}

export class ApplicationFixtureContractError extends Error {
  readonly code = "application_fixture_contract_invalid" as const

  constructor(message: string) {
    super(message)
    this.name = "ApplicationFixtureContractError"
  }
}

export class ApplicationConditionConflictError extends Error {
  readonly code = "application_condition_conflict" as const
  readonly endpoint?: ModelPublicElectricalEndpoint

  constructor(message: string, endpoint?: ModelPublicElectricalEndpoint) {
    super(message)
    this.name = "ApplicationConditionConflictError"
    this.endpoint = endpoint
  }
}
