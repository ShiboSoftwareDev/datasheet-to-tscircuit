/**
 * Avoids starting an agent edit that the current repair budget cannot validate.
 * Completed generate-and-validate cycles supply the only local timing evidence.
 * Reserve the slower observed cycle plus a bounded variability margin so an
 * unusually fast recent edit cannot admit a candidate that validation cannot
 * finish. The first candidate still receives any positive available budget.
 */
export function hasRepairCandidateBudget(input: {
  remaining_ms: number
  evaluated_candidate_ms: readonly number[]
}): boolean {
  if (input.remaining_ms <= 0) return false
  if (input.evaluated_candidate_ms.length === 0) return true
  const slowest_cycle_ms = Math.max(...input.evaluated_candidate_ms)
  const variability_margin_ms = Math.min(30_000, Math.ceil(slowest_cycle_ms / 4))
  return input.remaining_ms > slowest_cycle_ms + variability_margin_ms
}
