import { normalizePin } from "./get-pad-agreement-errors"
import { parseComponentEvidence } from "./parse-component-evidence"
import type { ComponentEvidence, EvidencePad } from "./types"

const FOOTPRINT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_FOOTPRINT_VARIANTS = 24
const GEOMETRY_QUANTUM_MM = 0.01

export interface ComponentFootprintVariant {
  footprint_id: string
  label: string
  aliases: string[]
  ordering_codes: string[]
  component_evidence: ComponentEvidence
}

export interface ComponentFootprintCatalog {
  version: 1
  default_footprint_id: string
  footprints: ComponentFootprintVariant[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}`)
  }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function requiredFootprintId(value: unknown, label: string): string {
  const id = requiredText(value, label)
  if (!FOOTPRINT_ID_PATTERN.test(id)) {
    throw new Error(`${label} must be a lowercase hyphenated identifier`)
  }
  return id
}

function parseTextArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return [...new Set(value.map((entry, index) => requiredText(entry, `${label}[${index}]`)))].sort(
    (left, right) => left.localeCompare(right),
  )
}

function normalizedIdentity(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
}

function quantize(value: number): number {
  const rounded = Math.round(value / GEOMETRY_QUANTUM_MM) * GEOMETRY_QUANTUM_MM
  return Object.is(rounded, -0) ? 0 : Number(rounded.toFixed(6))
}

function rotatePad(pad: EvidencePad, quarter_turns: number): Omit<EvidencePad, "sources"> {
  const turn = quarter_turns % 4
  const swap_axes = turn === 1 || turn === 3
  const x = turn === 0 ? pad.x : turn === 1 ? -pad.y : turn === 2 ? -pad.x : pad.y
  const y = turn === 0 ? pad.y : turn === 1 ? pad.x : turn === 2 ? -pad.y : -pad.x
  return {
    pin: pad.pin === null ? null : normalizePin(pad.pin),
    kind: pad.kind,
    x,
    y,
    width: swap_axes ? pad.height : pad.width,
    height: swap_axes ? pad.width : pad.height,
    ...(pad.hole_width === undefined
      ? {}
      : { hole_width: swap_axes ? (pad.hole_height ?? pad.hole_width) : pad.hole_width }),
    ...(pad.hole_height === undefined
      ? {}
      : { hole_height: swap_axes ? (pad.hole_width ?? pad.hole_height) : pad.hole_height }),
  }
}

function normalizedGeometry(evidence: ComponentEvidence, quarter_turns: number): string {
  const rotated = evidence.footprint.pads.map((pad) => rotatePad(pad, quarter_turns))
  const left = Math.min(...rotated.map((pad) => pad.x - pad.width / 2))
  const right = Math.max(...rotated.map((pad) => pad.x + pad.width / 2))
  const bottom = Math.min(...rotated.map((pad) => pad.y - pad.height / 2))
  const top = Math.max(...rotated.map((pad) => pad.y + pad.height / 2))
  const center_x = (left + right) / 2
  const center_y = (bottom + top) / 2
  return JSON.stringify(
    rotated
      .map((pad) => ({
        pin: pad.pin,
        kind: pad.kind,
        x: quantize(pad.x - center_x),
        y: quantize(pad.y - center_y),
        width: quantize(pad.width),
        height: quantize(pad.height),
        ...(pad.hole_width === undefined ? {} : { hole_width: quantize(pad.hole_width) }),
        ...(pad.hole_height === undefined ? {} : { hole_height: quantize(pad.hole_height) }),
      }))
      .sort((left_pad, right_pad) => JSON.stringify(left_pad).localeCompare(JSON.stringify(right_pad))),
  )
}

/**
 * Stable physical identity that ignores page rotation and drawing origin.
 * Pin names and semantic roles are deliberately excluded: they describe the
 * component, not its copper land pattern, and can differ between two drawings
 * of the same package. Pad numbers remain part of normalizedGeometry, so a
 * genuinely different pad-to-pin mapping is not collapsed.
 */
export function physicalFootprintSignature(evidence: ComponentEvidence): string {
  return [0, 1, 2, 3].map((quarter_turns) => normalizedGeometry(evidence, quarter_turns)).sort()[0]!
}

function assertCopperLandPatternSources(evidence: ComponentEvidence, label: string): void {
  const footprint_sources = [
    ...evidence.footprint.drawing_orientation.sources,
    ...evidence.footprint.pads.flatMap((pad) => pad.sources),
  ]
  const stencil_source = footprint_sources.find((source) =>
    `${source.figure ?? ""} ${source.note ?? ""}`.toLowerCase().includes("stencil"),
  )
  if (stencil_source) {
    throw new Error(`${label} cites a stencil aperture drawing; footprints require PCB copper land patterns`)
  }
}

function defaultLabel(evidence: ComponentEvidence): string {
  const package_identity = evidence.package.code?.value ?? evidence.package.name.value
  return `${package_identity} · ${evidence.package.pin_count.value} pins`
}

function evidenceAliases(id: string, evidence: ComponentEvidence): string[] {
  return [id, evidence.package.name.value, ...(evidence.package.code ? [evidence.package.code.value] : [])]
}

function evidenceOrderingCodes(evidence: ComponentEvidence): string[] {
  return evidence.ordering_code ? [evidence.ordering_code.value] : []
}

interface ParsedCatalogEntry {
  footprint_id: string
  label: string
  aliases: string[]
  ordering_codes: string[]
  component_evidence: ComponentEvidence
  physical_signature: string
}

function parseEntry(value: unknown, index: number): ParsedCatalogEntry {
  const label = `component footprint catalog footprints[${index}]`
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  assertOnlyKeys(value, ["footprint_id", "label", "aliases", "ordering_codes", "component_evidence"], label)
  const footprint_id = requiredFootprintId(value.footprint_id, `${label}.footprint_id`)
  const component_evidence = parseComponentEvidence(value.component_evidence)
  assertCopperLandPatternSources(component_evidence, label)
  return {
    footprint_id,
    label:
      value.label === undefined
        ? defaultLabel(component_evidence)
        : requiredText(value.label, `${label}.label`),
    aliases: [
      ...new Set([
        ...evidenceAliases(footprint_id, component_evidence),
        ...(value.aliases === undefined ? [] : parseTextArray(value.aliases, `${label}.aliases`)),
      ]),
    ].sort((left, right) => left.localeCompare(right)),
    ordering_codes: [
      ...new Set([
        ...evidenceOrderingCodes(component_evidence),
        ...(value.ordering_codes === undefined
          ? []
          : parseTextArray(value.ordering_codes, `${label}.ordering_codes`)),
      ]),
    ].sort((left, right) => left.localeCompare(right)),
    component_evidence,
    physical_signature: physicalFootprintSignature(component_evidence),
  }
}

/**
 * Parses and canonicalizes the extractor catalog. Multiple orderables, package
 * aliases, and drawing representations of one physical copper pattern collapse
 * into one variant.
 */
export function parseComponentFootprintCatalog(value: unknown): ComponentFootprintCatalog {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("component-footprint-catalog.json must be a version-1 artifact")
  }
  assertOnlyKeys(value, ["version", "default_footprint_id", "footprints"], "component footprint catalog")
  const default_footprint_id = requiredFootprintId(
    value.default_footprint_id,
    "component footprint catalog default_footprint_id",
  )
  if (
    !Array.isArray(value.footprints) ||
    value.footprints.length === 0 ||
    value.footprints.length > MAX_FOOTPRINT_VARIANTS
  ) {
    throw new Error(`component footprint catalog must contain 1-${MAX_FOOTPRINT_VARIANTS} entries`)
  }
  const parsed = value.footprints.map(parseEntry)
  const ids = parsed.map((entry) => entry.footprint_id)
  if (new Set(ids).size !== ids.length) throw new Error("component footprint catalog repeats footprint_id")
  if (!ids.includes(default_footprint_id)) {
    throw new Error("component footprint catalog default_footprint_id does not identify an entry")
  }
  const expected_part = normalizedIdentity(
    parsed.find((entry) => entry.footprint_id === default_footprint_id)!.component_evidence.part_number.value,
  )
  for (const entry of parsed) {
    if (normalizedIdentity(entry.component_evidence.part_number.value) !== expected_part) {
      throw new Error("component footprint catalog entries must describe the same base component")
    }
  }

  const groups: ParsedCatalogEntry[][] = []
  for (const entry of parsed) {
    const group = groups.find((candidate) => candidate[0]?.physical_signature === entry.physical_signature)
    if (group) group.push(entry)
    else groups.push([entry])
  }

  let canonical_default_id = default_footprint_id
  const footprints = groups.map((group): ComponentFootprintVariant => {
    const preferred =
      group.find((entry) => entry.footprint_id === default_footprint_id) ??
      [...group].sort((left, right) => left.footprint_id.localeCompare(right.footprint_id))[0]!
    if (group.some((entry) => entry.footprint_id === default_footprint_id)) {
      canonical_default_id = preferred.footprint_id
    }
    return {
      footprint_id: preferred.footprint_id,
      label: preferred.label,
      aliases: [...new Set(group.flatMap((entry) => entry.aliases))].sort((left, right) =>
        left.localeCompare(right),
      ),
      ordering_codes: [...new Set(group.flatMap((entry) => entry.ordering_codes))].sort((left, right) =>
        left.localeCompare(right),
      ),
      component_evidence: preferred.component_evidence,
    }
  })
  footprints.sort((left, right) => {
    if (left.footprint_id === canonical_default_id) return -1
    if (right.footprint_id === canonical_default_id) return 1
    return left.label.localeCompare(right.label) || left.footprint_id.localeCompare(right.footprint_id)
  })
  return { version: 1, default_footprint_id: canonical_default_id, footprints }
}

export function createSingleFootprintCatalog(input: {
  footprint_id?: string
  component_evidence: ComponentEvidence
}): ComponentFootprintCatalog {
  const footprint_id = input.footprint_id ?? "default"
  return parseComponentFootprintCatalog({
    version: 1,
    default_footprint_id: footprint_id,
    footprints: [{ footprint_id, component_evidence: input.component_evidence }],
  })
}

export function getDefaultFootprint(catalog: ComponentFootprintCatalog): ComponentFootprintVariant {
  const variant = catalog.footprints.find(
    (candidate) => candidate.footprint_id === catalog.default_footprint_id,
  )
  if (!variant) throw new Error("component footprint catalog has no default footprint")
  return variant
}
