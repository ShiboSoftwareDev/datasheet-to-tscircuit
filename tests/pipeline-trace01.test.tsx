import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Job, PublicPipelineSnapshot } from "@/shared/job-types"
import { ComponentPipelineTrace } from "@/web/components/component-pipeline-trace"

const pipeline: PublicPipelineSnapshot = {
  pipeline_id: "datasheet_component",
  status: "failed",
  sequence: 7,
  started_at: "2026-07-31T10:00:00.000Z",
  updated_at: "2026-07-31T10:00:01.500Z",
  stage_results: {
    prepare: {
      stage_id: "prepare",
      status: "completed",
      debug_ref: ".pipeline/stages/01-prepare",
      started_at: "2026-07-31T10:00:00.000Z",
      completed_at: "2026-07-31T10:00:00.250Z",
      duration_ms: 250,
    },
    validate_application: {
      stage_id: "validate_application",
      status: "failed",
      debug_ref: ".pipeline/stages/07-validate_application",
      started_at: "2026-07-31T10:00:01.000Z",
      completed_at: "2026-07-31T10:00:01.500Z",
      duration_ms: 500,
      error: {
        code: "application_connectivity_invalid",
        message: "The output pin is not connected.",
        operation: "validate_application",
        hint: "Connect U1.OUT to the declared load.",
        retryable: true,
      },
    },
    publish: {
      stage_id: "publish",
      status: "pending",
      debug_ref: ".pipeline/stages/09-publish",
    },
  },
}

const job: Job = {
  job_id: "job_1",
  file_name: "component.pdf",
  created_at: "2026-07-31T10:00:00.000Z",
  display_status: "failed",
  is_complete: true,
  has_errors: true,
  logs: [],
  pipeline,
}

test("component detail trace exposes named stages and actionable failure diagnostics", () => {
  const html = renderToStaticMarkup(<ComponentPipelineTrace job={job} />)

  expect(html).toContain("Component execution trace")
  expect(html).toContain("datasheet_component")
  expect(html).toContain("Failed · 2/3 stages")
  expect(html).toContain("Prepare workspace")
  expect(html).toContain("Validate typical application")
  expect(html).toContain("application_connectivity_invalid")
  expect(html).toContain("The output pin is not connected.")
  expect(html).toContain("Operation: validate_application · retryable")
  expect(html).toContain("Next: Connect U1.OUT to the declared load.")
  expect(html).toContain("Debug bundle:")
  expect(html).toContain(".pipeline/stages/07-validate_application")
  expect(html).toContain(">250 ms</time>")
  expect(html).toContain(">Pending</time>")
  expect(html).toContain("<details")
  expect(html).toContain('open=""')
})

test("component detail omits the trace for jobs persisted before pipeline snapshots", () => {
  expect(renderToStaticMarkup(<ComponentPipelineTrace job={{ ...job, pipeline: undefined }} />)).toBe("")
})
