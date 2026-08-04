import { COMPONENT_EVIDENCE_SCHEMA_ID } from "./contract"

export interface ComponentEvidenceCanonicalization {
  readonly value: unknown
  readonly changes: readonly string[]
  readonly schema_id: typeof COMPONENT_EVIDENCE_SCHEMA_ID
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function canonicalPinIdentifier(value: unknown): unknown {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : value
}

/**
 * Accepts only representation-equivalent variants seen at the agent boundary.
 * It never invents identity, geometry, pin labels, sources, or connectivity.
 */
export function canonicalizeComponentEvidenceInput(value: unknown): ComponentEvidenceCanonicalization {
  if (!isRecord(value)) {
    return { value, changes: [], schema_id: COMPONENT_EVIDENCE_SCHEMA_ID }
  }

  const changes: string[] = []
  const canonical: Record<string, unknown> = { ...value }

  if (isRecord(value.pinout) && Array.isArray(value.pinout.pins)) {
    canonical.pinout = {
      ...value.pinout,
      pins: value.pinout.pins.map((pin, index) => {
        if (!isRecord(pin)) return pin
        const number = canonicalPinIdentifier(pin.number)
        if (number !== pin.number) {
          changes.push(`pinout.pins[${index}].number: integer -> string`)
        }
        return { ...pin, number }
      }),
    }
  }

  if (isRecord(value.footprint)) {
    const footprint: Record<string, unknown> = { ...value.footprint }
    if (Array.isArray(value.footprint.pads)) {
      footprint.pads = value.footprint.pads.map((pad, index) => {
        if (!isRecord(pad)) return pad
        const pin = canonicalPinIdentifier(pad.pin)
        const kind = typeof pad.kind === "string" && pad.kind.toLowerCase() === "smd" ? "smt" : pad.kind
        if (pin !== pad.pin) changes.push(`footprint.pads[${index}].pin: integer -> string`)
        if (kind !== pad.kind) changes.push(`footprint.pads[${index}].kind: smd -> smt`)
        return { ...pad, pin, kind }
      })
    }
    canonical.footprint = footprint
  }

  return {
    value: canonical,
    changes: Object.freeze(changes),
    schema_id: COMPONENT_EVIDENCE_SCHEMA_ID,
  }
}
