import { expect, test } from "bun:test"
import { hasRepairCandidateBudget } from "@/server/model-workflow/repair-budget"

test("the first repair candidate may use any positive remaining budget", () => {
  expect(hasRepairCandidateBudget({ remaining_ms: 1 })).toBe(true)
  expect(hasRepairCandidateBudget({ remaining_ms: 0 })).toBe(false)
})

test("another repair starts only when its last complete cycle fits", () => {
  expect(
    hasRepairCandidateBudget({
      remaining_ms: 60_001,
      last_evaluated_candidate_ms: 60_000,
    }),
  ).toBe(true)
  expect(
    hasRepairCandidateBudget({
      remaining_ms: 60_000,
      last_evaluated_candidate_ms: 60_000,
    }),
  ).toBe(false)
  expect(
    hasRepairCandidateBudget({
      remaining_ms: 30_000,
      last_evaluated_candidate_ms: 60_000,
    }),
  ).toBe(false)
})
