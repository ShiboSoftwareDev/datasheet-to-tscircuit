/**
 * Avoids starting an agent edit that the current repair budget cannot validate.
 * The most recent complete generate-and-validate cycle is the closest local
 * estimate; the first candidate always receives the available positive budget.
 */
export function hasRepairCandidateBudget(input: {
  remaining_ms: number
  last_evaluated_candidate_ms?: number
}): boolean {
  if (input.remaining_ms <= 0) return false
  if (input.last_evaluated_candidate_ms === undefined) return true
  return input.remaining_ms > input.last_evaluated_candidate_ms
}
