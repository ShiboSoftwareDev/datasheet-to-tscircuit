import type { AnyCircuitElement } from "circuit-json"
import { physicalPinFromHints } from "../component-evidence"

export interface ExpectedFootprintPad {
  pin: string | null
  kind: "smt" | "plated_hole"
  x: number
  y: number
  width: number
  height: number
  hole_width?: number
  hole_height?: number
}

export interface FootprintPlan {
  version: 1
  view: "pcb_top"
  source_references: Array<{ page: number; figure?: string }>
  pads: ExpectedFootprintPad[]
}

export type CircuitRecord = AnyCircuitElement & Record<string, unknown>

export function asRecord(element: AnyCircuitElement): CircuitRecord {
  return element as CircuitRecord
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function normalizedPin(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^pin(?=\d+$)/, "")
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

interface ActualFootprintPad {
  pins: string[]
  kind: "smt" | "plated_hole"
  x: number
  y: number
  width: number
  height: number
  hole_width?: number
  hole_height?: number
}

function getActualFootprintPads(circuit_json: AnyCircuitElement[]): ActualFootprintPad[] {
  return circuit_json.flatMap<ActualFootprintPad>((element): ActualFootprintPad[] => {
    const record = asRecord(element)
    if (record.type !== "pcb_smtpad" && record.type !== "pcb_plated_hole") return []
    const hints = asStringArray(record.port_hints)
    const physical_pin = physicalPinFromHints(hints)
    const x = finiteNumber(record.x)
    const y = finiteNumber(record.y)
    if (x === undefined || y === undefined) return []

    if (record.type === "pcb_smtpad") {
      const width = finiteNumber(record.width)
      const height = finiteNumber(record.height)
      if (width === undefined || height === undefined) return []
      return [
        {
          pins: [...(physical_pin ? [normalizedPin(physical_pin)] : []), ...hints.map(normalizedPin)],
          kind: "smt" as const,
          x,
          y,
          width,
          height,
        },
      ]
    }

    let width: number | undefined
    let height: number | undefined
    let hole_width: number | undefined
    let hole_height: number | undefined
    if (record.shape === "circle") {
      width = height = finiteNumber(record.outer_diameter)
      hole_width = hole_height = finiteNumber(record.hole_diameter)
    } else if (record.shape === "circular_hole_with_rect_pad") {
      width = finiteNumber(record.rect_pad_width)
      height = finiteNumber(record.rect_pad_height)
      hole_width = hole_height = finiteNumber(record.hole_diameter)
    } else {
      width = finiteNumber(record.rect_pad_width)
      height = finiteNumber(record.rect_pad_height)
      hole_width = finiteNumber(record.hole_width)
      hole_height = finiteNumber(record.hole_height)
    }
    if (
      width === undefined ||
      height === undefined ||
      hole_width === undefined ||
      hole_height === undefined
    ) {
      return []
    }
    return [
      {
        pins: [...(physical_pin ? [normalizedPin(physical_pin)] : []), ...hints.map(normalizedPin)],
        kind: "plated_hole" as const,
        x,
        y,
        width,
        height,
        hole_width,
        hole_height,
      },
    ]
  })
}

const FOOTPRINT_TOLERANCE_MM = 0.02

function closeEnough(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= FOOTPRINT_TOLERANCE_MM
}

export function getFootprintPlanErrors(plan: FootprintPlan, circuit_json: AnyCircuitElement[]): string[] {
  const errors: string[] = []
  const actual_pads = getActualFootprintPads(circuit_json)
  if (actual_pads.length !== plan.pads.length) {
    errors.push(`Expected ${plan.pads.length} footprint pads, found ${actual_pads.length}`)
  }
  const unmatched = new Set(actual_pads.map((_, index) => index))
  for (const expected of plan.pads) {
    const candidate_indices = [...unmatched].filter(
      (index) =>
        (expected.pin === null
          ? actual_pads[index]!.pins.length === 0
          : actual_pads[index]!.pins.includes(normalizedPin(expected.pin))) &&
        actual_pads[index]!.kind === expected.kind,
    )
    if (candidate_indices.length === 0) {
      errors.push(
        expected.pin === null
          ? `Expected unassigned ${expected.kind} mechanical pad is missing`
          : `Expected ${expected.kind} pad for pin ${expected.pin} is missing`,
      )
      continue
    }
    candidate_indices.sort((left, right) => {
      const left_pad = actual_pads[left]!
      const right_pad = actual_pads[right]!
      const distance = (pad: ActualFootprintPad) =>
        Math.abs(pad.x - expected.x) +
        Math.abs(pad.y - expected.y) +
        Math.abs(pad.width - expected.width) +
        Math.abs(pad.height - expected.height)
      return distance(left_pad) - distance(right_pad)
    })
    const selected_index = candidate_indices[0]!
    const actual = actual_pads[selected_index]!
    unmatched.delete(selected_index)
    const mismatches: string[] = []
    for (const [label, actual_value, expected_value] of [
      ["x", actual.x, expected.x],
      ["y", actual.y, expected.y],
      ["width", actual.width, expected.width],
      ["height", actual.height, expected.height],
    ] as const) {
      if (!closeEnough(actual_value, expected_value)) {
        mismatches.push(`${label} ${actual_value} mm (expected ${expected_value} mm)`)
      }
    }
    if (expected.kind === "plated_hole") {
      for (const [label, actual_value, expected_value] of [
        ["hole width", actual.hole_width, expected.hole_width],
        ["hole height", actual.hole_height, expected.hole_height],
      ] as const) {
        if (
          actual_value === undefined ||
          expected_value === undefined ||
          !closeEnough(actual_value, expected_value)
        ) {
          mismatches.push(
            `${label} ${actual_value ?? "missing"} mm (expected ${expected_value ?? "missing"} mm)`,
          )
        }
      }
    }
    if (mismatches.length > 0) {
      errors.push(
        `${expected.pin === null ? "Unassigned mechanical pad" : `Pin ${expected.pin}`}: ${mismatches.join(", ")}`,
      )
    }
  }
  for (const index of unmatched) {
    const pad = actual_pads[index]!
    errors.push(
      pad.pins.length === 0
        ? `Unexpected unassigned ${pad.kind} mechanical pad at (${pad.x}, ${pad.y}) mm`
        : `Unexpected ${pad.kind} pad for pin ${pad.pins.join("/")} at (${pad.x}, ${pad.y}) mm`,
    )
  }
  return errors
}
