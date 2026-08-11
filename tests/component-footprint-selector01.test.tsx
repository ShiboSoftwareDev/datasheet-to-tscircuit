import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { Job } from "@/shared/job-types"
import { CircuitPreview } from "@/web/components/circuit-preview"

function jobWithFootprints(count: number): Job {
  return {
    job_id: "footprint-selector-job",
    file_name: "component.pdf",
    created_at: "2026-08-10T00:00:00.000Z",
    display_status: "complete",
    is_complete: true,
    has_errors: false,
    logs: [],
    evidence_available: true,
    component_footprints: {
      default_footprint_id: "tssop-14",
      footprints: [
        {
          footprint_id: "tssop-14",
          label: "PW · 14 pins",
          aliases: ["PW"],
          ordering_codes: ["DEVICEPWR"],
          package_name: "TSSOP",
          package_code: "PW",
          pin_count: 14,
        },
        ...(count > 1
          ? [
              {
                footprint_id: "uqfn-12",
                label: "RUT · 12 pins",
                aliases: ["RUT"],
                ordering_codes: ["DEVICERUTR"],
                package_name: "UQFN",
                package_code: "RUT",
                pin_count: 12,
              },
            ]
          : []),
      ],
    },
  }
}

test("component preview shows one selector only for distinct physical footprints", () => {
  const multiple = renderToStaticMarkup(
    <CircuitPreview job={jobWithFootprints(2)} active_tab="pcb" on_active_tab_change={() => undefined} />,
  )
  expect(multiple).toContain("Multiple footprints")
  expect(multiple).toContain("PW · 14 pins")
  expect(multiple).toContain("RUT · 12 pins")

  const single = renderToStaticMarkup(
    <CircuitPreview job={jobWithFootprints(1)} active_tab="pcb" on_active_tab_change={() => undefined} />,
  )
  expect(single).not.toContain("Multiple footprints")
})
