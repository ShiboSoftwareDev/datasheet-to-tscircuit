import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Job } from "@/shared/job-types"
import { PipelineDebugger } from "@/web/components/pipeline-debugger"

const job: Job = {
  job_id: "job_debugger",
  file_name: "sensor.pdf",
  created_at: "2026-08-06T10:00:00.000Z",
  display_status: "failed",
  is_complete: true,
  has_errors: true,
  logs: [],
  component_ready: false,
}

test("pipeline debugger controls remain available for every selected job", () => {
  const html = renderToStaticMarkup(<PipelineDebugger job={job} on_run_started={() => undefined} />)

  expect(html).toContain('aria-label="Pipeline debuggers"')
  expect(html).toContain('title="Debug Component pipeline"')
  expect(html).toContain('title="Debug Typical application pipeline"')
  expect(html).toContain('title="Debug SPICE pipeline"')
  expect(html).toContain("Component")
  expect(html).toContain("Typical application")
  expect(html).toContain("SPICE")
  expect(html.match(/lucide-bug/g)).toHaveLength(3)
  expect(html).not.toContain("disabled")
})
