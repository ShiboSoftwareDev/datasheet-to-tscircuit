import type { AnyCircuitElement } from "circuit-json"
import type { ExpectedFootprintPad, FootprintPlan } from "./job-artifact-validator"

export type EvidenceConfidence = "high" | "medium" | "low"
export type EvidenceMethod = "pdf_text" | "pdf_visual" | "calculated" | "package_standard"
export type DrawingOrientation = "pcb_top" | "package_top" | "package_bottom" | "side" | "unknown"
export type SchematicPinRole =
  | "power_input"
  | "power_output"
  | "ground"
  | "input"
  | "output"
  | "bidirectional"
  | "passive"
  | "no_connect"
  | "other"

export interface EvidenceSource {
  page: number
  figure?: string
  method: EvidenceMethod
  confidence: EvidenceConfidence
  image?: string
  render_dpi?: number
  note?: string
}

export interface EvidenceField<T> {
  value: T
  sources: EvidenceSource[]
}

export interface PinEvidence {
  number: string
  labels: string[]
  role: SchematicPinRole
  description?: string
  sources: EvidenceSource[]
}

export interface EvidencePad extends ExpectedFootprintPad {
  sources: EvidenceSource[]
}

export interface ComponentEvidence {
  version: 1
  status: "resolved" | "human_review_required"
  part_number: EvidenceField<string>
  ordering_code?: EvidenceField<string>
  package: {
    name: EvidenceField<string>
    code?: EvidenceField<string>
    pin_count: EvidenceField<number>
  }
  pinout: {
    pins: PinEvidence[]
  }
  footprint: {
    view: "pcb_top"
    units: "mm"
    drawing_orientation: EvidenceField<DrawingOrientation>
    pads: EvidencePad[]
  }
  unresolved_ambiguities: string[]
}

type CircuitRecord = AnyCircuitElement & Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
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
    if (
      source.method !== "pdf_text" &&
      source.method !== "pdf_visual" &&
      source.method !== "calculated" &&
      source.method !== "package_standard"
    ) {
      throw new Error(`${source_label}.method is invalid`)
    }
    if (source.confidence !== "high" && source.confidence !== "medium" && source.confidence !== "low") {
      throw new Error(`${source_label}.confidence is invalid`)
    }
    const parsed: EvidenceSource = {
      page: source.page as number,
      method: source.method,
      confidence: source.confidence,
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

function parseField<T>(
  value: unknown,
  label: string,
  parse_value: (field_value: unknown, field_label: string) => T,
): EvidenceField<T> {
  if (!isRecord(value)) throw new Error(`${label} must contain value and sources`)
  return {
    value: parse_value(value.value, `${label}.value`),
    sources: parseSources(value.sources, `${label}.sources`),
  }
}

function parsePad(value: unknown, index: number): EvidencePad {
  const label = `component evidence footprint.pads[${index}]`
  if (!isRecord(value) || (value.kind !== "smt" && value.kind !== "plated_hole")) {
    throw new Error(`${label}.kind must be smt or plated_hole`)
  }
  const pad: EvidencePad = {
    pin: value.pin === null ? null : requiredText(value.pin, `${label}.pin`),
    kind: value.kind,
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
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.status !== "resolved" && value.status !== "human_review_required")
  ) {
    throw new Error("component-evidence.json must have version 1 and a valid status")
  }
  if (!isRecord(value.package)) throw new Error("component evidence package must be an object")
  if (!isRecord(value.pinout)) throw new Error("component evidence pinout must be an object")
  if (!isRecord(value.footprint) || value.footprint.view !== "pcb_top" || value.footprint.units !== "mm") {
    throw new Error('component evidence footprint must use view "pcb_top" and units "mm"')
  }
  if (!Array.isArray(value.pinout.pins) || value.pinout.pins.length === 0) {
    throw new Error("component evidence must contain a complete pin table")
  }
  const seen_pins = new Set<string>()
  const pin_roles = new Set<SchematicPinRole>([
    "power_input",
    "power_output",
    "ground",
    "input",
    "output",
    "bidirectional",
    "passive",
    "no_connect",
    "other",
  ])
  const pins = value.pinout.pins.map((pin, index): PinEvidence => {
    const label = `component evidence pinout.pins[${index}]`
    if (!isRecord(pin) || !Array.isArray(pin.labels) || pin.labels.length === 0) {
      throw new Error(`${label} must contain a number, labels, role, and sources`)
    }
    const number = requiredText(pin.number, `${label}.number`)
    const normalized_number = normalizePin(number)
    if (seen_pins.has(normalized_number)) throw new Error(`component evidence pin ${number} is duplicated`)
    seen_pins.add(normalized_number)
    if (typeof pin.role !== "string" || !pin_roles.has(pin.role as SchematicPinRole)) {
      throw new Error(`${label}.role is invalid`)
    }
    return {
      number,
      labels: pin.labels.map((pin_label, label_index) =>
        requiredText(pin_label, `${label}.labels[${label_index}]`),
      ),
      role: pin.role as SchematicPinRole,
      ...(pin.description === undefined
        ? {}
        : { description: requiredText(pin.description, `${label}.description`) }),
      sources: parseSources(pin.sources, `${label}.sources`),
    }
  })
  if (!Array.isArray(value.footprint.pads) || value.footprint.pads.length === 0) {
    throw new Error("component evidence must contain every copper pad")
  }
  const orientation_values = new Set<DrawingOrientation>([
    "pcb_top",
    "package_top",
    "package_bottom",
    "side",
    "unknown",
  ])
  const pin_count = parseField(value.package.pin_count, "component evidence package.pin_count", (count) => {
    if (!Number.isInteger(count) || (count as number) < 1) {
      throw new Error("component evidence package.pin_count.value must be a positive integer")
    }
    return count as number
  })
  const drawing_orientation = parseField(
    value.footprint.drawing_orientation,
    "component evidence footprint.drawing_orientation",
    (orientation, label) => {
      if (typeof orientation !== "string" || !orientation_values.has(orientation as DrawingOrientation)) {
        throw new Error(`${label} is invalid`)
      }
      return orientation as DrawingOrientation
    },
  )
  if (!Array.isArray(value.unresolved_ambiguities)) {
    throw new Error("component evidence unresolved_ambiguities must be an array")
  }
  return {
    version: 1,
    status: value.status,
    part_number: parseField(value.part_number, "component evidence part_number", requiredText),
    ...(value.ordering_code === undefined
      ? {}
      : {
          ordering_code: parseField(value.ordering_code, "component evidence ordering_code", requiredText),
        }),
    package: {
      name: parseField(value.package.name, "component evidence package.name", requiredText),
      ...(value.package.code === undefined
        ? {}
        : { code: parseField(value.package.code, "component evidence package.code", requiredText) }),
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

function hasReliableSource(sources: EvidenceSource[]): boolean {
  return sources.some((source) => source.confidence === "high" || source.confidence === "medium")
}

export function getComponentEvidenceBlockingReasons(evidence: ComponentEvidence): string[] {
  const errors: string[] = []
  if (evidence.status !== "resolved") errors.push("evidence status requires human review")
  for (const ambiguity of evidence.unresolved_ambiguities) errors.push(`unresolved ambiguity: ${ambiguity}`)
  if (evidence.package.pin_count.value !== evidence.pinout.pins.length) {
    errors.push(
      `package pin count is ${evidence.package.pin_count.value}, but the pin table has ${evidence.pinout.pins.length} entries`,
    )
  }
  const pin_numbers = new Set(evidence.pinout.pins.map((pin) => normalizePin(pin.number)))
  const padded_pins = new Set<string>()
  for (const pad of evidence.footprint.pads) {
    if (pad.pin === null) continue
    const pad_pin = normalizePin(pad.pin)
    padded_pins.add(pad_pin)
    if (!pin_numbers.has(pad_pin)) errors.push(`footprint pad references unknown electrical pin ${pad.pin}`)
  }
  for (const pin of evidence.pinout.pins) {
    if (!padded_pins.has(normalizePin(pin.number))) {
      errors.push(`pin ${pin.number} has no copper pad in the footprint evidence`)
    }
  }
  for (const [index, pad] of evidence.footprint.pads.entries()) {
    if (
      !pad.sources.some(
        (source) =>
          source.method === "pdf_visual" ||
          source.method === "calculated" ||
          source.method === "package_standard",
      )
    ) {
      errors.push(
        `pad ${index + 1} (${pad.pin ?? "mechanical"}) is not tied to visual, calculated, or package-standard geometry evidence`,
      )
    }
  }
  if (evidence.footprint.drawing_orientation.value !== "pcb_top") {
    errors.push(
      `land-pattern orientation is ${evidence.footprint.drawing_orientation.value}, not an approved PCB-top view`,
    )
  }
  if (
    !evidence.footprint.drawing_orientation.sources.some(
      (source) => source.method === "pdf_visual" && source.image === "visual-reference/land-pattern.png",
    )
  ) {
    errors.push("PCB-top orientation is not tied to the inspected land-pattern reference image")
  }
  const critical_sources = [
    ["part number", evidence.part_number.sources],
    ...(evidence.ordering_code ? ([["ordering code", evidence.ordering_code.sources]] as const) : []),
    ["package name", evidence.package.name.sources],
    ...(evidence.package.code ? ([["package code", evidence.package.code.sources]] as const) : []),
    ["package pin count", evidence.package.pin_count.sources],
    ["drawing orientation", evidence.footprint.drawing_orientation.sources],
    ...evidence.pinout.pins.map((pin) => [`pin ${pin.number}`, pin.sources] as const),
    ...evidence.footprint.pads.map(
      (pad, index) => [`pad ${index + 1} (${pad.pin ?? "mechanical"})`, pad.sources] as const,
    ),
  ] as const
  for (const [label, sources] of critical_sources) {
    if (!hasReliableSource(sources)) errors.push(`${label} has only low-confidence evidence`)
  }
  return errors
}

function normalizeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
}

function normalizePin(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^pin(?=[a-z]*\d+$)/, "")
}

function closeEnough(left: number, right: number, tolerance_mm: number): boolean {
  return Math.abs(left - right) <= tolerance_mm
}

function getPadAgreementErrors(
  evidence_pads: EvidencePad[],
  plan_pads: ExpectedFootprintPad[],
  tolerance_mm: number,
): string[] {
  const errors: string[] = []
  if (evidence_pads.length !== plan_pads.length) {
    errors.push(`evidence has ${evidence_pads.length} pads, but plan has ${plan_pads.length}`)
  }
  const unmatched = new Set(plan_pads.map((_, index) => index))
  for (const evidence_pad of evidence_pads) {
    const candidates = [...unmatched].filter((index) => {
      const plan_pad = plan_pads[index]!
      return (
        ((plan_pad.pin === null && evidence_pad.pin === null) ||
          (plan_pad.pin !== null &&
            evidence_pad.pin !== null &&
            normalizePin(plan_pad.pin) === normalizePin(evidence_pad.pin))) &&
        plan_pad.kind === evidence_pad.kind
      )
    })
    candidates.sort((left, right) => {
      const distance = (pad: ExpectedFootprintPad) =>
        Math.abs(pad.x - evidence_pad.x) +
        Math.abs(pad.y - evidence_pad.y) +
        Math.abs(pad.width - evidence_pad.width) +
        Math.abs(pad.height - evidence_pad.height)
      return distance(plan_pads[left]!) - distance(plan_pads[right]!)
    })
    const selected_index = candidates[0]
    if (selected_index === undefined) {
      errors.push(
        evidence_pad.pin === null
          ? `plan is missing unassigned ${evidence_pad.kind} mechanical pad`
          : `plan is missing ${evidence_pad.kind} pad for pin ${evidence_pad.pin}`,
      )
      continue
    }
    unmatched.delete(selected_index)
    const plan_pad = plan_pads[selected_index]!
    const fields = [
      ["x", evidence_pad.x, plan_pad.x],
      ["y", evidence_pad.y, plan_pad.y],
      ["width", evidence_pad.width, plan_pad.width],
      ["height", evidence_pad.height, plan_pad.height],
    ] as const
    if (evidence_pad.kind === "plated_hole") {
      if (
        evidence_pad.hole_width === undefined ||
        plan_pad.hole_width === undefined ||
        !closeEnough(evidence_pad.hole_width, plan_pad.hole_width, tolerance_mm)
      ) {
        errors.push(
          `${evidence_pad.pin === null ? "unassigned mechanical pad" : `pin ${evidence_pad.pin}`} hole width differs between evidence and plan`,
        )
      }
      if (
        evidence_pad.hole_height === undefined ||
        plan_pad.hole_height === undefined ||
        !closeEnough(evidence_pad.hole_height, plan_pad.hole_height, tolerance_mm)
      ) {
        errors.push(
          `${evidence_pad.pin === null ? "unassigned mechanical pad" : `pin ${evidence_pad.pin}`} hole height differs between evidence and plan`,
        )
      }
    }
    for (const [field, evidence_value, plan_value] of fields) {
      if (!closeEnough(evidence_value, plan_value, tolerance_mm)) {
        errors.push(
          `${evidence_pad.pin === null ? "unassigned mechanical pad" : `pin ${evidence_pad.pin}`} ${field} is ${plan_value} mm in plan, expected ${evidence_value} mm`,
        )
      }
    }
  }
  for (const index of unmatched) {
    const pad = plan_pads[index]!
    errors.push(
      pad.pin === null
        ? `plan has unexpected unassigned ${pad.kind} mechanical pad`
        : `plan has unexpected ${pad.kind} pad for pin ${pad.pin}`,
    )
  }
  return errors
}

export function getFootprintEvidenceErrors(
  evidence: ComponentEvidence,
  plan: FootprintPlan,
  tolerance_mm = 0.001,
): string[] {
  const errors = getPadAgreementErrors(evidence.footprint.pads, plan.pads, tolerance_mm)
  const evidence_pages = new Set(
    evidence.footprint.pads.flatMap((pad) => pad.sources.map((source) => source.page)),
  )
  for (const reference of plan.source_references) {
    if (!evidence_pages.has(reference.page)) {
      errors.push(`footprint plan cites page ${reference.page}, which is absent from pad evidence`)
    }
  }
  return errors
}

export function getIndependentComponentEvidenceErrors(
  primary: ComponentEvidence,
  independent: ComponentEvidence,
  tolerance_mm = 0.005,
): string[] {
  const errors: string[] = []
  for (const [label, left, right] of [
    ["part number", primary.part_number.value, independent.part_number.value],
    ["ordering code", primary.ordering_code?.value ?? "", independent.ordering_code?.value ?? ""],
  ] as const) {
    if (normalizeText(left) !== normalizeText(right)) {
      errors.push(`${label} disagrees: ${JSON.stringify(left)} versus ${JSON.stringify(right)}`)
    }
  }
  const primary_package_code = primary.package.code?.value
  const independent_package_code = independent.package.code?.value
  if (primary_package_code || independent_package_code) {
    if (
      !primary_package_code ||
      !independent_package_code ||
      normalizeText(primary_package_code) !== normalizeText(independent_package_code)
    ) {
      errors.push(
        `package code disagrees: ${JSON.stringify(primary_package_code ?? "missing")} versus ${JSON.stringify(independent_package_code ?? "missing")}`,
      )
    }
  } else if (normalizeText(primary.package.name.value) !== normalizeText(independent.package.name.value)) {
    errors.push(
      `package name disagrees without an exact package code: ${JSON.stringify(primary.package.name.value)} versus ${JSON.stringify(independent.package.name.value)}`,
    )
  }
  if (primary.package.pin_count.value !== independent.package.pin_count.value) {
    errors.push(
      `pin count disagrees: ${primary.package.pin_count.value} versus ${independent.package.pin_count.value}`,
    )
  }
  if (primary.footprint.drawing_orientation.value !== independent.footprint.drawing_orientation.value) {
    errors.push(
      `drawing orientation disagrees: ${primary.footprint.drawing_orientation.value} versus ${independent.footprint.drawing_orientation.value}`,
    )
  }
  const independent_pins = new Map(
    independent.pinout.pins.map((pin) => [normalizePin(pin.number), pin] as const),
  )
  for (const pin of primary.pinout.pins) {
    const other = independent_pins.get(normalizePin(pin.number))
    if (!other) {
      errors.push(`independent evidence is missing pin ${pin.number}`)
      continue
    }
    independent_pins.delete(normalizePin(pin.number))
    const left_labels = new Set(pin.labels.map(normalizeText))
    const right_labels = new Set(other.labels.map(normalizeText))
    if (
      left_labels.size !== right_labels.size ||
      [...left_labels].some((label) => !right_labels.has(label))
    ) {
      errors.push(
        `pin ${pin.number} labels disagree: ${pin.labels.join("/")} versus ${other.labels.join("/")}`,
      )
    }
    if (pin.role !== other.role) {
      errors.push(`pin ${pin.number} schematic role disagrees: ${pin.role} versus ${other.role}`)
    }
  }
  for (const pin of independent_pins.values())
    errors.push(`independent evidence has unexpected pin ${pin.number}`)
  errors.push(...getPadAgreementErrors(primary.footprint.pads, independent.footprint.pads, tolerance_mm))
  return errors
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

export function getPinoutEvidenceErrors(
  evidence: ComponentEvidence,
  circuit_json: AnyCircuitElement[],
): string[] {
  const ports = circuit_json
    .map((element) => element as CircuitRecord)
    .filter((element) => element.type === "source_port")
  const unmatched = new Set(ports.map((_, index) => index))
  const errors: string[] = []
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
    ].map(normalizeText)
    if (!pin.labels.map(normalizeText).some((label) => actual_labels.includes(label))) {
      errors.push(`pin ${pin.number} labels ${pin.labels.join("/")} are absent from its Circuit JSON port`)
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
