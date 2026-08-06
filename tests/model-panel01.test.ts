import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ModelRun } from "@/shared/job-types"
import { RETAINED_ACCEPTED_WARNING_PREFIX } from "@/shared/model-warnings"
import {
  getModelHeaderStats,
  getModelMatchMetrics,
  ModelCandidateProvenance,
  ModelPanel,
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

test("failed candidate diagnostics are visible while repair is still running", () => {
  const html = renderToStaticMarkup(
    createElement(ModelValidationScope, {
      model_run: {
        validation: {
          artifact_state: "candidate",
          benchmark_count: 1,
          passing_count: 0,
          benchmarks: [
            {
              benchmark_id: "startup-waveform",
              title: "Startup waveform",
              passed: false,
              error_message: "Viewer produced no completed transient waveform.",
            },
          ],
          scope: {
            total_requirement_count: 1,
            modeled_requirement_count: 1,
            documented_only_requirement_count: 0,
            validated_sample_count: 0,
            scalar_observation_count: 0,
            curve_observation_count: 1,
            compared_curve_observation_count: 0,
            curve_sample_count: 0,
            swept_case_count: 1,
            quality: "curve_attempted",
            documented_only_requirements: [],
            limitations: [],
          },
        },
      } as unknown as ModelRun,
    }),
  )

  expect(html).toContain("Current candidate failures")
  expect(html).toContain("Startup waveform")
  expect(html).toContain("Viewer produced no completed transient waveform.")
})

test("model panel keeps compact progress without rendering the execution trace", () => {
  const timestamp = "2026-08-04T00:00:00.000Z"
  const html = renderToStaticMarkup(
    createElement(ModelPanel, {
      job: {
        job_id: "job-model-progress",
        file_name: "TPS63802.pdf",
        created_at: timestamp,
        display_status: "agent_running",
        is_complete: false,
        has_errors: false,
        logs: [],
      },
      model_run_state: {
        model_run: {
          model_run_id: "model-progress",
          job_id: "job-model-progress",
          created_at: timestamp,
          updated_at: timestamp,
          status: "running",
          is_complete: false,
          has_errors: false,
          effort_multiplier: 1,
          elapsed_time_ms: 1_000,
          iteration: 0,
          logs: [],
          progress: {
            sequence: 1,
            phase: "generating_model",
            message: "Generating candidate",
            updated_at: timestamp,
          },
          progress_history: [],
          preview_options: [],
          pipeline: {
            pipeline_id: "datasheet_model",
            status: "running",
            sequence: 2,
            started_at: timestamp,
            updated_at: timestamp,
            stage_results: {
              prepare_workspace: {
                stage_id: "prepare_workspace",
                status: "completed",
                debug_ref: "debug/prepare-workspace",
                duration_ms: 100,
              },
              internal_only_stage: {
                stage_id: "internal_only_stage",
                status: "running",
                debug_ref: "debug/internal-only-stage",
              },
            },
          },
        },
        is_loading: false,
        is_starting: false,
        is_extending: false,
        is_cancelling: false,
        is_retrying: false,
        error_message: undefined,
        local_run_id: undefined,
        is_read_only: false,
        start: async () => undefined,
        extend: async () => undefined,
        cancel: async () => undefined,
        retry: async () => undefined,
      },
    } as Parameters<typeof ModelPanel>[0]),
  )

  expect(html).toContain("Generating candidate")
  expect(html).toContain("1/2 stages")
  expect(html).toContain("Waiting for benchmark TSX")
  expect(html).toContain("Waiting for analog simulation")
  expect(html).toContain("Reference graph comparison")
  expect(html).not.toContain("Model execution trace")
  expect(html).not.toContain("internal only stage")
})

test("model panel offers to restart successful SPICE generation", () => {
  const timestamp = "2026-08-04T00:00:00.000Z"
  const html = renderToStaticMarkup(
    createElement(ModelPanel, {
      job: {
        job_id: "job-model-complete",
        file_name: "TPS63802.pdf",
        created_at: timestamp,
        completed_at: timestamp,
        display_status: "complete",
        is_complete: true,
        has_errors: false,
        logs: [],
      },
      model_run_state: {
        model_run: {
          model_run_id: "model-complete",
          job_id: "job-model-complete",
          created_at: timestamp,
          updated_at: timestamp,
          completed_at: timestamp,
          status: "complete",
          is_complete: true,
          has_errors: false,
          effort_multiplier: 1,
          elapsed_time_ms: 1_000,
          iteration: 0,
          logs: [],
          progress_history: [],
          preview_options: [],
        },
        is_loading: false,
        is_starting: false,
        is_extending: false,
        is_cancelling: false,
        is_retrying: false,
        error_message: undefined,
        local_run_id: undefined,
        is_read_only: false,
        start: async () => undefined,
        extend: async () => undefined,
        cancel: async () => undefined,
        retry: async () => undefined,
      },
    } as Parameters<typeof ModelPanel>[0]),
  )

  expect(html).toContain("Restart SPICE generation")
})
