import type { AnyCircuitElement } from "circuit-json"
import type { ValidationExecutionError, ValidationSeriesResult } from "../../spice-validation/types"

export type CircuitRecord = AnyCircuitElement & Record<string, unknown>

export interface ViewerSimulationValidation {
  /** True when tscircuit produced a complete, traceable waveform, regardless of tolerance. */
  simulation_valid: boolean
  passed: boolean
  series: ValidationSeriesResult[]
  errors: ValidationExecutionError[]
}
