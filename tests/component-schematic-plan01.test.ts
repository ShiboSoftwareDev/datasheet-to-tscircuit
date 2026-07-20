import { expect, test } from "bun:test"
import type { AnyCircuitElement } from "circuit-json"
import {
  createComponentSchematicPlan,
  getComponentSchematicPlanErrors,
} from "@/server/component-schematic-plan"
import { parseComponentEvidence } from "@/server/component-evidence"

const source = {
  page: 4,
  method: "pdf_visual" as const,
  confidence: "high" as const,
  image: "visual-reference/land-pattern.png",
  render_dpi: 200,
}

function componentEvidence() {
  const pins = [
    ["1", "IN", "input"],
    ["2", "VDD", "power_input"],
    ["3", "GND", "ground"],
    ["4", "OUT", "output"],
    ["5", "A", "passive"],
    ["6", "B", "passive"],
    ["7", "NC", "no_connect"],
    ["8", "VOUT", "power_output"],
    ["9", "IO", "bidirectional"],
    ["10", "SPECIAL_A", "other"],
    ["11", "SPECIAL_B", "other"],
  ] as const
  return parseComponentEvidence({
    version: 1,
    status: "resolved",
    part_number: { value: "GENERIC-11", sources: [source] },
    package: {
      name: { value: "Generic package", sources: [source] },
      pin_count: { value: pins.length, sources: [source] },
    },
    pinout: {
      pins: pins.map(([number, label, role]) => ({ number, labels: [label], role, sources: [source] })),
    },
    footprint: {
      view: "pcb_top",
      units: "mm",
      drawing_orientation: { value: "pcb_top", sources: [source] },
      pads: pins.map(([number], index) => ({
        pin: number,
        kind: "smt",
        x: index,
        y: 0,
        width: 0.4,
        height: 0.8,
        sources: [source],
      })),
    },
    unresolved_ambiguities: [],
  })
}

test("schematic plan is deterministic and derived from general electrical roles", () => {
  const first = createComponentSchematicPlan(componentEvidence())
  const second = createComponentSchematicPlan(componentEvidence())
  expect(first).toEqual(second)
  expect(first.schPinArrangement).toEqual({
    leftSide: { direction: "top-to-bottom", pins: ["1", "5", "7", "10"] },
    rightSide: { direction: "top-to-bottom", pins: ["4", "6", "8", "9", "11"] },
    topSide: { direction: "left-to-right", pins: ["2"] },
    bottomSide: { direction: "left-to-right", pins: ["3"] },
  })
})

test("compiled schematic ports must match the server-derived side and order", () => {
  const plan = createComponentSchematicPlan(componentEvidence())
  const positions = {
    left: plan.schPinArrangement.leftSide.pins,
    right: plan.schPinArrangement.rightSide.pins,
    top: plan.schPinArrangement.topSide.pins,
    bottom: plan.schPinArrangement.bottomSide.pins,
  } as const
  const circuit: AnyCircuitElement[] = []
  for (const pin of Object.values(positions).flat()) {
    circuit.push({
      type: "source_port",
      source_port_id: `source-${pin}`,
      source_component_id: "u1",
      pin_number: Number(pin),
      port_hints: [pin],
    } as AnyCircuitElement)
  }
  for (const [side, pins] of Object.entries(positions)) {
    pins.forEach((pin, index) => {
      circuit.push({
        type: "schematic_port",
        schematic_port_id: `schematic-${pin}`,
        schematic_component_id: "sch-u1",
        source_port_id: `source-${pin}`,
        side_of_component: side,
        center:
          side === "left" || side === "right"
            ? { x: side === "left" ? -1 : 1, y: pins.length - index }
            : { x: index, y: side === "top" ? 1 : -1 },
      } as AnyCircuitElement)
    })
  }

  expect(getComponentSchematicPlanErrors(plan, circuit)).toEqual([])
  const pin1 = circuit.find(
    (element) =>
      element.type === "schematic_port" &&
      (element as unknown as Record<string, unknown>).source_port_id === "source-1",
  ) as unknown as Record<string, unknown>
  pin1.side_of_component = "right"
  expect(getComponentSchematicPlanErrors(plan, circuit)).toContain(
    "Schematic left pins are [5, 7, 10], expected [1, 5, 7, 10]",
  )
})
