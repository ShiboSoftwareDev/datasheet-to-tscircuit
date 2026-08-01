import { expect, test } from "bun:test"
import { type ModelCompletionIntegrityInput, validateModelCompletionIntegrity } from "@/server/modeling"

type PolicyField = Pick<ModelCompletionIntegrityInput, "policy">
type PolicyIsRequired = PolicyField extends Required<PolicyField> ? true : false

const policy_is_required: PolicyIsRequired = true

const empty_integrity_input = {
  model_source: undefined,
  manifest: undefined,
  contract: undefined,
  plan: undefined,
  result: undefined,
}

test("completion integrity requires an explicit supported policy at compile time and runtime", () => {
  expect(policy_is_required).toBe(true)

  for (const policy of [undefined, "freshish_compatibility"]) {
    const result = validateModelCompletionIntegrity({
      ...empty_integrity_input,
      policy,
    } as unknown as ModelCompletionIntegrityInput)
    expect(result).toEqual({
      valid: false,
      reason: "model completion integrity policy must be fresh_time_voltage_v1 or legacy_compatibility",
    })
  }

  expect(
    validateModelCompletionIntegrity({
      ...empty_integrity_input,
      policy: "legacy_compatibility",
    }),
  ).toEqual({ valid: false, reason: "no passing server-owned validation result is present" })
})
