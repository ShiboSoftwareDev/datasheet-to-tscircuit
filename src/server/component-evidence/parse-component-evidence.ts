import type { AnyCircuitElement } from "circuit-json"
import { canonicalizeComponentEvidenceInput } from "./canonicalize-component-evidence"
import {
  COMPONENT_EVIDENCE_STATUSES,
  COMPONENT_EVIDENCE_VERSION,
  DRAWING_ORIENTATIONS,
  EVIDENCE_CONFIDENCES,
  EVIDENCE_METHODS,
  EVIDENCE_PAD_KINDS,
  SCHEMATIC_PIN_ROLES,
} from "./contract"
import { normalizePin } from "./get-pad-agreement-errors"
import type {
  ComponentEvidence,
  DrawingOrientation,
  EvidenceField,
  EvidencePad,
  EvidenceSource,
  PinEvidence,
  SchematicPinRole,
} from "./types"

export type CircuitRecord = AnyCircuitElement & Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowed_keys = new Set(allowed)
  const unexpected = Object.keys(value)
    .filter((key) => !allowed_keys.has(key))
    .sort()
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unexpected.join(", ")}`)
  }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function normalizedPartIdentity(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`)
  }
  return value
}

function parseSources(value: unknown, label: string): EvidenceSource[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must cite at least one evidence source`)
  }
  return value.map((source, index) => {
    const source_label = `${label}[${index}]`
    if (!isRecord(source) || !Number.isInteger(source.page) || (source.page as number) < 1) {
      throw new Error(`${source_label}.page must be a positive PDF page number`)
    }
    assertOnlyKeys(
      source,
      ["page", "figure", "method", "confidence", "image", "render_dpi", "note"],
      source_label,
    )
    if (!EVIDENCE_METHODS.includes(source.method as (typeof EVIDENCE_METHODS)[number])) {
      throw new Error(`${source_label}.method is invalid`)
    }
    if (!EVIDENCE_CONFIDENCES.includes(source.confidence as (typeof EVIDENCE_CONFIDENCES)[number])) {
      throw new Error(`${source_label}.confidence is invalid`)
    }
    const parsed: EvidenceSource = {
      page: source.page as number,
      method: source.method as EvidenceSource["method"],
      confidence: source.confidence as EvidenceSource["confidence"],
      ...(source.figure === undefined
        ? {}
        : { figure: requiredText(source.figure, `${source_label}.figure`) }),
      ...(source.image === undefined ? {} : { image: requiredText(source.image, `${source_label}.image`) }),
      ...(source.render_dpi === undefined
        ? {}
        : { render_dpi: requiredFiniteNumber(source.render_dpi, `${source_label}.render_dpi`) }),
      ...(source.note === undefined ? {} : { note: requiredText(source.note, `${source_label}.note`) }),
    }
    if (parsed.method === "pdf_visual" && (!parsed.image || parsed.render_dpi !== 200)) {
      throw new Error(`${source_label} must record an image rendered at exactly 200 DPI`)
    }
    if ((parsed.method === "calculated" || parsed.method === "package_standard") && !parsed.note) {
      throw new Error(`${source_label} must explain its ${parsed.method} source in note`)
    }
    if (
      parsed.image &&
      (parsed.image.startsWith("/") || parsed.image.split(/[\\/]/).some((segment) => segment === ".."))
    ) {
      throw new Error(`${source_label}.image must be a relative path inside the evidence workspace`)
    }
    return parsed
  })
}

function parseField<T>(input: {
  value: unknown
  label: string
  parse_value: (field_value: unknown, field_label: string) => T
}): EvidenceField<T> {
  const { value, label, parse_value } = input
  if (!isRecord(value)) throw new Error(`${label} must contain value and sources`)
  assertOnlyKeys(value, ["value", "sources"], label)
  return {
    value: parse_value(value.value, `${label}.value`),
    sources: parseSources(value.sources, `${label}.sources`),
  }
}

function parsePad(value: unknown, index: number): EvidencePad {
  const label = `component evidence footprint.pads[${index}]`
  if (!isRecord(value) || !EVIDENCE_PAD_KINDS.includes(value.kind as (typeof EVIDENCE_PAD_KINDS)[number])) {
    throw new Error(`${label}.kind must be smt or plated_hole`)
  }
  assertOnlyKeys(
    value,
    ["pin", "kind", "x", "y", "width", "height", "hole_width", "hole_height", "sources"],
    label,
  )
  const pad: EvidencePad = {
    pin: value.pin === null ? null : requiredText(value.pin, `${label}.pin`),
    kind: value.kind as EvidencePad["kind"],
    x: requiredFiniteNumber(value.x, `${label}.x`),
    y: requiredFiniteNumber(value.y, `${label}.y`),
    width: requiredFiniteNumber(value.width, `${label}.width`),
    height: requiredFiniteNumber(value.height, `${label}.height`),
    ...(value.hole_width === undefined
      ? {}
      : { hole_width: requiredFiniteNumber(value.hole_width, `${label}.hole_width`) }),
    ...(value.hole_height === undefined
      ? {}
      : { hole_height: requiredFiniteNumber(value.hole_height, `${label}.hole_height`) }),
    sources: parseSources(value.sources, `${label}.sources`),
  }
  if (pad.width <= 0 || pad.height <= 0) throw new Error(`${label} dimensions must be positive`)
  if (
    pad.kind === "plated_hole" &&
    (!pad.hole_width || !pad.hole_height || pad.hole_width <= 0 || pad.hole_height <= 0)
  ) {
    throw new Error(`${label} must include positive hole dimensions`)
  }
  return pad
}

export function parseComponentEvidence(value: unknown): ComponentEvidence {
  value = canonicalizeComponentEvidenceInput(value).value
  if (isRecord(value)) {
    assertOnlyKeys(
      value,
      [
        "version",
        "status",
        "part_number",
        "ordering_code",
        "package",
        "pinout",
        "footprint",
        "unresolved_ambiguities",
      ],
      "component evidence",
    )
  }
  if (
    !isRecord(value) ||
    value.version !== COMPONENT_EVIDENCE_VERSION ||
    !COMPONENT_EVIDENCE_STATUSES.includes(value.status as (typeof COMPONENT_EVIDENCE_STATUSES)[number])
  ) {
    throw new Error("component-evidence.json must have version 1 and a valid status")
  }
  if (!isRecord(value.package)) throw new Error("component evidence package must be an object")
  if (!isRecord(value.pinout)) throw new Error("component evidence pinout must be an object")
  if (!isRecord(value.footprint) || value.footprint.view !== "pcb_top" || value.footprint.units !== "mm") {
    throw new Error('component evidence footprint must use view "pcb_top" and units "mm"')
  }
  assertOnlyKeys(value.package, ["name", "code", "pin_count"], "component evidence package")
  assertOnlyKeys(value.pinout, ["pins"], "component evidence pinout")
  assertOnlyKeys(
    value.footprint,
    ["view", "units", "drawing_orientation", "pads"],
    "component evidence footprint",
  )
  if (!Array.isArray(value.pinout.pins) || (value.status === "resolved" && value.pinout.pins.length === 0)) {
    throw new Error("component evidence must contain a complete pin table")
  }
  const seen_pins = new Set<string>()
  const pin_roles = new Set<SchematicPinRole>(SCHEMATIC_PIN_ROLES)
  const pins = value.pinout.pins.map((pin, index): PinEvidence => {
    const label = `component evidence pinout.pins[${index}]`
    if (!isRecord(pin) || !Array.isArray(pin.labels) || pin.labels.length === 0) {
      throw new Error(`${label} must contain a number, labels, role, and sources`)
    }
    assertOnlyKeys(
      pin,
      ["number", "labels", "role", "electrical_attributes", "description", "sources"],
      label,
    )
    const number = requiredText(pin.number, `${label}.number`)
    const normalized_number = normalizePin(number)
    if (seen_pins.has(normalized_number)) throw new Error(`component evidence pin ${number} is duplicated`)
    seen_pins.add(normalized_number)
    if (typeof pin.role !== "string" || !pin_roles.has(pin.role as SchematicPinRole)) {
      throw new Error(`${label}.role is invalid`)
    }
    if (pin.electrical_attributes !== undefined) {
      if (!isRecord(pin.electrical_attributes)) {
        throw new Error(`${label}.electrical_attributes must be an object`)
      }
      assertOnlyKeys(pin.electrical_attributes, ["open_drain"], `${label}.electrical_attributes`)
      if (
        pin.electrical_attributes.open_drain !== undefined &&
        typeof pin.electrical_attributes.open_drain !== "boolean"
      ) {
        throw new Error(`${label}.electrical_attributes.open_drain must be boolean`)
      }
      if (
        pin.electrical_attributes.open_drain === true &&
        pin.role !== "output" &&
        pin.role !== "bidirectional"
      ) {
        throw new Error(`${label}.electrical_attributes.open_drain requires an output or bidirectional role`)
      }
    }
    return {
      number,
      labels: pin.labels.map((pin_label, label_index) =>
        requiredText(pin_label, `${label}.labels[${label_index}]`),
      ),
      role: pin.role as SchematicPinRole,
      ...(pin.electrical_attributes === undefined
        ? {}
        : {
            electrical_attributes: {
              ...(typeof pin.electrical_attributes.open_drain === "boolean"
                ? { open_drain: pin.electrical_attributes.open_drain }
                : {}),
            },
          }),
      ...(pin.description === undefined
        ? {}
        : { description: requiredText(pin.description, `${label}.description`) }),
      sources: parseSources(pin.sources, `${label}.sources`),
    }
  })
  if (
    !Array.isArray(value.footprint.pads) ||
    (value.status === "resolved" && value.footprint.pads.length === 0)
  ) {
    throw new Error("component evidence must contain every copper pad")
  }
  const orientation_values = new Set<DrawingOrientation>(DRAWING_ORIENTATIONS)
  const pin_count = parseField({
    value: value.package.pin_count,
    label: "component evidence package.pin_count",
    parse_value: (count) => {
      if (!Number.isInteger(count) || (count as number) < 1) {
        throw new Error("component evidence package.pin_count.value must be a positive integer")
      }
      return count as number
    },
  })
  const drawing_orientation = parseField({
    value: value.footprint.drawing_orientation,
    label: "component evidence footprint.drawing_orientation",
    parse_value: (orientation, label) => {
      if (typeof orientation !== "string" || !orientation_values.has(orientation as DrawingOrientation)) {
        throw new Error(`${label} is invalid`)
      }
      return orientation as DrawingOrientation
    },
  })
  if (!Array.isArray(value.unresolved_ambiguities)) {
    throw new Error("component evidence unresolved_ambiguities must be an array")
  }
  const part_number = parseField({
    value: value.part_number,
    label: "component evidence part_number",
    parse_value: requiredText,
  })
  const ordering_code =
    value.ordering_code === undefined
      ? undefined
      : parseField({
          value: value.ordering_code,
          label: "component evidence ordering_code",
          parse_value: requiredText,
        })
  if (ordering_code) {
    const normalized_part_number = normalizedPartIdentity(part_number.value)
    const normalized_ordering_code = normalizedPartIdentity(ordering_code.value)
    if (
      normalized_ordering_code === normalized_part_number ||
      !normalized_ordering_code.startsWith(normalized_part_number)
    ) {
      throw new Error(
        "component evidence ordering_code must be a distinct exact orderable that extends part_number",
      )
    }
  }
  return {
    version: 1,
    status: value.status as ComponentEvidence["status"],
    part_number,
    ...(ordering_code ? { ordering_code } : {}),
    package: {
      name: parseField({
        value: value.package.name,
        label: "component evidence package.name",
        parse_value: requiredText,
      }),
      ...(value.package.code === undefined
        ? {}
        : {
            code: parseField({
              value: value.package.code,
              label: "component evidence package.code",
              parse_value: requiredText,
            }),
          }),
      pin_count,
    },
    pinout: { pins },
    footprint: {
      view: "pcb_top",
      units: "mm",
      drawing_orientation,
      pads: value.footprint.pads.map(parsePad),
    },
    unresolved_ambiguities: value.unresolved_ambiguities.map((ambiguity, index) =>
      requiredText(ambiguity, `component evidence unresolved_ambiguities[${index}]`),
    ),
  }
}
