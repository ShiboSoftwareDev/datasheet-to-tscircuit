import type { ProcessRunner } from "../../infrastructure/process"
import type {
  MeasurementCandidate,
  OcrBoundingBox,
  ReferenceDivisionScaleSource,
  TesseractWord,
} from "./types"

export function parseTesseractTsv(
  tsv: string,
  offset: { left: number; top: number } = { left: 0, top: 0 },
): TesseractWord[] {
  return tsv
    .split(/\r?\n/)
    .slice(1)
    .flatMap((row) => {
      const fields = row.split("\t")
      if (fields.length < 12 || fields[0] !== "5") return []
      const confidence = Number(fields[10])
      const text = fields.slice(11).join("\t").trim()
      const numbers = fields.slice(1, 10).map(Number)
      if (!text || !Number.isFinite(confidence) || numbers.some((value) => !Number.isFinite(value))) {
        return []
      }
      return [
        {
          block: numbers[1]!,
          paragraph: numbers[2]!,
          line: numbers[3]!,
          word: numbers[4]!,
          confidence,
          text,
          bbox: {
            left: numbers[5]! + offset.left,
            top: numbers[6]! + offset.top,
            width: numbers[7]!,
            height: numbers[8]!,
          },
        },
      ]
    })
}

function parseDivisionScale(
  raw_text: string,
): Pick<ReferenceDivisionScaleSource, "normalized_unit" | "value_per_division_si"> | undefined {
  const normalized = raw_text
    .normalize("NFKC")
    .replace(/[−–—]/g, "-")
    .replace(/¥/g, "v")
    .replace(/\s+/g, "")
    .replace(/division/i, "div")
    // Scope UI anti-aliasing occasionally makes the V glyph OCR as both "v"
    // and "¥" (for example "mV¥/div"). Both glyphs describe one unit.
    .replace(/v{2,}/gi, "v")
    // Another common anti-aliased V artifact is "m\V/div".
    .replace(/\\(?=v)/gi, "")
    // The slash in a compact scope label is sometimes rasterized as a narrow
    // `i` or `l` (for example `2 Vidiv`). This sequence is not a valid unit in
    // its own right, so it is safe to normalize only between V/S and `div`.
    .replace(/(?<=[sv])[il](?=div$)/i, "/")
    // On compact oscilloscope panels, Tesseract commonly reads the micro glyph
    // in "us/div" as a lowercase y. Y is not a valid SI prefix, so this
    // normalization is unambiguous when it occurs immediately before s/div.
    .replace(/y(?=s\/?div$)/i, "u")
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(p|n|u|µ|μ|m)?(s|v)\/?div$/i.exec(normalized)
  if (!match) return undefined
  const numeric = Number(match[1])
  if (!(numeric > 0)) return undefined
  const prefix = match[2]?.toLowerCase()
  const multiplier =
    prefix === "p"
      ? 1e-12
      : prefix === "n"
        ? 1e-9
        : prefix === "u" || prefix === "µ" || prefix === "μ"
          ? 1e-6
          : prefix === "m"
            ? 1e-3
            : 1
  return {
    normalized_unit: match[3]!.toLowerCase() === "s" ? "s" : "V",
    value_per_division_si: numeric * multiplier,
  }
}

export function joinedBoundingBox(words: readonly TesseractWord[]): OcrBoundingBox {
  const left = Math.min(...words.map(({ bbox }) => bbox.left))
  const top = Math.min(...words.map(({ bbox }) => bbox.top))
  const right = Math.max(...words.map(({ bbox }) => bbox.left + bbox.width))
  const bottom = Math.max(...words.map(({ bbox }) => bbox.top + bbox.height))
  return { left, top, width: right - left, height: bottom - top }
}

export function divisionScaleCandidates(words: readonly TesseractWord[]): ReferenceDivisionScaleSource[] {
  const lines = new Map<string, TesseractWord[]>()
  for (const word of words) {
    const key = `${word.block}:${word.paragraph}:${word.line}`
    const line = lines.get(key) ?? []
    line.push(word)
    lines.set(key, line)
  }
  const candidates: ReferenceDivisionScaleSource[] = []
  for (const line of lines.values()) {
    line.sort((left, right) => left.word - right.word)
    for (let start = 0; start < line.length; start += 1) {
      for (let count = 1; count <= 3 && start + count <= line.length; count += 1) {
        const window = line.slice(start, start + count)
        const raw_text = window.map(({ text }) => text).join(" ")
        const parsed = parseDivisionScale(raw_text)
        if (!parsed) continue
        candidates.push({
          raw_text,
          ...parsed,
          confidence: Math.min(...window.map(({ confidence }) => confidence)),
          ocr_bbox_px: joinedBoundingBox(window),
        })
      }
    }
  }
  return candidates
}

function parseMeasurement(raw_text: string): Pick<MeasurementCandidate, "unit" | "value_si"> | undefined {
  const normalized = raw_text
    .normalize("NFKC")
    .replace(/[−–—]/g, "-")
    // Colored scope-control text is rasterized differently across Poppler and
    // Tesseract versions. In particular, Docker's OCR commonly reads a
    // saturated V glyph as the visually similar yen sign.
    .replace(/¥/g, "v")
    .replace(/\s+/g, "")
    // Focused scope OCR often retains a border or trigger glyph immediately
    // beside an otherwise exact control value, for example "__(200ns".
    .replace(/^[_(\[{|]+/, "")
    .replace(/[),;:_\]}|]+$/, "")
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(p|n|u|µ|μ|m)?(s|v)$/i.exec(normalized)
  if (!match) return undefined
  const numeric = Number(match[1])
  if (!Number.isFinite(numeric)) return undefined
  const prefix = match[2]?.toLowerCase()
  const multiplier =
    prefix === "p"
      ? 1e-12
      : prefix === "n"
        ? 1e-9
        : prefix === "u" || prefix === "µ" || prefix === "μ"
          ? 1e-6
          : prefix === "m"
            ? 1e-3
            : 1
  return {
    unit: match[3]!.toLowerCase() === "s" ? "s" : "V",
    value_si: numeric * multiplier,
  }
}

/**
 * Modern oscilloscopes commonly print compact control values (`200ns`,
 * `2.00 V`) instead of spelling out `/div`. Only values in the focused bottom
 * control strip are eligible for this normalization. The top-most time value
 * is the horizontal timebase; voltage values to its left are channel scales,
 * while measurements to its right belong to acquisition/readout controls.
 */
export function scopeControlDivisionScaleCandidates(input: {
  horizontal_words: readonly TesseractWord[]
  channel_words: readonly TesseractWord[]
}): ReferenceDivisionScaleSource[] {
  const horizontal_measurements = measurementCandidates(input.horizontal_words)
  const channel_measurements = measurementCandidates(input.channel_words)
  const time_candidates = [...horizontal_measurements, ...channel_measurements]
    .filter(({ unit, value_si, confidence }) => unit === "s" && value_si > 0 && confidence >= 15)
    .sort(
      (left, right) =>
        left.bbox.top - right.bbox.top ||
        left.bbox.left - right.bbox.left ||
        right.confidence - left.confidence,
    )
  const timebase = time_candidates[0]
  if (!timebase) return []
  const asDivisionScale = (
    measurement: MeasurementCandidate,
    algorithm:
      | "scope_horizontal_control_implies_per_division_v1"
      | "scope_channel_control_implies_per_division_v1",
  ): ReferenceDivisionScaleSource => ({
    raw_text: measurement.raw_text,
    normalized_unit: measurement.unit,
    value_per_division_si: measurement.value_si,
    confidence: measurement.confidence,
    ocr_bbox_px: measurement.bbox,
    normalization: {
      algorithm,
      corroborating_raw_text: measurement.raw_text,
      multiplier: 1,
    },
  })
  const voltage_scales = channel_measurements.filter(
    ({ unit, value_si, confidence, bbox }) =>
      unit === "V" && value_si > 0 && confidence >= 15 && bbox.left + bbox.width < timebase.bbox.left,
  )
  return [
    asDivisionScale(timebase, "scope_horizontal_control_implies_per_division_v1"),
    ...voltage_scales.map((measurement) =>
      asDivisionScale(measurement, "scope_channel_control_implies_per_division_v1"),
    ),
  ]
}

export function measurementCandidates(words: readonly TesseractWord[]): MeasurementCandidate[] {
  const lines = new Map<string, TesseractWord[]>()
  for (const word of words) {
    const key = `${word.block}:${word.paragraph}:${word.line}`
    const line = lines.get(key) ?? []
    line.push(word)
    lines.set(key, line)
  }
  const candidates: MeasurementCandidate[] = []
  for (const line of lines.values()) {
    line.sort((left, right) => left.word - right.word)
    for (let start = 0; start < line.length; start += 1) {
      for (let count = 1; count <= 3 && start + count <= line.length; count += 1) {
        const window = line.slice(start, start + count)
        const raw_text = window.map(({ text }) => text).join(" ")
        const parsed = parseMeasurement(raw_text)
        if (!parsed) continue
        candidates.push({
          raw_text,
          ...parsed,
          confidence: Math.min(...window.map(({ confidence }) => confidence)),
          bbox: joinedBoundingBox(window),
        })
      }
    }
  }
  return candidates
}

export async function tesseractVersion(input: {
  process_runner: ProcessRunner
  cwd: string
  signal: AbortSignal
}): Promise<string> {
  const result = await input.process_runner.run({
    command: ["tesseract", "--version"],
    command_label: "Read reference-axis OCR engine version",
    cwd: input.cwd,
    signal: input.signal,
    wall_timeout_ms: 30_000,
    max_output_chars: 20_000,
  })
  const version = result.output_tail.trim().split(/\r?\n/)[0]?.trim()
  if (!version?.toLowerCase().startsWith("tesseract ")) {
    throw new Error("Reference-axis OCR engine did not report a recognizable version")
  }
  return version
}
