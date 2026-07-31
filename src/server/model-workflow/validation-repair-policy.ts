import type { ValidationExecutionError, ValidationRunResult } from "../spice-validation"

const REPAIRABLE_COMPARISON_CODES = new Set([
  "target_tolerance_exceeded",
  "bounds_exceeded",
  "curve_tolerance_exceeded",
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
