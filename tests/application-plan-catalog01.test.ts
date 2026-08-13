import { expect, test } from "bun:test"
import { parseComponentEvidence } from "@/server/component-evidence"
import {
  createApplicationPlanCatalog,
  parseGeneratedApplicationPlanSet,
} from "@/server/component-workflow/application-plan-catalog"
import { parseApplicationDesignEvidence } from "@/server/component-workflow/application-design-evidence"
import { parseTypicalApplicationPlan } from "@/server/component-workflow/application-plan"

const text_source = { page: 1, method: "pdf_text", confidence: "high" } as const
const visual_source = {
  page: 2,
  method: "pdf_visual",
  confidence: "high",
  image: "visual-reference/typical-application.png",
  render_dpi: 200,
} as const

const component_evidence = parseComponentEvidence({
  version: 1,
  status: "resolved",
  part_number: { value: "SOLID-2", sources: [text_source] },
  package: {
    name: { value: "Two pin package", sources: [text_source] },
    pin_count: { value: 2, sources: [text_source] },
  },
  pinout: {
    pins: [
      { number: "1", labels: ["IN"], role: "input", sources: [text_source] },
      { number: "2", labels: ["OUT"], role: "output", sources: [text_source] },
    ],
  },
  footprint: {
    view: "pcb_top",
    units: "mm",
    drawing_orientation: { value: "pcb_top", sources: [visual_source] },
    pads: [
      { pin: "1", kind: "smt", x: -1, y: 0, width: 0.5, height: 0.5, sources: [visual_source] },
      { pin: "2", kind: "smt", x: 1, y: 0, width: 0.5, height: 0.5, sources: [visual_source] },
    ],
  },
  unresolved_ambiguities: [],
})

const reference_plan = parseTypicalApplicationPlan({
  version: 4,
  availability: "documented",
  pcb_implementation: "schematic_only",
  title: "Reference circuit",
  description: "Manufacturer reference circuit.",
  source_references: [visual_source],
  components: [{ reference: "U1", kind: "integrated_circuit", value: "SOLID-2" }],
  connections: [
    { net: "INPUT", pins: ["U1.1", "INPUT"] },
    { net: "OUTPUT", pins: ["U1.2", "OUTPUT"] },
  ],
})

const design_evidence = parseApplicationDesignEvidence({
  version: 1,
  capabilities: [
    {
      evidence_id: "buffer-capability",
      statement: "The device supports buffering a signal.",
      source_references: [text_source],
    },
  ],
  constraints: [
    {
      evidence_id: "series-resistor-allowed",
      statement: "A series output resistor is allowed for source termination.",
      source_references: [text_source],
    },
  ],
  prohibited_uses: [],
})

function generatedValue(overrides: Record<string, unknown> = {}) {
  return {
    application_id: "source-terminated-buffer",
    title: "Source-terminated buffer",
    description: "Buffers a point-to-point signal with source termination.",
    rationale: "Adds a datasheet-supported source termination use, not a value-only variant.",
    evidence_ids: ["buffer-capability", "series-resistor-allowed"],
    pcb_implementation: "schematic_only",
    components: [
      { reference: "U1", kind: "integrated_circuit" },
      { reference: "R1", kind: "resistor", value: "33 ohm" },
    ],
    connections: [
      { net: "INPUT", pins: ["U1.1", "INPUT"] },
      { net: "OUTPUT_INTERNAL", pins: ["U1.2", "R1.1"] },
      { net: "OUTPUT", pins: ["R1.2", "OUTPUT"] },
    ],
    ...overrides,
  }
}

test("application catalog always puts the datasheet reference before supported AI applications", () => {
  const generated = parseGeneratedApplicationPlanSet({
    value: { version: 1, applications: [generatedValue()] },
    component_evidence,
    design_evidence,
    reference_plan,
  })
  const catalog = createApplicationPlanCatalog({ reference_plan, generated })

  expect(catalog.default_application_id).toBe("reference")
  expect(catalog.applications.map(({ application_id, origin }) => ({ application_id, origin }))).toEqual([
    { application_id: "reference", origin: "datasheet_reference" },
    { application_id: "source-terminated-buffer", origin: "ai_generated" },
  ])
})

test("application planner may return no additions instead of padding a quota", () => {
  const generated = parseGeneratedApplicationPlanSet({
    value: { version: 1, applications: [] },
    component_evidence,
    design_evidence,
    reference_plan,
  })
  expect(createApplicationPlanCatalog({ reference_plan, generated }).applications).toHaveLength(1)
})

test("generated application plans reject descriptive passive values before TSX generation", () => {
  expect(() =>
    parseGeneratedApplicationPlanSet({
      value: {
        version: 1,
        applications: [
          generatedValue({
            components: [
              { reference: "U1", kind: "integrated_circuit" },
              { reference: "R1", kind: "resistor", value: "33 ohm, 1%" },
            ],
          }),
        ],
      },
      component_evidence,
      design_evidence,
      reference_plan,
    }),
  ).toThrow("R1 must give its resistor a concrete executable numeric value")
})

test("generated applications fail closed on unsupported evidence and cosmetic reference duplicates", () => {
  expect(() =>
    parseGeneratedApplicationPlanSet({
      value: {
        version: 1,
        applications: [generatedValue({ evidence_ids: ["buffer-capability", "invented-constraint"] })],
      },
      component_evidence,
      design_evidence,
      reference_plan,
    }),
  ).toThrow("unknown design evidence invented-constraint")

  expect(() =>
    parseGeneratedApplicationPlanSet({
      value: {
        version: 1,
        applications: [
          generatedValue({
            components: [{ reference: "U1", kind: "integrated_circuit" }],
            connections: reference_plan.connections,
          }),
        ],
      },
      component_evidence,
      design_evidence,
      reference_plan,
    }),
  ).toThrow("duplicates a reference or earlier application topology")
})

test("application topology preserves a materially different external control role", () => {
  const control_reference = parseTypicalApplicationPlan({
    ...reference_plan,
    connections: [
      { net: "ENABLE", pins: ["U1.1", "OE"] },
      { net: "OUTPUT", pins: ["U1.2", "OUTPUT"] },
    ],
  })
  const generated = parseGeneratedApplicationPlanSet({
    value: {
      version: 1,
      applications: [
        generatedValue({
          components: [{ reference: "U1", kind: "integrated_circuit" }],
          connections: [
            { net: "ENABLE", pins: ["U1.1", "RAILS_POWER_GOOD"] },
            { net: "OUTPUT", pins: ["U1.2", "RENAMED_OUTPUT"] },
          ],
        }),
      ],
    },
    component_evidence,
    design_evidence,
    reference_plan: control_reference,
  })

  expect(generated.applications).toHaveLength(1)
})
