import type { ModelFamily, ModelInterface, ModelRequirement } from "@/server/modeling/types"
import type {
  ApplicationFixtureContract,
  ResolvedApplicationFixture,
} from "@/server/modeling/application-fixture-contract"
import type { ModelManifest } from "@/shared/job-types"

export type SpiceEndpoint = "gnd" | `dut.${string}` | `net.${string}`

export interface PulseSpecification {
  low: number
  high: number
  delay: number
  rise: number
  fall: number
  width: number
  period: number
}

interface FixtureElementBase {
  id: string
}

interface TwoTerminalFixtureElement extends FixtureElementBase {
  positive: SpiceEndpoint
  negative: SpiceEndpoint
}

export interface ResistorFixture extends TwoTerminalFixtureElement {
  type: "resistor"
  resistance_ohms: number
}

export interface CapacitorFixture extends TwoTerminalFixtureElement {
  type: "capacitor"
  capacitance_farads: number
}

export interface InductorFixture extends TwoTerminalFixtureElement {
  type: "inductor"
  inductance_henries: number
}

export interface VoltageSourceFixture extends TwoTerminalFixtureElement {
  type: "voltage_source"
  dc_volts: number
  pulse?: PulseSpecification
}

export interface CurrentSourceFixture extends TwoTerminalFixtureElement {
  type: "current_source"
  dc_amps: number
  pulse?: PulseSpecification
}

export interface DiodeFixture extends FixtureElementBase {
  type: "diode"
  anode: SpiceEndpoint
  cathode: SpiceEndpoint
}

export type FixtureElement =
  | ResistorFixture
  | CapacitorFixture
  | InductorFixture
  | VoltageSourceFixture
  | CurrentSourceFixture
  | DiodeFixture

export type ValidationAnalysis =
  | { type: "operating_point" }
  | {
      type: "dc_sweep"
      source_id: string
      start: number
      stop: number
      step: number
    }
  | {
      type: "transient"
      step: number
      stop: number
      start?: number
    }

export interface ValidationEvidence {
  page?: number
  image?: string
  metadata?: Record<string, string>
}

export type ReferenceContract =
  | {
      type: "target"
      target: number
      tolerance: number
    }
  | {
      type: "bounds"
      min?: number
      max?: number
    }
  | {
      type: "curve"
      tolerance: number
      points: Array<{ x: number; y: number }>
    }

interface ObservationBase {
  id: string
  /** The immutable contract requirement that owns this comparison. */
  requirement_id: string
  scale: "linear" | "log"
  reference: ReferenceContract
  evidence?: ValidationEvidence
}

export interface VoltageObservation extends ObservationBase {
  type: "voltage"
  positive: SpiceEndpoint
  negative: SpiceEndpoint
  unit: "V"
}

export interface CurrentObservation extends ObservationBase {
  type: "current"
  element_id: string
  unit: "A"
}

export type ValidationObservation = VoltageObservation | CurrentObservation

export interface ValidationCase {
  id: string
  title?: string
  requirement_ids: string[]
  nets: string[]
  fixtures: FixtureElement[]
  analysis: ValidationAnalysis
  observations: ValidationObservation[]
  /** Server-injected exact application topology for a fresh bound experiment. */
  application_fixture?: ResolvedApplicationFixture
}

export interface ValidationPlan {
  version: 1
  model: {
    entry_name: string
    pins: string[]
  }
  cases: ValidationCase[]
}

export interface ValidationPathError {
  path: string
  code: string
  message: string
}

export type ValidationErrorKind = "contract" | "simulator" | "convergence" | "comparison" | "cancelled"

export interface ValidationExecutionError {
  kind: ValidationErrorKind
  code: string
  message: string
  path?: string
}

export interface RawVariable {
  index: number
  name: string
  data_type: string
}

export interface RawPlot {
  title: string
  plot_name: string
  flags: string[]
  variables: RawVariable[]
  rows: number[][]
}

export interface ParsedRawFile {
  plots: RawPlot[]
}

export interface ValidationSeriesPoint {
  x: number
  y: number
}

export interface CompiledObservation {
  observation: ValidationObservation
  positive_node?: string
  negative_node?: string
  element_name?: string
  saved_vectors: string[]
}

export interface CompiledValidationCase {
  case_id: string
  source: string
  observations: CompiledObservation[]
  element_names: Record<string, string>
}

export interface ObservationComparisonMetrics {
  sample_count: number
  normalized_rmse?: number
  normalized_max_error?: number
  max_absolute_error?: number
}

export interface ValidationSeriesResult {
  observation_id: string
  type: ValidationObservation["type"]
  unit: "V" | "A"
  scale: "linear" | "log"
  points: ValidationSeriesPoint[]
  passed: boolean
  metrics: ObservationComparisonMetrics
  errors: ValidationExecutionError[]
}

export interface ValidationCaseResult {
  case_id: string
  status: "passed" | "failed" | "cancelled"
  analysis: ValidationAnalysis["type"]
  series: ValidationSeriesResult[]
  errors: ValidationExecutionError[]
  elapsed_ms: number
  netlist_sha256: string
  raw_sha256?: string
}

export interface ValidationInputHashes {
  plan_sha256: string
  model_sha256: string
  manifest_sha256: string
}

/** Server-owned proof that dynamic output depends materially on the bound electrical step. */
export interface ValidationStimulusCausalityReceipt {
  version: 1
  method: "bound_pulse_flatten_v2"
  status: "passed"
  hashes: ValidationInputHashes
  checked_case_count: number
  checked_observation_count: number
}

export interface ValidationRunResult {
  version: 1
  passed: boolean
  hashes: ValidationInputHashes
  cases: ValidationCaseResult[]
  errors: ValidationExecutionError[]
  /** Present on fresh time-domain results only after the private flattened-stimulus check passes. */
  stimulus_causality?: ValidationStimulusCausalityReceipt
}

export type ValidationAppendLogger = (
  stream: "system" | "stdout" | "stderr",
  message: string,
) => void | Promise<void>

interface ValidationContextBase {
  model_requirements: readonly ModelRequirement[]
  model_source?: string
  model_family?: ModelFamily
  application_fixture?: ApplicationFixtureContract
}

export type ValidationContext = ValidationContextBase &
  (
    | { manifest: ModelManifest; model_interface?: never }
    | { model_interface: ModelInterface; manifest?: never }
  )
