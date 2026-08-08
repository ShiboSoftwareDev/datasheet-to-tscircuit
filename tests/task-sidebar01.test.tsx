import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { JobSummary } from "@/shared/job-types"
import type { LocalRunSummary } from "@/shared/local-run"
import { TaskSidebar } from "@/web/components/task-sidebar"

test("task sidebar renders component and model state from compact job summaries", () => {
  const jobs: JobSummary[] = [
    {
      job_id: "job_summary",
      file_name: "sensor.pdf",
      created_at: "2026-07-31T10:00:00.000Z",
      display_status: "failed",
      is_complete: true,
      has_errors: true,
      component_ready: true,
      model_run: {
        model_run_id: "model_summary",
        job_id: "job_summary",
        status: "failed",
        is_complete: true,
        has_errors: true,
        error_message: "Validation failed",
        has_model: false,
        has_retained_accepted_model: false,
      },
    },
  ]
  const html = renderToStaticMarkup(
    <TaskSidebar
      jobs={jobs}
      local_runs={[]}
      active_view="tasks"
      is_open
      cancelling_job_ids={new Set()}
      retrying_job_ids={new Set()}
      deleting_job_ids={new Set()}
      rerunning_local_run_ids={new Set()}
      on_new_task={() => undefined}
      on_toggle={() => undefined}
      on_select_task={() => undefined}
      on_select_local={() => undefined}
      on_view_change={() => undefined}
      on_cancel_task={() => undefined}
      on_retry_task={() => undefined}
      on_delete_task={() => undefined}
      on_rerun_local={() => undefined}
    />,
  )

  expect(html).toContain('aria-label="Component Ready"')
  expect(html).toContain('aria-label="Model Failed"')
  expect(html).not.toContain("Model Loading")
})

test("task sidebar preserves the latest model status while marking the accepted artifact retained", () => {
  const jobs: JobSummary[] = [
    {
      job_id: "job_retained",
      file_name: "sensor.pdf",
      created_at: "2026-07-31T10:00:00.000Z",
      display_status: "complete",
      is_complete: true,
      has_errors: false,
      component_ready: true,
      model_run: {
        model_run_id: "model_retained",
        job_id: "job_retained",
        status: "failed",
        is_complete: true,
        has_errors: true,
        error_message: "Replacement validation failed",
        has_model: true,
        has_retained_accepted_model: true,
      },
    },
  ]
  const html = renderToStaticMarkup(
    <TaskSidebar
      jobs={jobs}
      local_runs={[]}
      active_view="tasks"
      is_open
      cancelling_job_ids={new Set()}
      retrying_job_ids={new Set()}
      deleting_job_ids={new Set()}
      rerunning_local_run_ids={new Set()}
      on_new_task={() => undefined}
      on_toggle={() => undefined}
      on_select_task={() => undefined}
      on_select_local={() => undefined}
      on_view_change={() => undefined}
      on_cancel_task={() => undefined}
      on_retry_task={() => undefined}
      on_delete_task={() => undefined}
      on_rerun_local={() => undefined}
    />,
  )

  expect(html).toContain('aria-label="Model Failed · Retained"')
  expect(html).toContain('title="Model Failed; accepted model retained"')
  expect(html).toContain("Failed · Retained")
})

test("task sidebar switches to Local runs and exposes a Local-only rerun action", () => {
  const localRuns: LocalRunSummary[] = [
    {
      version: 1,
      local_run_id: "local-1234567890abcdef",
      mode: "task",
      pipeline_id: "component_generation",
      task_id: "validate_component",
      source_run_id: "source-run",
      source_job_id: "source-job",
      file_name: "sensor.pdf",
      status: "completed",
      created_at: "2026-08-05T10:00:00.000Z",
      completed_at: "2026-08-05T10:00:01.000Z",
      execution_dir: "/tmp/local-1234567890abcdef",
      workspace_dir: "/tmp/local-1234567890abcdef/workspace/source-job",
      input_path: "/tmp/local-1234567890abcdef/input/stages/validate_component/input.json",
      pipeline_dir: "/tmp/local-1234567890abcdef/run/.pipeline",
      events_path: "/tmp/local-1234567890abcdef/run/.pipeline/events.ndjson",
      summary_path: "/tmp/local-1234567890abcdef/summary.json",
      stage_results: {},
    },
  ]
  const html = renderToStaticMarkup(
    <TaskSidebar
      jobs={[]}
      local_runs={localRuns}
      active_view="local"
      is_open
      cancelling_job_ids={new Set()}
      retrying_job_ids={new Set()}
      deleting_job_ids={new Set()}
      rerunning_local_run_ids={new Set()}
      on_new_task={() => undefined}
      on_toggle={() => undefined}
      on_select_task={() => undefined}
      on_select_local={() => undefined}
      on_view_change={() => undefined}
      on_cancel_task={() => undefined}
      on_retry_task={() => undefined}
      on_delete_task={() => undefined}
      on_rerun_local={() => undefined}
    />,
  )

  expect(html).toContain('role="tab" aria-selected="false">Tasks')
  expect(html).toContain('role="tab" aria-selected="true">Local')
  expect(html).toContain("validate component")
  expect(html).toContain('title="Run again"')
})
