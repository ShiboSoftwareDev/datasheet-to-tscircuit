import type { AnyCircuitElement } from "circuit-json"
import type { ComponentEvidence, PinEvidence } from "./component-evidence"

export type SchematicSide = "left" | "right" | "top" | "bottom"
export type SchematicSideDirection = "top-to-bottom" | "left-to-right"

export interface ComponentSchematicPlan {
  version: 1
  generated_from: "component-evidence-v1"
  schPinArrangement: {
    leftSide: { direction: "top-to-bottom"; pins: string[] }
    rightSide: { direction: "top-to-bottom"; pins: string[] }
    topSide: { direction: "left-to-right"; pins: string[] }
    bottomSide: { direction: "left-to-right"; pins: string[] }
  }
}

type CircuitRecord = AnyCircuitElement & Record<string, unknown>

const pin_collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" })

function sortPins(pins: PinEvidence[]): PinEvidence[] {
  return [...pins].sort((left, right) => pin_collator.compare(left.number, right.number))
}

export function createComponentSchematicPlan(evidence: ComponentEvidence): ComponentSchematicPlan {
  const left: PinEvidence[] = []
  const right: PinEvidence[] = []
  const top: PinEvidence[] = []
  const bottom: PinEvidence[] = []
  const flexible: PinEvidence[] = []

  for (const pin of sortPins(evidence.pinout.pins)) {
    if (pin.role === "power_input") top.push(pin)
    else if (pin.role === "ground") bottom.push(pin)
    else if (pin.role === "input" || pin.role === "no_connect") left.push(pin)
    else if (pin.role === "output" || pin.role === "power_output" || pin.role === "bidirectional") {
      right.push(pin)
    } else {
      flexible.push(pin)
    }
  }

  for (const [index, pin] of flexible.entries()) {
    if (index % 2 === 0) left.push(pin)
    else right.push(pin)
  }

  return {
    version: 1,
    generated_from: "component-evidence-v1",
    schPinArrangement: {
      leftSide: { direction: "top-to-bottom", pins: sortPins(left).map((pin) => pin.number) },
      rightSide: { direction: "top-to-bottom", pins: sortPins(right).map((pin) => pin.number) },
      topSide: { direction: "left-to-right", pins: sortPins(top).map((pin) => pin.number) },
      bottomSide: { direction: "left-to-right", pins: sortPins(bottom).map((pin) => pin.number) },
    },
  }
}

function normalizePin(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^pin(?=[a-z]*\d+$)/, "")
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function getPortPinNumber(port: CircuitRecord): string | undefined {
  if (typeof port.pin_number === "number" || typeof port.pin_number === "string") {
    return normalizePin(String(port.pin_number))
  }
  for (const hint of asStringArray(port.port_hints)) {
    const normalized = normalizePin(hint)
    if (/^[a-z]*\d+$/.test(normalized)) return normalized
  }
  return undefined
}

function getCenterCoordinate(port: CircuitRecord, axis: "x" | "y"): number | undefined {
  if (typeof port.center !== "object" || port.center === null) return undefined
  const value = (port.center as Record<string, unknown>)[axis]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function getComponentSchematicPlanErrors(
  plan: ComponentSchematicPlan,
  circuit_json: AnyCircuitElement[],
): string[] {
  const records = circuit_json.map((element) => element as CircuitRecord)
  const source_ports_by_id = new Map<string, CircuitRecord>()
  for (const port of records.filter((record) => record.type === "source_port")) {
    if (typeof port.source_port_id === "string") source_ports_by_id.set(port.source_port_id, port)
  }

  const expected_by_side: Record<SchematicSide, string[]> = {
    left: plan.schPinArrangement.leftSide.pins.map(normalizePin),
    right: plan.schPinArrangement.rightSide.pins.map(normalizePin),
    top: plan.schPinArrangement.topSide.pins.map(normalizePin),
    bottom: plan.schPinArrangement.bottomSide.pins.map(normalizePin),
  }
  const expected_pins = new Set(Object.values(expected_by_side).flat())
  const actual_by_side: Record<SchematicSide, Array<{ pin: string; x: number; y: number }>> = {
    left: [],
    right: [],
    top: [],
    bottom: [],
  }
  const errors: string[] = []

  for (const schematic_port of records.filter((record) => record.type === "schematic_port")) {
    if (typeof schematic_port.source_port_id !== "string") continue
    const source_port = source_ports_by_id.get(schematic_port.source_port_id)
    if (!source_port) continue
    const pin = getPortPinNumber(source_port)
    if (!pin || !expected_pins.has(pin)) continue
    const side = schematic_port.side_of_component
    const x = getCenterCoordinate(schematic_port, "x")
    const y = getCenterCoordinate(schematic_port, "y")
    if (side !== "left" && side !== "right" && side !== "top" && side !== "bottom") {
      errors.push(`Schematic pin ${pin} has no valid component side`)
      continue
    }
    if (x === undefined || y === undefined) {
      errors.push(`Schematic pin ${pin} has no finite center coordinate`)
      continue
    }
    actual_by_side[side].push({ pin, x, y })
  }

  for (const side of ["left", "right", "top", "bottom"] as const) {
    actual_by_side[side].sort((a, b) => (side === "left" || side === "right" ? b.y - a.y : a.x - b.x))
    const actual = actual_by_side[side].map(({ pin }) => pin)
    const expected = expected_by_side[side]
    if (actual.join("\0") !== expected.join("\0")) {
      errors.push(`Schematic ${side} pins are [${actual.join(", ")}], expected [${expected.join(", ")}]`)
    }
  }
  return errors
}
