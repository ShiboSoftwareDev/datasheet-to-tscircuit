import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ModelRun } from "@/shared/job-types"
import { RETAINED_ACCEPTED_WARNING_PREFIX } from "@/shared/model-warnings"
import {
  getModelHeaderStats,
  getModelMatchMetrics,
  ModelCandidateProvenance,
  ModelValidationScope,
} from "@/web/components/model-panel"

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

test("model header withholds stale metrics for a retained accepted model", () => {
  const metrics = getModelMatchMetrics({
    is_complete: true,
    warnings: [`${RETAINED_ACCEPTED_WARNING_PREFIX} r0001 because the replacement attempt failed.`],
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

test("model header keeps accepted metrics visible through operational warnings", () => {
  const metrics = getModelMatchMetrics({
    is_complete: true,
    warnings: [
      "The accepted publication is durable, but its compatibility checkpoint could not be refreshed.",
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

  expect(metrics.normalized_rmse).toBe(0.01)
  expect(metrics.match_score).toBe(0.99)
})

test("scalar-only validation reports checks and samples instead of a fake match percentage", () => {
  const model_run = {
    status: "complete",
    is_complete: true,
    validation: {
      benchmark_count: 3,
      passing_count: 3,
      critical_count: 3,
      critical_passing_count: 3,
      score: 0,
      worst_normalized_error: 0,
      all_critical_passed: true,
      all_passed: true,
      benchmarks: [],
      scope: {
        total_requirement_count: 5,
        modeled_requirement_count: 3,
        documented_only_requirement_count: 2,
        validated_sample_count: 3,
        scalar_observation_count: 3,
        curve_observation_count: 0,
        swept_case_count: 0,
        quality: "scalar_only",
        documented_only_requirements: [],
        limitations: [],
      },
    },
  } as unknown as ModelRun

  expect(getModelMatchMetrics(model_run)).toEqual({
    normalized_rmse: undefined,
    match_score: undefined,
  })
  expect(getModelHeaderStats(model_run).map(({ label, value }) => ({ label, value }))).toEqual([
    { label: "Checks", value: "3/3" },
    { label: "Samples", value: "3" },
  ])
})

test("curve-backed validation keeps quantitative match metrics", () => {
  const model_run = {
    status: "complete",
    is_complete: true,
    validation: {
      benchmark_count: 1,
      passing_count: 1,
      critical_count: 1,
      critical_passing_count: 1,
      score: 0.125,
      curve_score: 0.125,
      worst_normalized_error: 0.2,
      all_critical_passed: true,
      all_passed: true,
      benchmarks: [],
      scope: {
        total_requirement_count: 1,
        modeled_requirement_count: 1,
        documented_only_requirement_count: 0,
        validated_sample_count: 9,
        scalar_observation_count: 0,
        curve_observation_count: 1,
        compared_curve_observation_count: 1,
        curve_sample_count: 9,
        swept_case_count: 1,
        quality: "curve_validated",
        documented_only_requirements: [],
        limitations: [],
      },
    },
  } as unknown as ModelRun

  expect(getModelHeaderStats(model_run).map(({ label, value }) => ({ label, value }))).toEqual([
    { label: "Match", value: "87.5%" },
    { label: "NRMSE", value: "12.5%" },
  ])
})

test("scalar checks cannot dilute the curve-only match metric", () => {
  const model_run = {
    is_complete: true,
    validation: {
      score: 0.02,
      curve_score: 0.2,
      benchmark_count: 10,
      passing_count: 9,
      benchmarks: [],
      scope: {
        curve_observation_count: 1,
        compared_curve_observation_count: 1,
        curve_sample_count: 20,
        quality: "curve_validated",
      },
    },
  } as unknown as ModelRun

  expect(getModelHeaderStats(model_run).map(({ label, value }) => ({ label, value }))).toEqual([
    { label: "Match", value: "80.0%" },
    { label: "NRMSE", value: "20.0%" },
  ])
})

test("limited validation scope renders modeled coverage and unsupported behavior", () => {
  const model_run = {
    validation: {
      benchmark_count: 3,
      passing_count: 3,
      benchmarks: [],
      scope: {
        total_requirement_count: 5,
        modeled_requirement_count: 3,
        documented_only_requirement_count: 2,
        validated_sample_count: 3,
        scalar_observation_count: 3,
        curve_observation_count: 0,
        swept_case_count: 0,
        quality: "scalar_only",
        documented_only_requirements: [
          {
            requirement_id: "serial_protocol",
            title: "Serial protocol",
            reason: "Digital register behavior is outside the electrical SPICE interface.",
          },
        ],
        limitations: ["The model represents static pin loading only."],
      },
    },
  } as unknown as ModelRun

  const html = renderToStaticMarkup(createElement(ModelValidationScope, { model_run }))
  expect(html).toContain("Scalar operating points only")
  expect(html).toContain("3/5")
  expect(html).toContain("Serial protocol")
  expect(html).toContain("static pin loading only")
  expect(html).not.toContain("100.0%")
})

test("failed replacement UI distinguishes candidate results from the accepted model", () => {
  const html = renderToStaticMarkup(
    createElement(ModelCandidateProvenance, {
      model_run: {
        manifest: { revision: "accepted-r1" },
        validation: { artifact_state: "candidate", model_revision: "candidate-r2" },
      } as unknown as ModelRun,
    }),
  )

  expect(html).toContain("Unaccepted candidate validation")
  expect(html).toContain("candidate-r2")
  expect(html).toContain("accepted revision accepted-r1")
})
