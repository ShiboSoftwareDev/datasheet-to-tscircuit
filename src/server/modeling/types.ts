import type { ModelManifest } from "@/shared/job-types"

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
    image?: string
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
}

export interface GeneratedModel {
  source: string
  card: string
  manifest: ModelManifest
}
