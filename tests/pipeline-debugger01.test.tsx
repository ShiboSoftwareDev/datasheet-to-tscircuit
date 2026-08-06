import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Job } from "@/shared/job-types"
import type { LocalRunSummary } from "@/shared/local-run"
import { PipelineDebugger, projectLocalPipelineSnapshot } from "@/web/components/pipeline-debugger"

const job: Job = {
  job_id: "job_local_debugger",
  file_name: "sensor.pdf",
  created_at: "2026-08-06T10:00:00.000Z",
  display_status: "failed",
  is_complete: true,
  has_errors: true,
  logs: [],
  component_ready: false,
}

const local_run: LocalRunSummary = {
  version: 1,
  local_run_id: "local-1234567890abcdef",
  mode: "from_task",
  pipeline_id: "component_generation",
  task_id: "extract_evidence",
  source_run_id: "source-run",
  source_job_id: job.job_id,
  file_name: job.file_name,
  status: "failed",
  created_at: "2026-08-06T10:00:00.000Z",
  completed_at: "2026-08-06T10:00:03.000Z",
  execution_dir: "/tmp/local-1234567890abcdef",
  workspace_dir: "/tmp/local-1234567890abcdef/workspace/job_local_debugger",
  input_path: "/tmp/local-1234567890abcdef/input/input.json",
  pipeline_dir: "/tmp/local-1234567890abcdef/run/.pipeline",
  events_path: "/tmp/local-1234567890abcdef/run/.pipeline/events.ndjson",
  summary_path: "/tmp/local-1234567890abcdef/summary.json",
  stage_results: {
    prepare: {
      stage_id: "prepare",
      status: "skipped",
      reason: "Before the selected Local task",
    },
    extract_evidence: {
      stage_id: "extract_evidence",
      status: "completed",
      duration_ms: 1200,
    },
    generate_component: {
      stage_id: "generate_component",
      status: "failed",
      duration_ms: 1800,
      error: {
        code: "agent_failed",
        message: "The component agent failed",
        operation: "generate_component",
        retryable: true,
      },
    },
  },
}

test("Local pages keep the regular pipeline debugger buttons and project the Local stage results", () => {
  const snapshot = projectLocalPipelineSnapshot(local_run)
  expect(snapshot?.pipeline_id).toBe("component_generation")
  expect(snapshot?.status).toBe("failed")
  expect(snapshot?.stage_results.prepare?.status).toBe("skipped")
  expect(snapshot?.stage_results.extract_evidence?.status).toBe("completed")
  expect(snapshot?.stage_results.generate_component?.error?.message).toBe("The component agent failed")

  const html = renderToStaticMarkup(
    <PipelineDebugger
      job={job}
      local_run={local_run}
      on_rerun_local={() => undefined}
      on_local_run_started={() => undefined}
    />,
  )

  expect(html).toContain('aria-label="Pipeline debuggers"')
  expect(html).toContain('title="Inspect Local Component pipeline"')
  expect(html).toContain('title="Typical application was not run by this Local run"')
  expect(html).toContain('title="SPICE was not run by this Local run"')
  expect(html).toContain("Component")
  expect(html).toContain("Typical application")
  expect(html).toContain("SPICE")
})
