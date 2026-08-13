import { expect, test } from "bun:test"
import { hasRepairCandidateBudget } from "@/server/model-workflow/repair-budget"

test("the first repair candidate may use any positive remaining budget", () => {
  expect(hasRepairCandidateBudget({ remaining_ms: 1, evaluated_candidate_ms: [] })).toBe(true)
  expect(hasRepairCandidateBudget({ remaining_ms: 0, evaluated_candidate_ms: [] })).toBe(false)
})

test("another repair reserves the slowest cycle and a bounded variability margin", () => {
  expect(
    hasRepairCandidateBudget({
      remaining_ms: 75_001,
      evaluated_candidate_ms: [40_000, 60_000, 35_000],
    }),
  ).toBe(true)
  expect(
    hasRepairCandidateBudget({
      remaining_ms: 75_000,
      evaluated_candidate_ms: [40_000, 60_000, 35_000],
    }),
  ).toBe(false)
  expect(
    hasRepairCandidateBudget({
      remaining_ms: 230_001,
      evaluated_candidate_ms: [200_000],
    }),
  ).toBe(true)
  expect(
    hasRepairCandidateBudget({
      remaining_ms: 230_000,
      evaluated_candidate_ms: [200_001],
    }),
  ).toBe(false)
})
