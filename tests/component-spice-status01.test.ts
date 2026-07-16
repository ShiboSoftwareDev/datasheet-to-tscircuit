import { expect, test } from "bun:test"
import type { ModelRun } from "@/shared/job-types"
import { getSpiceRecoveryAction, hasValidatedSpiceModel } from "@/web/components/component-spice-status"

const validatedRun = {
  status: "complete",
  model_source: ".subckt PART IN OUT",
  validation: { all_passed: true },
} as Pick<ModelRun, "status" | "model_source" | "validation">

test("only a completed, fully validated model is reported as SPICE available", () => {
  expect(hasValidatedSpiceModel(validatedRun)).toBe(true)
  expect(hasValidatedSpiceModel({ ...validatedRun, status: "timed_out" })).toBe(false)
  expect(hasValidatedSpiceModel({ ...validatedRun, status: "failed" })).toBe(false)
  expect(hasValidatedSpiceModel({ ...validatedRun, validation: undefined })).toBe(false)
  expect(getSpiceRecoveryAction("failed")).toBe("retry")
  expect(getSpiceRecoveryAction("timed_out")).toBe("extend")
  expect(getSpiceRecoveryAction("cancelled")).toBe("extend")
})
