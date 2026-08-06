import type { ModelManifest } from "@/shared/job-types"
import type { ApplicationFixtureContract } from "./application-fixture-contract"

export type ModelFamily =
  | "passive"
  | "diode"
  | "bjt"
  | "mosfet"
  | "opamp"
  | "comparator"
  | "regulator"
  | "power_converter"
  | "sensor"
  | "digital_mixed_signal"
  | "other"

/** `vendor` is retained only so previously published contracts remain readable. */
export type ModelStrategyId = "vendor" | "equation" | "behavioral" | "hybrid"

export type ModelAnalysis = "operating_point" | "dc_sweep" | "transient"

export interface ModelSourceReference {
  page: number
  locator: string
  statement: string
  image?: string
}

export interface ModelReferencePoint {
  x: number
  y: number
}

export const MODEL_REFERENCE_CROP_DPI = 200 as const
export const MODEL_REFERENCE_CROP_MIN_WIDTH = 96
export const MODEL_REFERENCE_CROP_MIN_HEIGHT = 64

/** Exact graph bounds in the server's canonical 200-DPI rendering of a cited PDF page. */
export interface ModelReferenceCropRegion {
  page: number
  render_dpi: typeof MODEL_REFERENCE_CROP_DPI
  x_px: number
  y_px: number
  width_px: number
  height_px: number
}

/**
 * Public electrical endpoints that an independent datasheet graph can name.
 * Graph evidence cannot bind an agent-created fixture net: every non-ground
 * endpoint must resolve directly to one server-owned public SPICE pin.
 */
export type ModelPublicElectricalEndpoint = "gnd" | `dut.${string}`

export interface ModelReferencePulse {
  low: number
  high: number
  delay: number
  rise: number
  fall: number
  width: number
  period: number
}

/** A server-grounded static fixture required by the printed graph experiment. */
export type ModelReferenceAuxiliaryFixture =
  | {
      type: "dc_voltage"
      positive: ModelPublicElectricalEndpoint
      negative: ModelPublicElectricalEndpoint
      dc_volts: number
    }
  | {
      type: "dc_current"
      positive: ModelPublicElectricalEndpoint
      negative: ModelPublicElectricalEndpoint
      dc_amps: number
    }
  | {
      /**
       * Logical low is a zero-volt tie to ground. Logical high is a
       * zero-volt tie to the experiment's public input-supply endpoint.
       */
      type: "logic_state"
      endpoint: ModelPublicElectricalEndpoint
      reference: ModelPublicElectricalEndpoint
      state: "low" | "high"
    }
  | {
      type: "resistor"
      positive: ModelPublicElectricalEndpoint
      negative: ModelPublicElectricalEndpoint
      resistance_ohms: number
    }

export type ModelReferenceStimulus =
  | { type: "steady_state"; positive?: never; negative?: never; pulse?: never }
  | {
      type: "voltage_step" | "current_step"
      positive: ModelPublicElectricalEndpoint
      negative: ModelPublicElectricalEndpoint
      /**
       * Observer-owned SI fixture. Levels and visible edge timing come from the
       * cited plot/conditions; width and period may extend a single documented
       * edge beyond the plotted window so the harness cannot add a second edge.
       */
      pulse: ModelReferencePulse
    }

/** Immutable electrical meaning of a fresh voltage-versus-time reference graph. */
export interface ModelReferenceElectricalBinding {
  /** Digest of the server-compiled canonical typical-application fixture. */
  application_fixture_sha256?: string
  /** Digest of the exact per-experiment topology after condition overlays. */
  application_topology_sha256?: string
  response: {
    type: "voltage"
    positive: ModelPublicElectricalEndpoint
    negative: ModelPublicElectricalEndpoint
    /** Printed operating-point voltage; this constrains the response and is never a clamp fixture. */
    nominal_volts?: number
  }
  /** A public-pin step, or a static operating setup sampled with transient analysis. */
  stimulus: ModelReferenceStimulus
  /** Exact static conditions printed for the graph experiment. Omitted only by legacy contracts. */
  auxiliary_fixtures?: ModelReferenceAuxiliaryFixture[]
}

export interface ModelRequirement {
  requirement_id: string
  title: string
  behavior: string
  analysis: ModelAnalysis
  support: { status: "modeled" } | { status: "documented_only"; reason: string }
  conditions: Record<string, string | number | boolean>
  expected: {
    unit: string
    target?: number
    min?: number
    max?: number
    /** Absolute scalar tolerance extracted into the canonical contract. */
    tolerance?: number
  }
  reference_curve?: {
    x_quantity: string
    x_unit: string
    y_quantity: string
    y_unit: string
    points: ModelReferencePoint[]
    /** Maximum normalized curve error. Defaults to five percent. */
    tolerance?: number
    crop?: ModelReferenceCropRegion
    image?: string
    /** Required for fresh curves; optional only when reading persisted legacy v1 contracts. */
    electrical_binding?: ModelReferenceElectricalBinding
  }
  sources: ModelSourceReference[]
}

/** Agent-authored characterization. The electrical interface is server-owned. */
export interface ModelCharacterization {
  version: 1
  family: ModelFamily
  strategy: ModelStrategyId
  requirements: ModelRequirement[]
  assumptions: string[]
  limitations: string[]
}

export interface ModelInterfacePin {
  physical_pin: string
  component_pin: string
  source_port_id: string
  spice_node: string
  labels: string[]
  role: string
}

export interface ModelInterface {
  version: 1
  part_number: string
  entry_name: string
  pins: ModelInterfacePin[]
}

/** Canonical, versioned handoff between datasheet analysis and all model stages. */
export interface ModelContract {
  version: 1
  interface: ModelInterface
  characterization: ModelCharacterization
  /** Required on fresh contracts; omitted only by retained legacy version-1 artifacts. */
  application_fixture?: ApplicationFixtureContract
}

export interface GeneratedModel {
  source: string
  card: string
  manifest: ModelManifest
}
