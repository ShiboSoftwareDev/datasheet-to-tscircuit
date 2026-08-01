import type { AnyCircuitElement } from "circuit-json"
import type {
  ValidationCase,
  ValidationExecutionError,
  ValidationSeriesResult,
} from "../../spice-validation/types"
import type { CircuitRecord } from "./types"

export function asRecord(element: AnyCircuitElement): CircuitRecord {
  return element as CircuitRecord
}

export function simulatorError(code: string, message: string, path?: string): ValidationExecutionError {
  return { kind: "simulator", code, message, ...(path ? { path } : {}) }
}

export function failedSeries(
  observation: ValidationCase["observations"][number],
  error: ValidationExecutionError,
): ValidationSeriesResult {
  return {
    observation_id: observation.id,
    type: observation.type,
    unit: observation.unit,
    scale: observation.scale,
    points: [],
    passed: false,
    metrics: { sample_count: 0 },
    errors: [error],
  }
}
