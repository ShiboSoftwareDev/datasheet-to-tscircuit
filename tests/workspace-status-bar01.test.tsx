import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Job, ModelRun } from "@/shared/job-types"
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
  base_effort_ms: 1,
  allocated_time_ms: 1,
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
