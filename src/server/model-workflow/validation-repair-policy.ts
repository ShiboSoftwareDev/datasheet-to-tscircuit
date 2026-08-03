import type { ValidationExecutionError, ValidationRunResult } from "../spice-validation"

const REPAIRABLE_COMPARISON_CODES = new Set([
  "target_tolerance_exceeded",
  "bounds_exceeded",
  "curve_tolerance_exceeded",
  "bound_stimulus_insensitive",
  "invalid_log_sample",
  "non_finite_series",
])

export function isModelRepairableValidationError(error: ValidationExecutionError): boolean {
  if (error.kind === "convergence") return true
  if (error.kind === "simulator") return error.code === "ngspice_failed"
  return error.kind === "comparison" && REPAIRABLE_COMPARISON_CODES.has(error.code)
}

export function getNonRepairableValidationErrors(result: ValidationRunResult): ValidationExecutionError[] {
  return result.errors.filter((error) => !isModelRepairableValidationError(error))
}

export type ValidationInfrastructureFailure =
  | { source: "server_validation"; errors: ValidationExecutionError[] }
  | { source: "tscircuit_viewer"; failures: Array<{ case_id: string; message: string }> }

/**
 * Selects the primary non-model failure after UI artifacts have been retained.
 * Direct simulator/contract failures take precedence because a downstream
 * viewer failure is often only their consequence.
 */
export function classifyValidationInfrastructureFailure(input: {
  result: ValidationRunResult
  viewer_failures: ReadonlyArray<{ case_id: string; message: string }>
}): ValidationInfrastructureFailure | undefined {
  const errors = getNonRepairableValidationErrors(input.result)
  if (errors.length > 0) return { source: "server_validation", errors }
  if (input.viewer_failures.length > 0) {
    return { source: "tscircuit_viewer", failures: input.viewer_failures.map((failure) => ({ ...failure })) }
  }
  return undefined
}
