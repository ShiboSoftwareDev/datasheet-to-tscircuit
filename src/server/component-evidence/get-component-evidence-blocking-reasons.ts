import { ComponentEvidence, EvidenceSource } from "./types"
import { normalizePin } from "./get-pad-agreement-errors"

function hasReliableSource(sources: EvidenceSource[]): boolean {
  return sources.some((source) => source.confidence === "high" || source.confidence === "medium")
}

function hasReliableDirectSource(sources: EvidenceSource[]): boolean {
  return sources.some(
    (source) =>
      (source.method === "pdf_text" || source.method === "pdf_visual") &&
      (source.confidence === "high" || source.confidence === "medium"),
  )
}

export function getComponentEvidenceBlockingReasons(evidence: ComponentEvidence): string[] {
  const errors: string[] = []
  if (evidence.status !== "resolved") {
    errors.push("evidence extraction is unresolved")
    for (const ambiguity of evidence.unresolved_ambiguities) {
      errors.push(`unresolved ambiguity: ${ambiguity}`)
    }
  }
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
  const reliable_footprint_visual_pages = new Set(
    [
      ...evidence.footprint.drawing_orientation.sources.filter(
        (source) => source.image === "visual-reference/land-pattern.png",
      ),
      ...evidence.footprint.pads.flatMap((pad) => pad.sources),
    ].flatMap((source) =>
      source.method === "pdf_visual" && (source.confidence === "high" || source.confidence === "medium")
        ? [source.page]
        : [],
    ),
  )
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
    for (const source of pad.sources) {
      if (
        (source.method === "calculated" || source.method === "package_standard") &&
        !reliable_footprint_visual_pages.has(source.page)
      ) {
        errors.push(
          `pad ${index + 1} (${pad.pin ?? "mechanical"}) ${source.method} geometry on page ${source.page} has no medium/high-confidence pdf_visual footprint anchor on that page`,
        )
      }
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
  const direct_fact_sources = [
    ["part number", evidence.part_number.sources],
    ...(evidence.ordering_code ? ([["ordering code", evidence.ordering_code.sources]] as const) : []),
    ["package name", evidence.package.name.sources],
    ...(evidence.package.code ? ([["package code", evidence.package.code.sources]] as const) : []),
    ["package pin count", evidence.package.pin_count.sources],
    ...evidence.pinout.pins.map((pin) => [`pin ${pin.number}`, pin.sources] as const),
  ] as const
  for (const [label, sources] of direct_fact_sources) {
    if (!hasReliableDirectSource(sources)) {
      errors.push(`${label} must cite medium/high-confidence pdf_text or pdf_visual evidence`)
    }
  }
  const geometry_sources = [
    ["drawing orientation", evidence.footprint.drawing_orientation.sources],
    ...evidence.footprint.pads.map(
      (pad, index) => [`pad ${index + 1} (${pad.pin ?? "mechanical"})`, pad.sources] as const,
    ),
  ] as const
  for (const [label, sources] of geometry_sources) {
    if (!hasReliableSource(sources)) errors.push(`${label} has only low-confidence evidence`)
  }
  return errors
}
