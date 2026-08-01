import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ProcessRunner } from "../../infrastructure/process"
import { decodeModelEvidencePng } from "../model-evidence-pages"
import { eligibleObservedGraphs, type ReferenceGraphAxisAnchor } from "../reference-graph-observation"
import { divisionScaleCandidates, parseTesseractTsv } from "./ocr-extraction"
import { ANCHOR_PIXEL_TOLERANCE, MAX_TSV_BYTES, OCR_DPI, OCR_SCALE, sha256 } from "./shared"
import type { ReferenceDivisionScaleSource, ReferenceGridCalibrationSource, TesseractWord } from "./types"

export async function ocrScopePanels(input: {
  graph: ReturnType<typeof eligibleObservedGraphs>[number]
  full_words: readonly TesseractWord[]
  render_width: number
  render_height: number
  workspace: string
  process_runner: ProcessRunner
  signal: AbortSignal
}): Promise<
  | {
      words: TesseractWord[]
      horizontal_words: TesseractWord[]
      channel_words: TesseractWord[]
      combined_tsv_sha256: string
    }
  | undefined
> {
  const horizontal_words = input.full_words.filter(
    ({ text, confidence }) => /^horizontal$/i.test(text) && confidence >= 35,
  )
  if (horizontal_words.length !== 1) return undefined
  const horizontal = horizontal_words[0]!
  const regions = [
    {
      name: "horizontal-panel",
      left: Math.max(0, Math.floor(horizontal.bbox.left - 24)),
      top: Math.max(0, Math.floor(horizontal.bbox.top - 24)),
      width: 360,
      height: 450,
    },
    {
      name: "channel-panel",
      left: Math.max(0, Math.floor(horizontal.bbox.left - 24)),
      top: Math.max(0, Math.floor(horizontal.bbox.top + 180)),
      width: 360,
      height: 760,
    },
  ].map((region) => ({
    ...region,
    width: Math.min(region.width, input.render_width - region.left),
    height: Math.min(region.height, input.render_height - region.top),
  }))
  if (regions.some(({ width, height }) => width < 80 || height < 80)) return undefined
  const words: TesseractWord[] = []
  const horizontal_panel_words: TesseractWord[] = []
  const channel_panel_words: TesseractWord[] = []
  const tsvs: string[] = []
  for (const [region_index, region] of regions.entries()) {
    input.signal.throwIfAborted()
    const render_prefix = join(input.workspace, `${input.graph.graph_id}-${region.name}`)
    await input.process_runner.run({
      command: [
        "pdftoppm",
        "-f",
        String(input.graph.page),
        "-l",
        String(input.graph.page),
        "-r",
        String(OCR_DPI),
        "-x",
        String(input.graph.crop.x_px * OCR_SCALE + region.left),
        "-y",
        String(input.graph.crop.y_px * OCR_SCALE + region.top),
        "-W",
        String(region.width),
        "-H",
        String(region.height),
        "-png",
        "-singlefile",
        join(input.workspace, "datasheet.pdf"),
        render_prefix,
      ],
      command_label: `Render ${region.name} ${input.graph.graph_id}`,
      cwd: input.workspace,
      signal: input.signal,
      wall_timeout_ms: 120_000,
      max_output_chars: 20_000,
    })
    const ocr_base = join(input.workspace, `${input.graph.graph_id}-${region.name}-ocr`)
    await input.process_runner.run({
      command: ["tesseract", `${render_prefix}.png`, ocr_base, "-l", "eng", "--psm", "6", "tsv"],
      command_label: `OCR ${region.name} ${input.graph.graph_id}`,
      cwd: input.workspace,
      signal: input.signal,
      wall_timeout_ms: 120_000,
      max_output_chars: 20_000,
    })
    const tsv = await readFile(`${ocr_base}.tsv`, "utf8")
    if (Buffer.byteLength(tsv) < 1 || Buffer.byteLength(tsv) > MAX_TSV_BYTES) {
      throw new Error(`Reference axis ${region.name} OCR output is not bounded`)
    }
    tsvs.push(tsv)
    const region_words = parseTesseractTsv(tsv, { left: region.left, top: region.top }).map((word) => ({
      ...word,
      block: word.block + (region_index + 1) * 10_000,
    }))
    words.push(...region_words)
    if (region.name === "horizontal-panel") horizontal_panel_words.push(...region_words)
    else channel_panel_words.push(...region_words)
  }
  return {
    words,
    horizontal_words: horizontal_panel_words,
    channel_words: channel_panel_words,
    combined_tsv_sha256: sha256(tsvs.join("\n---panel---\n")),
  }
}

export function neutralGridProfile(input: {
  decoded: Awaited<ReturnType<typeof decodeModelEvidencePng>>
  axis: "x" | "y"
  graph: ReturnType<typeof eligibleObservedGraphs>[number]
}): number[] {
  const pixelForValue = (
    axis: {
      first: ReferenceGraphAxisAnchor
      second: ReferenceGraphAxisAnchor
    },
    value: number,
  ) =>
    axis.first.pixel +
    ((value - axis.first.value) / (axis.second.value - axis.first.value)) *
      (axis.second.pixel - axis.first.pixel)
  const point_x = input.graph.digitized_curve.points.map(({ pixel_x }) => pixel_x * OCR_SCALE)
  const point_y = input.graph.digitized_curve.points.map(({ pixel_y }) => pixel_y * OCR_SCALE)
  const anchor_x = [
    input.graph.digitized_curve.x_axis.first.pixel * OCR_SCALE,
    input.graph.digitized_curve.x_axis.second.pixel * OCR_SCALE,
  ]
  const anchor_y = [
    input.graph.digitized_curve.y_axis.first.pixel * OCR_SCALE,
    input.graph.digitized_curve.y_axis.second.pixel * OCR_SCALE,
  ]
  const range_x = [
    pixelForValue(input.graph.digitized_curve.x_axis, input.graph.digitized_curve.x_range.min) * OCR_SCALE,
    pixelForValue(input.graph.digitized_curve.x_axis, input.graph.digitized_curve.x_range.max) * OCR_SCALE,
  ]
  const range_y = [
    pixelForValue(input.graph.digitized_curve.y_axis, input.graph.digitized_curve.y_range.min) * OCR_SCALE,
    pixelForValue(input.graph.digitized_curve.y_axis, input.graph.digitized_curve.y_range.max) * OCR_SCALE,
  ]
  const axis_values =
    input.axis === "x" ? [...point_x, ...anchor_x, ...range_x] : [...point_y, ...anchor_y, ...range_y]
  const cross_values = input.axis === "x" ? [...point_y, ...anchor_y] : [...point_x, ...anchor_x]
  const axis_limit = input.axis === "x" ? input.decoded.width : input.decoded.height
  const cross_limit = input.axis === "x" ? input.decoded.height : input.decoded.width
  const axis_min = Math.max(0, Math.floor(Math.min(...axis_values) - 12))
  const axis_max = Math.min(axis_limit - 1, Math.ceil(Math.max(...axis_values) + 12))
  const cross_min = Math.max(0, Math.floor(Math.min(...cross_values) - 36))
  const cross_max = Math.min(cross_limit - 1, Math.ceil(Math.max(...cross_values) + 36))
  const scored: Array<{ pixel: number; score: number }> = []
  for (let pixel = axis_min; pixel <= axis_max; pixel += 1) {
    let neutral = 0
    let sampled = 0
    for (let cross = cross_min; cross <= cross_max; cross += 1) {
      const [r, g, b] =
        input.axis === "x" ? input.decoded.rgbAt(pixel, cross) : input.decoded.rgbAt(cross, pixel)
      const maximum = Math.max(r, g, b)
      const minimum = Math.min(r, g, b)
      const average = (r + g + b) / 3
      if (maximum - minimum <= 18 && average >= 75 && average <= 245) neutral += 1
      sampled += 1
    }
    scored.push({ pixel, score: sampled === 0 ? 0 : neutral / sampled })
  }
  const max_score = Math.max(0, ...scored.map(({ score }) => score))
  const threshold = Math.max(0.08, max_score * 0.34)
  const clusters: Array<Array<{ pixel: number; score: number }>> = []
  for (const value of scored.filter(({ score }) => score >= threshold)) {
    const cluster = clusters.at(-1)
    if (!cluster || value.pixel > cluster.at(-1)!.pixel + 1) clusters.push([value])
    else cluster.push(value)
  }
  return clusters
    .map((cluster) => cluster.sort((left, right) => right.score - left.score)[0]!.pixel / OCR_SCALE)
    .sort((left, right) => left - right)
}

export function dominantGrid(input: {
  lines: readonly number[]
  first_anchor: number
  second_anchor: number
}): ReferenceGridCalibrationSource | undefined {
  if (input.lines.length < 3) return undefined
  const spacings = input.lines
    .slice(1)
    .map((line, index) => line - input.lines[index]!)
    .filter((spacing) => spacing >= 8)
  if (spacings.length < 2) return undefined
  const candidates = spacings.map((spacing) => ({
    spacing,
    support: spacings.filter((other) => Math.abs(other - spacing) <= Math.max(1.5, spacing * 0.04)).length,
  }))
  candidates.sort((left, right) => right.support - left.support || left.spacing - right.spacing)
  const best = candidates[0]
  if (!best || best.support < 2) return undefined
  const supported = spacings.filter(
    (spacing) => Math.abs(spacing - best.spacing) <= Math.max(1.5, best.spacing * 0.04),
  )
  const median_spacing_px = supported.sort((left, right) => left - right)[Math.floor(supported.length / 2)]!
  const nearest = (anchor: number) =>
    input.lines
      .map((line) => ({ line, error: Math.abs(line - anchor) }))
      .sort((left, right) => left.error - right.error)[0]!
  const first = nearest(input.first_anchor)
  const second = nearest(input.second_anchor)
  if (first.error > ANCHOR_PIXEL_TOLERANCE || second.error > ANCHOR_PIXEL_TOLERANCE) return undefined
  return {
    line_pixels: [...input.lines],
    median_spacing_px,
    first_anchor_line_pixel: first.line,
    second_anchor_line_pixel: second.line,
    first_anchor_error_px: first.error,
    second_anchor_error_px: second.error,
  }
}

export function uniqueDivisionScale(
  candidates: readonly ReferenceDivisionScaleSource[],
  unit: "s" | "V",
): ReferenceDivisionScaleSource | undefined {
  const relevant = candidates.filter(
    ({ normalized_unit, confidence }) => normalized_unit === unit && confidence >= 25,
  )
  const values = [...new Set(relevant.map(({ value_per_division_si }) => value_per_division_si))]
  if (values.length !== 1) return undefined
  return relevant
    .filter(({ value_per_division_si }) => value_per_division_si === values[0])
    .sort((left, right) => right.confidence - left.confidence)[0]
}

export function relativeScaleAgreement(declared: number, source: number): boolean {
  return Math.abs(declared - source) <= Math.max(1e-12, Math.abs(source) * 0.04)
}
