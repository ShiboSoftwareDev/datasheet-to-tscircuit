import { expect, test } from "bun:test"
import { applicationOutputStem } from "@/server/component-workflow/application-artifacts"

test("application build output follows the source filename used by tsci", () => {
  expect(
    applicationOutputStem({
      application_id: "reference",
      origin: "datasheet_reference",
      title: "reference",
      plan: {
        version: 4,
        availability: "not_present",
        title: "fixture",
        description: "fixture",
        source_references: [],
        searched_sections: ["fixture"],
        components: [],
        connections: [],
      },
    }),
  ).toBe("typical-application")
  expect(
    applicationOutputStem({
      application_id: "gpio-bridge",
      origin: "ai_generated",
      title: "GPIO bridge",
      plan: {
        application_id: "gpio-bridge",
        title: "GPIO bridge",
        description: "fixture",
        rationale: "fixture",
        evidence_ids: ["fixture"],
        pcb_implementation: "schematic_only",
        components: [],
        connections: [],
      },
    }),
  ).toBe("typical-application-gpio-bridge")
})
