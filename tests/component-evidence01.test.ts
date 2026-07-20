import { expect, test } from "bun:test"
import type { AnyCircuitElement } from "circuit-json"
import {
  getComponentEvidenceBlockingReasons,
  getFootprintEvidenceErrors,
  getIndependentComponentEvidenceErrors,
  getPinoutEvidenceErrors,
  parseComponentEvidence,
  type ComponentEvidence,
} from "@/server/component-evidence"

const visualSource = {
  page: 12,
  figure: "Recommended land pattern",
  method: "pdf_visual" as const,
  confidence: "high" as const,
  image: "visual-reference/land-pattern.png",
  render_dpi: 200,
}

function evidence(overrides?: {
  part_number?: string
  ordering_code?: string
  package_name?: string
  package_code?: string
  pad_width?: number
  pad_x?: number
}): ComponentEvidence {
  return parseComponentEvidence({
    version: 1,
    status: "resolved",
    part_number: { value: overrides?.part_number ?? "GENERIC-2", sources: [visualSource] },
    ordering_code: { value: overrides?.ordering_code ?? "GENERIC-2-A", sources: [visualSource] },
    package: {
      name: { value: overrides?.package_name ?? "Two terminal package", sources: [visualSource] },
      code: { value: overrides?.package_code ?? "PKG2", sources: [visualSource] },
      pin_count: { value: 2, sources: [visualSource] },
    },
    pinout: {
      pins: [
        { number: "1", labels: ["INPUT"], role: "input", sources: [visualSource] },
        { number: "2", labels: ["RETURN"], role: "ground", sources: [visualSource] },
      ],
    },
    footprint: {
      view: "pcb_top",
      units: "mm",
      drawing_orientation: { value: "pcb_top", sources: [visualSource] },
      pads: [
        {
          pin: "1",
          kind: "smt",
          x: overrides?.pad_x ?? -0.75,
          y: 0,
          width: overrides?.pad_width ?? 0.55,
          height: 0.8,
          sources: [visualSource],
        },
        { pin: "2", kind: "smt", x: 0.75, y: 0, width: 0.55, height: 0.8, sources: [visualSource] },
      ],
    },
    unresolved_ambiguities: [],
  })
}

test("resolved evidence is source-backed without assuming a package family", () => {
  const parsed = evidence()
  expect(getComponentEvidenceBlockingReasons(parsed)).toEqual([])
  expect(
    getFootprintEvidenceErrors(parsed, {
      version: 1,
      view: "pcb_top",
      source_references: [{ page: 12 }],
      pads: parsed.footprint.pads.map(({ sources, ...pad }) => pad),
    }),
  ).toEqual([])
})

test("independent extraction catches coordinate and dimension reinterpretation", () => {
  const errors = getIndependentComponentEvidenceErrors(
    evidence(),
    evidence({ pad_x: -0.55, pad_width: 0.75 }),
  )
  expect(errors.some((error) => error.includes("pin 1 x"))).toBe(true)
  expect(errors.some((error) => error.includes("pin 1 width"))).toBe(true)
})

test("exact package codes allow independent human-readable package-name wording", () => {
  expect(
    getIndependentComponentEvidenceErrors(
      evidence({ package_name: "Leadless two terminal" }),
      evidence({ package_name: "2-pin leadless package" }),
    ),
  ).toEqual([])
})

test("ordering-code disagreement blocks evidence approval", () => {
  expect(
    getIndependentComponentEvidenceErrors(
      evidence({ ordering_code: "GENERIC-2-A" }),
      evidence({ ordering_code: "GENERIC-2-B" }),
    ),
  ).toContain('ordering code disagrees: "GENERIC-2-A" versus "GENERIC-2-B"')
})

test("independent electrical-role disagreement blocks schematic planning", () => {
  const primary = evidence()
  const independent = evidence()
  independent.pinout.pins[0]!.role = "output"
  expect(getIndependentComponentEvidenceErrors(primary, independent)).toContain(
    "pin 1 schematic role disagrees: input versus output",
  )
})

test("pin-table validation checks both physical number and semantic label", () => {
  const circuit = [
    {
      type: "source_port",
      source_port_id: "p1",
      source_component_id: "u1",
      pin_number: 1,
      name: "INPUT",
      port_hints: ["1", "INPUT"],
    },
    {
      type: "source_port",
      source_port_id: "p2",
      source_component_id: "u1",
      pin_number: 2,
      name: "OUTPUT",
      port_hints: ["2", "OUTPUT"],
    },
  ] as unknown as AnyCircuitElement[]
  expect(getPinoutEvidenceErrors(evidence(), circuit)).toEqual([
    "pin 2 labels RETURN are absent from its Circuit JSON port",
  ])
})

test("visual evidence must use the deterministic renderer settings", () => {
  const invalid = JSON.parse(JSON.stringify(evidence()))
  invalid.footprint.drawing_orientation.sources[0].render_dpi = 150
  expect(() => parseComponentEvidence(invalid)).toThrow("exactly 200 DPI")
})
