import { expect, test } from "bun:test"
import {
  classifyValidationInfrastructureFailure,
  getNonRepairableValidationErrors,
  isModelRepairableValidationError,
} from "@/server/model-workflow"
import type { ValidationExecutionError, ValidationRunResult } from "@/server/spice-validation"

function error(kind: ValidationExecutionError["kind"], code: string): ValidationExecutionError {
  return { kind, code, message: `${kind}:${code}` }
}

test("model repair is reserved for model-behavior and convergence failures", () => {
  expect(isModelRepairableValidationError(error("comparison", "bounds_exceeded"))).toBe(true)
  expect(isModelRepairableValidationError(error("convergence", "ngspice_convergence_failed"))).toBe(true)
  expect(isModelRepairableValidationError(error("simulator", "ngspice_failed"))).toBe(true)

  expect(isModelRepairableValidationError(error("contract", "validation_plan_invalid"))).toBe(false)
  expect(isModelRepairableValidationError(error("simulator", "raw_processing_failed"))).toBe(false)
  expect(isModelRepairableValidationError(error("cancelled", "validation_cancelled"))).toBe(false)
})

test("non-repairable validation failures are returned without hiding repairable peers", () => {
  const errors = [
    error("comparison", "target_tolerance_exceeded"),
    error("contract", "observation_reference_invalid"),
    error("simulator", "missing_raw_vector"),
  ]
  const result: ValidationRunResult = {
    version: 1,
    passed: false,
    hashes: {
      plan_sha256: "a".repeat(64),
      model_sha256: "b".repeat(64),
      manifest_sha256: "c".repeat(64),
    },
    cases: [],
    errors,
  }

  expect(getNonRepairableValidationErrors(result)).toEqual(errors.slice(1))
  expect(
    classifyValidationInfrastructureFailure({
      result,
      viewer_failures: [{ case_id: "startup", message: "tsci build failed" }],
    }),
  ).toEqual({ source: "server_validation", errors: errors.slice(1) })
})

test("viewer infrastructure is primary only when direct validation has no non-repairable fault", () => {
  const result: ValidationRunResult = {
    version: 1,
    passed: false,
    hashes: {
      plan_sha256: "a".repeat(64),
      model_sha256: "b".repeat(64),
      manifest_sha256: "c".repeat(64),
    },
    cases: [],
    errors: [error("comparison", "curve_tolerance_exceeded")],
  }
  const viewer_failures = [{ case_id: "startup", message: "tsci build failed" }]

  expect(classifyValidationInfrastructureFailure({ result, viewer_failures })).toEqual({
    source: "tscircuit_viewer",
    failures: viewer_failures,
  })
})
