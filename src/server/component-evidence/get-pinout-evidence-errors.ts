import type { AnyCircuitElement } from "circuit-json"
import { normalizeElectricalPinLabel } from "../pin-label-normalization"
import { normalizePin, normalizeText } from "./get-pad-agreement-errors"
import type { CircuitRecord } from "./parse-component-evidence"
import type { ComponentEvidence } from "./types"

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

export function getPinoutEvidenceErrors(
  evidence: ComponentEvidence,
  circuit_json: AnyCircuitElement[],
): string[] {
  const components = circuit_json
    .map((element) => element as CircuitRecord)
    .filter((element) => element.type === "source_component")
  const ports = circuit_json
    .map((element) => element as CircuitRecord)
    .filter((element) => element.type === "source_port")
  const unmatched = new Set(ports.map((_, index) => index))
  const errors: string[] = []
  const expected_part_number = evidence.ordering_code?.value ?? evidence.part_number.value
  if (components.length !== 1) {
    errors.push(`expected exactly one Circuit JSON source component, found ${components.length}`)
  } else {
    const component = components[0]
    const actual_part_number =
      typeof component?.manufacturer_part_number === "string" ? component.manufacturer_part_number : ""
    if (normalizeText(actual_part_number) !== normalizeText(expected_part_number)) {
      errors.push(
        `component manufacturer part number ${actual_part_number || "is missing"}; expected ${expected_part_number}`,
      )
    }
  }
  for (const pin of evidence.pinout.pins) {
    const expected_number = normalizePin(pin.number)
    const candidates = [...unmatched].filter((index) => {
      const port = ports[index]!
      const number_aliases = [
        typeof port.pin_number === "number" || typeof port.pin_number === "string"
          ? String(port.pin_number)
          : "",
        ...asStringArray(port.port_hints),
      ]
      return number_aliases.some((alias) => normalizePin(alias) === expected_number)
    })
    if (candidates.length !== 1) {
      errors.push(`evidence pin ${pin.number} resolved to ${candidates.length} Circuit JSON ports`)
      continue
    }
    const selected_index = candidates[0]!
    unmatched.delete(selected_index)
    const port = ports[selected_index]!
    const actual_labels = [
      typeof port.name === "string" ? port.name : "",
      ...asStringArray(port.port_hints),
    ].map(normalizeElectricalPinLabel)
    if (!pin.labels.map(normalizeElectricalPinLabel).every((label) => actual_labels.includes(label))) {
      errors.push(`pin ${pin.number} labels ${pin.labels.join("/")} are absent from its Circuit JSON port`)
    }
    const expected_attributes = {
      requires_power: pin.role === "power_input",
      provides_power: pin.role === "power_output",
      requires_ground: pin.role === "ground",
    } as const
    for (const [attribute, expected] of Object.entries(expected_attributes)) {
      const actual = port[attribute] === true
      if (actual === expected) continue
      errors.push(`pin ${pin.number} role ${pin.role} requires ${attribute}=${expected}, found ${actual}`)
    }
    const expected_open_drain = pin.electrical_attributes?.open_drain === true
    for (const attribute of ["can_use_open_drain", "is_using_open_drain"] as const) {
      const actual = port[attribute] === true
      if (actual === expected_open_drain) continue
      errors.push(
        `pin ${pin.number} open-drain evidence requires ${attribute}=${expected_open_drain}, found ${actual}`,
      )
    }
  }
  for (const index of unmatched) {
    const port = ports[index]!
    errors.push(
      `Circuit JSON has unexpected source port ${String(port.name ?? port.pin_number ?? index + 1)}`,
    )
  }
  return errors
}
