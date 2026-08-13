import { expect, test } from "bun:test"
import type { CandidateQuality } from "@/server/model-workflow/candidate-quality"
import { createRepairEffectivenessReport } from "@/server/model-workflow/repair-effectiveness"

function quality(input: Partial<CandidateQuality> = {}): CandidateQuality {
  return {
    passed: false,
    non_repairable_error_count: 0,
    causality_failure_count: 0,
    viewer_unavailable_count: 0,
    failed_case_count: 3,
    failed_series_count: 4,
    worst_normalized_error: 2,
    mean_normalized_error: 1,
    ...input,
  }
}

test("repair effectiveness reports only server-ranked quality improvements", () => {
  const baseline = quality()
  const rejected = quality({ worst_normalized_error: 3 })
  const promoted = quality({ failed_case_count: 2, failed_series_count: 3 })
  const report = createRepairEffectivenessReport({
    baseline_revision: "baseline",
    final_revision: "promoted",
    baseline_quality: baseline,
    final_quality: promoted,
    attempted_candidate_count: 3,
    repair_elapsed_ms: 299_000,
    repair_budget_ms: 300_000,
    candidates: [
      { attempt: 1, target: "model", revision: "rejected", outcome: "rejected", quality: rejected },
      { attempt: 2, target: "tsx", revision: "promoted", outcome: "promoted", quality: promoted },
    ],
  })

  expect(report).toMatchObject({
    outcome: "improved",
    target_met: false,
    quality_improved: true,
    revision_changed: true,
    attempted_candidate_count: 3,
    evaluated_candidate_count: 2,
    promoted_candidate_count: 1,
    rejected_candidate_count: 1,
    unevaluated_candidate_count: 1,
    baseline_quality: { failed_case_count: 3 },
    final_quality: { failed_case_count: 2 },
  })
})

test("a different revision without a quality gain is explicitly unchanged", () => {
  const baseline = quality({ worst_normalized_error: Number.POSITIVE_INFINITY })
  const report = createRepairEffectivenessReport({
    baseline_revision: "baseline",
    final_revision: "different",
    baseline_quality: baseline,
    final_quality: baseline,
    attempted_candidate_count: 1,
    repair_elapsed_ms: 10,
    repair_budget_ms: 100,
    candidates: [
      { attempt: 1, target: "both", revision: "different", outcome: "rejected", quality: baseline },
    ],
  })

  expect(report.outcome).toBe("unchanged")
  expect(report.quality_improved).toBe(false)
  expect(report.revision_changed).toBe(true)
  expect(report.baseline_quality.worst_normalized_error).toBeNull()
})
