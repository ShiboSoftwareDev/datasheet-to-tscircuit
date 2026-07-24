import { expect, test } from "bun:test"
import type { ModelRun } from "@/shared/job-types"
import { getModelMatchMetrics } from "@/web/components/model-panel"

test("model header derives match percentage from authoritative normalized RMSE", () => {
  const metrics = getModelMatchMetrics({
    validation: {
      benchmark_count: 2,
      passing_count: 1,
      critical_count: 1,
      critical_passing_count: 1,
      score: 0.4,
      worst_normalized_error: 0.75,
      all_critical_passed: true,
      all_passed: false,
      benchmarks: [],
    },
    progress: {
      sequence: 2,
      phase: "complete",
      message: "Complete",
      updated_at: "2026-07-22T00:00:00.000Z",
      champion: { score: 0.2 },
    },
  } as unknown as ModelRun)

  expect(metrics.normalized_rmse).toBe(0.4)
  expect(metrics.match_score).toBe(0.6)
})

test("model header clamps derived match percentage at zero", () => {
  const metrics = getModelMatchMetrics({
    progress: {
      sequence: 1,
      phase: "scoring",
      message: "Scoring",
      updated_at: "2026-07-22T00:00:00.000Z",
      champion: { score: 1.25 },
    },
  } as unknown as ModelRun)

  expect(metrics.normalized_rmse).toBe(1.25)
  expect(metrics.match_score).toBe(0)
})

test("model header withholds match claims from completed output with warnings", () => {
  const metrics = getModelMatchMetrics({
    is_complete: true,
    warnings: [
      "Evidence quality: response references are duplicated, so the result is available but unverified.",
    ],
    validation: {
      benchmark_count: 2,
      passing_count: 2,
      critical_count: 1,
      critical_passing_count: 1,
      score: 0.01,
      worst_normalized_error: 0.02,
      all_critical_passed: true,
      all_passed: true,
      benchmarks: [],
    },
  } as unknown as ModelRun)

  expect(metrics.normalized_rmse).toBeUndefined()
  expect(metrics.match_score).toBeUndefined()
})
