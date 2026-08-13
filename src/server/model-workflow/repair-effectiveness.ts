import type { CandidateQuality } from "./candidate-quality"
import { compareCandidateQuality } from "./candidate-quality"
import type { RepairTarget } from "./repair-candidate"

export interface RepairCandidateEvaluation {
  readonly attempt: number
  readonly target: RepairTarget
  readonly revision: string
  readonly outcome: "promoted" | "rejected"
  readonly quality: CandidateQuality
}

interface SerializableCandidateQuality {
  readonly passed: boolean
  readonly non_repairable_error_count: number
  readonly causality_failure_count: number
  readonly viewer_unavailable_count: number
  readonly failed_case_count: number
  readonly failed_series_count: number
  readonly worst_normalized_error: number | null
  readonly mean_normalized_error: number | null
}

export interface RepairEffectivenessReport {
  readonly version: 1
  readonly baseline_revision: string
  readonly final_revision: string
  readonly outcome: "target_met" | "improved" | "unchanged"
  readonly target_met: boolean
  readonly quality_improved: boolean
  readonly revision_changed: boolean
  readonly attempted_candidate_count: number
  readonly evaluated_candidate_count: number
  readonly promoted_candidate_count: number
  readonly rejected_candidate_count: number
  readonly unevaluated_candidate_count: number
  readonly repair_elapsed_ms: number
  readonly repair_budget_ms: number
  readonly baseline_quality: SerializableCandidateQuality
  readonly final_quality: SerializableCandidateQuality
  readonly candidates: ReadonlyArray<{
    readonly attempt: number
    readonly target: RepairTarget
    readonly revision: string
    readonly outcome: "promoted" | "rejected"
    readonly quality: SerializableCandidateQuality
  }>
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null
}

function serializeQuality(quality: CandidateQuality): SerializableCandidateQuality {
  return {
    passed: quality.passed,
    non_repairable_error_count: quality.non_repairable_error_count,
    causality_failure_count: quality.causality_failure_count,
    viewer_unavailable_count: quality.viewer_unavailable_count,
    failed_case_count: quality.failed_case_count,
    failed_series_count: quality.failed_series_count,
    worst_normalized_error: finiteOrNull(quality.worst_normalized_error),
    mean_normalized_error: finiteOrNull(quality.mean_normalized_error),
  }
}

export function createRepairEffectivenessReport(input: {
  baseline_revision: string
  final_revision: string
  baseline_quality: CandidateQuality
  final_quality: CandidateQuality
  attempted_candidate_count: number
  repair_elapsed_ms: number
  repair_budget_ms: number
  candidates: readonly RepairCandidateEvaluation[]
}): RepairEffectivenessReport {
  const quality_improved = compareCandidateQuality(input.final_quality, input.baseline_quality) < 0
  const target_met = input.final_quality.passed
  const promoted_candidate_count = input.candidates.filter(({ outcome }) => outcome === "promoted").length
  const rejected_candidate_count = input.candidates.length - promoted_candidate_count
  return {
    version: 1,
    baseline_revision: input.baseline_revision,
    final_revision: input.final_revision,
    outcome: target_met ? "target_met" : quality_improved ? "improved" : "unchanged",
    target_met,
    quality_improved,
    revision_changed: input.final_revision !== input.baseline_revision,
    attempted_candidate_count: input.attempted_candidate_count,
    evaluated_candidate_count: input.candidates.length,
    promoted_candidate_count,
    rejected_candidate_count,
    unevaluated_candidate_count: Math.max(0, input.attempted_candidate_count - input.candidates.length),
    repair_elapsed_ms: input.repair_elapsed_ms,
    repair_budget_ms: input.repair_budget_ms,
    baseline_quality: serializeQuality(input.baseline_quality),
    final_quality: serializeQuality(input.final_quality),
    candidates: input.candidates.map((candidate) => ({
      attempt: candidate.attempt,
      target: candidate.target,
      revision: candidate.revision,
      outcome: candidate.outcome,
      quality: serializeQuality(candidate.quality),
    })),
  }
}

export async function writeRepairEffectivenessReport(input: {
  path: string
  report: RepairEffectivenessReport
}): Promise<void> {
  await Bun.write(input.path, `${JSON.stringify(input.report, null, 2)}\n`)
}
