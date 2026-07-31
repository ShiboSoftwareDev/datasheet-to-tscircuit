import type { AnyCircuitElement } from "circuit-json"
import { normalizeElectricalPinLabel } from "../pin-label-normalization"
import { asRecord, asStringArray, type CircuitRecord } from "./footprint-plan-validation"

const TARGET_IDENTITY_FIELDS = ["manufacturer_part_number"] as const
const TARGET_PORT_BOOLEAN_FIELDS = [
  "requires_power",
  "provides_power",
  "requires_ground",
  "can_use_open_drain",
  "is_using_open_drain",
] as const

function componentName(component: CircuitRecord): string {
  for (const value of [component.name, component.reference, component.refdes]) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return ""
}

function normalizedPinNumber(port: CircuitRecord): string | undefined {
  const candidates = [
    typeof port.pin_number === "string" || typeof port.pin_number === "number"
      ? String(port.pin_number)
      : undefined,
    ...asStringArray(port.port_hints),
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    const normalized = candidate
      .trim()
      .toLowerCase()
      .replace(/^pin(?=[a-z]*\d+$)/, "")
    if (/^[a-z]*\d+$/.test(normalized)) return normalized
  }
  return undefined
}

function normalizedAliases(port: CircuitRecord): Set<string> {
  return new Set(
    [typeof port.name === "string" ? port.name : "", ...asStringArray(port.port_hints)]
      .map(normalizeElectricalPinLabel)
      .filter(Boolean),
  )
}

function portsForComponent(records: CircuitRecord[], component: CircuitRecord): CircuitRecord[] {
  if (typeof component.source_component_id !== "string") return []
  return records.filter(
    (record) => record.type === "source_port" && record.source_component_id === component.source_component_id,
  )
}

function portsByPinNumber(
  ports: CircuitRecord[],
  label: string,
  errors: string[],
): Map<string, CircuitRecord> {
  const result = new Map<string, CircuitRecord>()
  for (const port of ports) {
    const pin_number = normalizedPinNumber(port)
    if (!pin_number) {
      errors.push(
        `${label} port ${String(port.name ?? port.source_port_id ?? "unknown")} has no stable pin number`,
      )
      continue
    }
    if (result.has(pin_number)) {
      errors.push(`${label} exposes pin ${pin_number} more than once`)
      continue
    }
    result.set(pin_number, port)
  }
  return result
}

/** Verify that application U1 is the exact validated component, not a source-level substitute. */
export function getTypicalApplicationTargetComponentErrors(
  validated_component_circuit_json: AnyCircuitElement[],
  application_circuit_json: AnyCircuitElement[],
): string[] {
  const errors: string[] = []
  const validated_records = validated_component_circuit_json.map(asRecord)
  const application_records = application_circuit_json.map(asRecord)
  const validated_components = validated_records.filter((record) => record.type === "source_component")
  const application_targets = application_records.filter(
    (record) => record.type === "source_component" && componentName(record).toLowerCase() === "u1",
  )
  if (validated_components.length !== 1 || application_targets.length !== 1) {
    if (validated_components.length !== 1) {
      errors.push(`Validated component contract contains ${validated_components.length} source components`)
    }
    if (application_targets.length !== 1) {
      errors.push(`Typical application contains ${application_targets.length} target components named U1`)
    }
    return errors
  }

  const validated_component = validated_components[0]
  const application_target = application_targets[0]
  if (!validated_component || !application_target) return errors
  for (const field of TARGET_IDENTITY_FIELDS) {
    const expected = typeof validated_component[field] === "string" ? validated_component[field].trim() : ""
    const actual = typeof application_target[field] === "string" ? application_target[field].trim() : ""
    if (expected.toLowerCase() !== actual.toLowerCase()) {
      errors.push(
        `Typical application U1 ${field} is ${JSON.stringify(actual || "missing")}, expected validated value ${JSON.stringify(expected || "missing")}`,
      )
    }
  }

  const expected_ports = portsByPinNumber(
    portsForComponent(validated_records, validated_component),
    "Validated component",
    errors,
  )
  const actual_ports = portsByPinNumber(
    portsForComponent(application_records, application_target),
    "Typical application U1",
    errors,
  )
  for (const [pin_number, expected_port] of expected_ports) {
    const actual_port = actual_ports.get(pin_number)
    if (!actual_port) {
      errors.push(`Typical application U1 is missing validated pin ${pin_number}`)
      continue
    }
    const actual_aliases = normalizedAliases(actual_port)
    const missing_aliases = [...normalizedAliases(expected_port)].filter(
      (alias) => !actual_aliases.has(alias),
    )
    if (missing_aliases.length > 0) {
      errors.push(
        `Typical application U1 pin ${pin_number} is missing validated aliases: ${missing_aliases.join(", ")}`,
      )
    }
    for (const field of TARGET_PORT_BOOLEAN_FIELDS) {
      if ((expected_port[field] === true) !== (actual_port[field] === true)) {
        errors.push(
          `Typical application U1 pin ${pin_number} has ${field}=${actual_port[field] === true}, expected ${expected_port[field] === true}`,
        )
      }
    }
  }
  for (const pin_number of actual_ports.keys()) {
    if (!expected_ports.has(pin_number)) {
      errors.push(`Typical application U1 has unexpected pin ${pin_number}`)
    }
  }
  return errors
}
