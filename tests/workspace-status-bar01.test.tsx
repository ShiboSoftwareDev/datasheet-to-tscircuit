import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Job, ModelRun } from "@/shared/job-types"
import { RETAINED_ACCEPTED_WARNING_PREFIX } from "@/shared/model-warnings"
import { WorkspaceStatusBar } from "@/web/components/workspace-status-bar"

const job: Job = {
  job_id: "job_1",
  file_name: "component.pdf",
  created_at: "2026-07-24T00:00:00.000Z",
  display_status: "complete",
  is_complete: true,
  has_errors: false,
  logs: [],
  component_ready: true,
  component_code: "export default () => null",
  warnings: ["Review the generated output."],
}

const model_run: ModelRun = {
  model_run_id: "model_1",
  job_id: "job_1",
  created_at: "2026-07-24T00:00:00.000Z",
  updated_at: "2026-07-24T00:00:00.000Z",
  status: "complete",
  is_complete: true,
  has_errors: false,
  warnings: ["Benchmark validation was incomplete.", "One graph was duplicated."],
  effort_multiplier: 1,
  elapsed_time_ms: 1,
  iteration: 1,
  logs: [],
  progress_history: [],
  preview_options: [],
}

test("workspace status keeps compact warnings beside their respective artifacts", () => {
  const html = renderToStaticMarkup(
    <WorkspaceStatusBar job={job} model_run={model_run} is_model_loading={false} />,
  )

  expect(html).toContain('aria-label="Component status: Ready with warnings"')
  expect(html).toContain('aria-label="SPICE model status: Ready with warnings"')
  expect(html).toContain('class="workspace-status-name">SPICE</span>')
  expect(html).toContain('aria-label="Download artifacts"')
  expect(html).not.toContain("<span>Download</span>")
  expect(html).toContain('class="workspace-warning-count">1</span>')
  expect(html).toContain('aria-label="View 1 Component warning"')
  expect(html).toContain('class="workspace-warning-count">2</span>')
  expect(html).toContain('aria-label="View 2 SPICE model warnings"')
  expect(html.indexOf('aria-label="View 1 Component warning"')).toBeLessThan(
    html.indexOf('aria-label="SPICE model status: Ready with warnings"'),
  )
})

test("workspace status preserves the latest attempt status while marking the accepted model retained", () => {
  const retained_model_run: ModelRun = {
    ...model_run,
    status: "failed",
    is_complete: true,
    has_errors: true,
    error_message: "Replacement validation failed",
    model_source: ".SUBCKT SENSOR IN OUT\n.ENDS SENSOR\n",
    warnings: [`${RETAINED_ACCEPTED_WARNING_PREFIX} r0001 because the replacement attempt failed.`],
  }
  const html = renderToStaticMarkup(
    <WorkspaceStatusBar job={job} model_run={retained_model_run} is_model_loading={false} />,
  )

  expect(html).toContain('aria-label="SPICE model status: Failed; accepted model retained"')
  expect(html).toContain("Failed · Retained")
  expect(html).not.toContain('class="workspace-download-trigger" type="button" disabled=""')
})

test("workspace status calls a successful partial SPICE pipeline paused instead of ready", () => {
  const partial_model_run: ModelRun = {
    ...model_run,
    warnings: ["Later tasks were intentionally not run."],
    pipeline: {
      pipeline_id: "spice_generation",
      status: "completed",
      sequence: 3,
      started_at: "2026-07-24T00:00:00.000Z",
      updated_at: "2026-07-24T00:01:00.000Z",
      stage_results: {
        infer_spice_model: {
          stage_id: "infer_spice_model",
          status: "completed",
          debug_ref: "spice/infer",
        },
        publish: {
          stage_id: "publish",
          status: "skipped",
          debug_ref: "spice/publish",
          reason: "Stage was not selected for this isolated pipeline invocation",
        },
      },
    },
  }
  const html = renderToStaticMarkup(
    <WorkspaceStatusBar job={job} model_run={partial_model_run} is_model_loading={false} />,
  )

  expect(html).toContain('aria-label="SPICE model status: Paused"')
  expect(html).toContain(">Paused</span>")
  expect(html).not.toContain('aria-label="SPICE model status: Ready with warnings"')
})
