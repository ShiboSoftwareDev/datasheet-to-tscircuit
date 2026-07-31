import { expect, test } from "bun:test"
import type { AnyCircuitElement } from "circuit-json"
import {
  type ComponentEvidence,
  createFootprintPlanFromEvidence,
  getComponentEvidenceBlockingReasons,
  getFootprintEvidenceErrors,
  getPinoutEvidenceErrors,
  parseComponentEvidence,
} from "@/server/component-evidence"

const visualSource = {
  page: 12,
  figure: "Recommended land pattern",
  method: "pdf_visual" as const,
  confidence: "high" as const,
  image: "visual-reference/land-pattern.png",
  render_dpi: 200,
}

function evidence(): ComponentEvidence {
  return parseComponentEvidence({
    version: 1,
    status: "resolved",
    part_number: { value: "GENERIC-2", sources: [visualSource] },
    ordering_code: { value: "GENERIC-2-A", sources: [visualSource] },
    package: {
      name: { value: "Two terminal package", sources: [visualSource] },
      code: { value: "PKG2", sources: [visualSource] },
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
          x: -0.75,
          y: 0,
          width: 0.55,
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
  const derived_plan = createFootprintPlanFromEvidence(parsed)
  expect(getComponentEvidenceBlockingReasons(parsed)).toEqual([])
  expect(derived_plan.source_references).toEqual([{ page: 12, figure: "Recommended land pattern" }])
  expect(derived_plan.pads.every((pad) => !("sources" in pad))).toBe(true)
  expect(getFootprintEvidenceErrors(parsed, derived_plan)).toEqual([])
})

test("resolved evidence can retain a non-blocking datasheet discrepancy", () => {
  const resolved = evidence()
  resolved.unresolved_ambiguities = [
    "Marketing prose differs from the order-code-linked package drawing, which controls geometry.",
  ]
  expect(getComponentEvidenceBlockingReasons(resolved)).toEqual([])
})

test("supporting footprint citations do not invalidate matching pad evidence", () => {
  const parsed = evidence()
  const plan = createFootprintPlanFromEvidence(parsed)
  plan.source_references.unshift({ page: 3, figure: "Package selection table" })

  expect(getFootprintEvidenceErrors(parsed, plan)).toEqual([])
})

test("unresolved evidence can retain partial facts without inventing pad geometry", () => {
  const partial = JSON.parse(JSON.stringify(evidence()))
  partial.status = "unresolved"
  partial.footprint.pads = []
  partial.unresolved_ambiguities = ["Pad dimensions could not be resolved automatically"]
  const parsed = parseComponentEvidence(partial)

  expect(parsed.footprint.pads).toEqual([])
  expect(getComponentEvidenceBlockingReasons(parsed)).toContain("evidence extraction is unresolved")
})

test("pin-table validation checks both physical number and semantic label", () => {
  const circuit = [
    {
      type: "source_component",
      source_component_id: "u1",
      manufacturer_part_number: "GENERIC-2-A",
    },
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
      requires_ground: true,
    },
  ] as unknown as AnyCircuitElement[]
  expect(getPinoutEvidenceErrors(evidence(), circuit)).toEqual([
    "pin 2 labels RETURN are absent from its Circuit JSON port",
  ])
})

test("pin-table validation preserves every documented alias", () => {
  const aliased = evidence()
  aliased.pinout.pins[0]!.labels = ["INPUT", "ENABLE"]
  const circuit = [
    {
      type: "source_component",
      source_component_id: "u1",
      manufacturer_part_number: "GENERIC-2-A",
    },
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
      name: "RETURN",
      port_hints: ["2", "RETURN"],
      requires_ground: true,
    },
  ] as unknown as AnyCircuitElement[]

  expect(getPinoutEvidenceErrors(aliased, circuit)).toContain(
    "pin 1 labels INPUT/ENABLE are absent from its Circuit JSON port",
  )
})

test("pin-table validation accepts unambiguous selector-safe polarity aliases", () => {
  const polarized = evidence()
  polarized.pinout.pins[0]!.labels = ["IN−"]
  polarized.pinout.pins[1]!.labels = ["IN+"]
  const circuit = [
    {
      type: "source_component",
      source_component_id: "u1",
      manufacturer_part_number: "GENERIC-2-A",
    },
    {
      type: "source_port",
      source_port_id: "p1",
      source_component_id: "u1",
      pin_number: 1,
      name: "IN_NEG",
      port_hints: ["1", "IN_NEG"],
    },
    {
      type: "source_port",
      source_port_id: "p2",
      source_component_id: "u1",
      pin_number: 2,
      name: "IN_POS",
      port_hints: ["2", "IN_POS"],
      requires_ground: true,
    },
  ]

  expect(getPinoutEvidenceErrors(polarized, circuit as unknown as AnyCircuitElement[])).toEqual([])

  circuit[1]!.name = "IN_POS"
  circuit[1]!.port_hints = ["1", "IN_POS"]
  circuit[2]!.name = "IN_NEG"
  circuit[2]!.port_hints = ["2", "IN_NEG"]
  expect(getPinoutEvidenceErrors(polarized, circuit as unknown as AnyCircuitElement[])).toEqual([
    "pin 1 labels IN− are absent from its Circuit JSON port",
    "pin 2 labels IN+ are absent from its Circuit JSON port",
  ])
})

test("pin-table validation enforces exact ordering code and electrical role attributes", () => {
  const circuit = [
    {
      type: "source_component",
      source_component_id: "u1",
      manufacturer_part_number: "GENERIC-2",
    },
    {
      type: "source_port",
      source_port_id: "p1",
      source_component_id: "u1",
      pin_number: 1,
      name: "INPUT",
      port_hints: ["1", "INPUT"],
      requires_power: true,
    },
    {
      type: "source_port",
      source_port_id: "p2",
      source_component_id: "u1",
      pin_number: 2,
      name: "RETURN",
      port_hints: ["2", "RETURN"],
    },
  ] as unknown as AnyCircuitElement[]

  expect(getPinoutEvidenceErrors(evidence(), circuit)).toEqual([
    "component manufacturer part number GENERIC-2; expected GENERIC-2-A",
    "pin 1 role input requires requires_power=false, found true",
    "pin 2 role ground requires requires_ground=true, found false",
  ])
})

test("pin-table validation enforces explicit open-drain evidence", () => {
  const open_drain_evidence = evidence()
  open_drain_evidence.pinout.pins[0]!.role = "output"
  open_drain_evidence.pinout.pins[0]!.electrical_attributes = { open_drain: true }
  const circuit = [
    {
      type: "source_component",
      source_component_id: "u1",
      manufacturer_part_number: "GENERIC-2-A",
    },
    {
      type: "source_port",
      source_port_id: "p1",
      source_component_id: "u1",
      pin_number: 1,
      name: "INPUT",
      port_hints: ["1", "INPUT"],
      can_use_open_drain: true,
    },
    {
      type: "source_port",
      source_port_id: "p2",
      source_component_id: "u1",
      pin_number: 2,
      name: "RETURN",
      port_hints: ["2", "RETURN"],
      requires_ground: true,
    },
  ] as unknown as AnyCircuitElement[]

  expect(getPinoutEvidenceErrors(open_drain_evidence, circuit)).toContain(
    "pin 1 open-drain evidence requires is_using_open_drain=true, found false",
  )
})

test("visual evidence must use the deterministic renderer settings", () => {
  const invalid = JSON.parse(JSON.stringify(evidence()))
  invalid.footprint.drawing_orientation.sources[0].render_dpi = 150
  expect(() => parseComponentEvidence(invalid)).toThrow("exactly 200 DPI")
})

test("open-drain evidence requires an output-capable pin role", () => {
  const invalid = JSON.parse(JSON.stringify(evidence()))
  invalid.pinout.pins[0].electrical_attributes = { open_drain: true }
  expect(() => parseComponentEvidence(invalid)).toThrow(
    "electrical_attributes.open_drain requires an output or bidirectional role",
  )
})
