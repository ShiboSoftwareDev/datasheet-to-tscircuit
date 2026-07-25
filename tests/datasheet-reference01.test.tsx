import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Job } from "@/shared/job-types"
import { DatasheetReference } from "@/web/components/datasheet-reference"

const job: Job = {
  job_id: "job_1",
  file_name: "component.pdf",
  created_at: "2026-07-24T00:00:00.000Z",
  display_status: "complete",
  is_complete: true,
  has_errors: false,
  logs: [],
  evidence_available: true,
}

test("the datasheet reference renders as a non-interactive image", () => {
  const html = renderToStaticMarkup(
    <DatasheetReference
      job={job}
      artifact="component"
      component_view="footprint"
      on_component_view_change={() => {}}
    />,
  )

  expect(html).toContain('<img class="datasheet-reference-image"')
  expect(html).not.toContain("<a")
})
