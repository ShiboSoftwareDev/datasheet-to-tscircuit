import { expect, test } from "bun:test"
import type { AnyCircuitElement } from "circuit-json"
import {
  canonicalizeComponentEvidenceInput,
  type ComponentEvidence,
  type EvidenceSource,
  createFootprintPlanFromEvidence,
  getComponentEvidenceBlockingReasons,
  getFootprintEvidenceErrors,
  getPinoutEvidenceErrors,
  parseComponentEvidence,
} from "@/server/component-evidence"
import { COMPONENT_EVIDENCE_GUIDE } from "@/server/component-workflow/evidence-schema"

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

test("ordering identities must be distinct extensions of their base part number", () => {
  const reversed = JSON.parse(JSON.stringify(evidence()))
  reversed.part_number.value = "TPS63802DLAR"
  reversed.ordering_code.value = "TPS63802"
  expect(() => parseComponentEvidence(reversed)).toThrow(
    "ordering_code must be a distinct exact orderable that extends part_number",
  )

  const identical = JSON.parse(JSON.stringify(evidence()))
  identical.ordering_code.value = identical.part_number.value
  expect(() => parseComponentEvidence(identical)).toThrow(
    "ordering_code must be a distinct exact orderable that extends part_number",
  )
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

test("agent-70/71 identifier and pad-kind variants canonicalize without changing engineering facts", () => {
  const variant = JSON.parse(JSON.stringify(evidence()))
  variant.pinout.pins[0].number = 1
  variant.pinout.pins[1].number = 2
  variant.footprint.pads[0].pin = 1
  variant.footprint.pads[1].pin = 2
  variant.footprint.pads[0].kind = "smd"
  variant.footprint.pads[1].kind = "SMD"

  const canonicalization = canonicalizeComponentEvidenceInput(variant)
  expect(canonicalization.changes).toContain("pinout.pins[0].number: integer -> string")
  expect(canonicalization.changes).toContain("footprint.pads[0].kind: smd -> smt")
  const parsed = parseComponentEvidence(variant)
  expect(parsed.pinout.pins.map(({ number }) => number)).toEqual(["1", "2"])
  expect(parsed.footprint.pads.map(({ pin, kind }) => ({ pin, kind }))).toEqual([
    { pin: "1", kind: "smt" },
    { pin: "2", kind: "smt" },
  ])
})

test("canonicalization stays strict for version and all prose orientation semantics", () => {
  const missing_version = JSON.parse(JSON.stringify(evidence()))
  Reflect.deleteProperty(missing_version, "version")
  expect(() => parseComponentEvidence(missing_version)).toThrow("must have version 1")

  for (const prose of [
    "Top view, pin 1 at upper left",
    "PCB-top land-pattern view; pin 1 is upper-left",
    "not a top-view drawing",
    "package top-view outline",
  ]) {
    const prose_orientation = JSON.parse(JSON.stringify(evidence()))
    prose_orientation.footprint.drawing_orientation.value = prose
    expect(() => parseComponentEvidence(prose_orientation)).toThrow("drawing_orientation.value is invalid")
  }
})

test("component evidence reports misspelled fields instead of silently dropping them", () => {
  const candidate = JSON.parse(JSON.stringify(evidence()))
  const first_pin = candidate.pinout.pins[0] as Record<string, unknown>
  first_pin.electrical_attribute = { open_drain: true }

  expect(() => parseComponentEvidence(candidate)).toThrow(
    "component evidence pinout.pins[0] contains unsupported fields: electrical_attribute",
  )
})

test("identity, package, and pinout facts require direct datasheet evidence", () => {
  const calculated_source: EvidenceSource = {
    page: 12,
    method: "calculated",
    confidence: "high",
    note: "Inferred rather than read from the datasheet.",
  }
  const package_standard_source: EvidenceSource = {
    page: 12,
    method: "package_standard",
    confidence: "high",
    note: "Taken from a package convention rather than the datasheet.",
  }
  const cases: Array<{
    label: string
    source: EvidenceSource
    replace_sources: (candidate: ComponentEvidence, source: EvidenceSource) => void
  }> = [
    {
      label: "part number",
      source: calculated_source,
      replace_sources: (candidate, source) => {
        candidate.part_number.sources = [source]
      },
    },
    {
      label: "ordering code",
      source: package_standard_source,
      replace_sources: (candidate, source) => {
        candidate.ordering_code!.sources = [source]
      },
    },
    {
      label: "package name",
      source: calculated_source,
      replace_sources: (candidate, source) => {
        candidate.package.name.sources = [source]
      },
    },
    {
      label: "package code",
      source: package_standard_source,
      replace_sources: (candidate, source) => {
        candidate.package.code!.sources = [source]
      },
    },
    {
      label: "package pin count",
      source: calculated_source,
      replace_sources: (candidate, source) => {
        candidate.package.pin_count.sources = [source]
      },
    },
    {
      label: "pin 1",
      source: package_standard_source,
      replace_sources: (candidate, source) => {
        candidate.pinout.pins[0]!.sources = [source]
      },
    },
  ]

  for (const entry of cases) {
    const candidate = structuredClone(evidence())
    entry.replace_sources(candidate, entry.source)
    expect(getComponentEvidenceBlockingReasons(candidate)).toContain(
      `${entry.label} must cite medium/high-confidence pdf_text or pdf_visual evidence`,
    )
  }
})

test("derived pad geometry must share a page with a direct visual footprint anchor", () => {
  for (const method of ["calculated", "package_standard"] as const) {
    const anchored = structuredClone(evidence())
    anchored.footprint.pads[1]!.sources = [
      {
        page: 12,
        method,
        confidence: "high",
        note: "Derived from the dimension leaders on the inspected land-pattern page.",
      },
    ]
    expect(getComponentEvidenceBlockingReasons(anchored)).toEqual([])

    const unanchored = structuredClone(anchored)
    unanchored.footprint.pads[1]!.sources[0]!.page = 13
    expect(getComponentEvidenceBlockingReasons(unanchored)).toContain(
      `pad 2 (2) ${method} geometry on page 13 has no medium/high-confidence pdf_visual footprint anchor on that page`,
    )
  }
})

test("agent-facing evidence guide is generated with the exact parser representations", () => {
  expect(COMPONENT_EVIDENCE_GUIDE).toContain('"version": 1')
  expect(COMPONENT_EVIDENCE_GUIDE).toContain('"number": "1"')
  expect(COMPONENT_EVIDENCE_GUIDE).toContain('"kind": "smt"')
  expect(COMPONENT_EVIDENCE_GUIDE).toContain('"value": "pcb_top"')
  expect(COMPONENT_EVIDENCE_GUIDE).toContain('"version": 4')
  expect(COMPONENT_EVIDENCE_GUIDE).toContain('"value": "BASE-PART-NUMBER"')
  expect(COMPONENT_EVIDENCE_GUIDE).toContain('"value": "BASE-PART-NUMBER-A"')
  expect(COMPONENT_EVIDENCE_GUIDE).toContain("part_number is the base device/family printed throughout")
})
