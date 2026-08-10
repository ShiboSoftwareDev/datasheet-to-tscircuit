import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ProcessRunner } from "../../infrastructure/process"
import { decodeModelEvidencePng } from "../model-evidence-pages"
import type { EligibleObservedReferenceChannel, ObservedReferenceGraph } from "../reference-graph-observation"
import { divisionScaleCandidates, measurementCandidates, parseTesseractTsv } from "./ocr-extraction"
import { ANCHOR_PIXEL_TOLERANCE, MAX_TSV_BYTES, OCR_DPI, OCR_SCALE, sha256 } from "./shared"
import type { ReferenceDivisionScaleSource, ReferenceGridCalibrationSource, TesseractWord } from "./types"

const MAX_RIGHT_EDGE_PANEL_FALLBACK_WIDTH = 1_024 * OCR_SCALE

export async function ocrScopePanels(input: {
  graph: Pick<ObservedReferenceGraph, "graph_id" | "page" | "crop"> &
    Partial<Pick<EligibleObservedReferenceChannel, "digitized_curve">>
  full_words: readonly TesseractWord[]
  render_width: number
  render_height: number
  plot_right_px?: number
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
  // Some scope screenshots render the gray "Horizontal" heading too faintly for
  // the full-crop PSM 11 pass, even though the scale values remain legible in a
  // focused PSM 6 pass. A single heading is the strongest locator. If it is
  // absent, use the right edge of a single-plot crop, where scope control panels
  // are conventionally placed. More than one heading is ambiguous (usually an
  // oversized crop containing neighboring plots), so never guess in that case.
  if (
    horizontal_words.length > 1 ||
    (horizontal_words.length === 0 && input.render_width > MAX_RIGHT_EDGE_PANEL_FALLBACK_WIDTH)
  ) {
    return undefined
  }
  const horizontal = horizontal_words[0]
  const traced_plot_right = input.graph.digitized_curve
    ? Math.max(
        input.graph.digitized_curve.x_axis.first.pixel,
        input.graph.digitized_curve.x_axis.second.pixel,
        ...input.graph.digitized_curve.points.map(({ pixel_x }) => pixel_x),
      ) * OCR_SCALE
    : input.plot_right_px === undefined
      ? input.render_width - 360
      : input.plot_right_px * OCR_SCALE
  const panel_left = horizontal
    ? Math.max(0, Math.floor(horizontal.bbox.left - 24))
    : Math.max(0, Math.min(input.render_width - 384, Math.floor(traced_plot_right - 24)))
  const panel_top = horizontal ? Math.max(0, Math.floor(horizontal.bbox.top - 24)) : 0
  const regions = [
    {
      name: "horizontal-panel",
      left: panel_left,
      top: panel_top,
      width: 384,
      height: 450,
    },
    {
      name: "channel-panel",
      left: panel_left,
      top: panel_top + 180,
      width: 384,
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
    const region_words = parseTesseractTsv(tsv, {
      left: region.left,
      top: region.top,
    }).map((word) => ({
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
  graph: EligibleObservedReferenceChannel
}): number[] {
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
  const cross_values = input.axis === "x" ? [...point_y, ...anchor_y] : [...point_x, ...anchor_x]
  const cross_limit = input.axis === "x" ? input.decoded.height : input.decoded.width
  // Sweep the complete source crop along the axis being proved. Restricting
  // this dimension to the observer's claimed anchors/range creates a circular
  // proof: a correction that narrows to two adjacent grid lines hides the
  // third line dominantGrid needs to establish the spacing. The perpendicular
  // sampling band remains tied to the traced plot, so unrelated crop content
  // cannot supply a grid merely by being elsewhere in the image.
  const cross_min = Math.max(0, Math.floor(Math.min(...cross_values) - 36))
  const cross_max = Math.min(cross_limit - 1, Math.ceil(Math.max(...cross_values) + 36))
  return neutralGridProfileInBand({ ...input, cross_min, cross_max })
}

/** Candidate-independent grid scan used only for attempt-one guidance. */
export function neutralGridProfileForCrop(input: {
  decoded: Awaited<ReturnType<typeof decodeModelEvidencePng>>
  axis: "x" | "y"
}): number[] {
  const cross_limit = input.axis === "x" ? input.decoded.height : input.decoded.width
  return neutralGridProfileInBand({
    ...input,
    cross_min: 0,
    cross_max: cross_limit - 1,
  })
}

function neutralGridProfileInBand(input: {
  decoded: Awaited<ReturnType<typeof decodeModelEvidencePng>>
  axis: "x" | "y"
  cross_min: number
  cross_max: number
}): number[] {
  const axis_limit = input.axis === "x" ? input.decoded.width : input.decoded.height
  const axis_min = 0
  const axis_max = axis_limit - 1
  const scored: Array<{ pixel: number; score: number }> = []
  for (let pixel = axis_min; pixel <= axis_max; pixel += 1) {
    let neutral = 0
    let sampled = 0
    for (let cross = input.cross_min; cross <= input.cross_max; cross += 1) {
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

export function dominantGridSpacing(lines: readonly number[]): number | undefined {
  if (lines.length < 3) return undefined
  const spacings = lines
    .slice(1)
    .map((line, index) => line - lines[index]!)
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
  return supported.sort((left, right) => left - right)[Math.floor(supported.length / 2)]!
}

export function dominantGrid(input: {
  lines: readonly number[]
  first_anchor: number
  second_anchor: number
}): ReferenceGridCalibrationSource | undefined {
  const median_spacing_px = dominantGridSpacing(input.lines)
  if (median_spacing_px === undefined) return undefined
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
  // Tesseract's confidence is per token. Small anti-aliased scope unit labels
  // can be correctly recognized just below 25 even when the adjacent numeric
  // token is high confidence. Uniqueness plus the independent grid, caption,
  // nominal-voltage, and trace proofs provide the surrounding corroboration.
  const minimum_token_confidence = 15
  const relevant = candidates.filter(
    ({ normalized_unit, confidence }) => normalized_unit === unit && confidence >= minimum_token_confidence,
  )
  const values = [...new Set(relevant.map(({ value_per_division_si }) => value_per_division_si))]
  if (values.length !== 1) return undefined
  return relevant
    .filter(({ value_per_division_si }) => value_per_division_si === values[0])
    .sort((left, right) => right.confidence - left.confidence)[0]
}

/** Selects the printed channel scale aligned with the trace being proved. */
export function divisionScaleNearestTrace(input: {
  candidates: readonly ReferenceDivisionScaleSource[]
  unit: "s" | "V"
  graph: EligibleObservedReferenceChannel
}): ReferenceDivisionScaleSource | undefined {
  const relevant = input.candidates.filter(
    ({ normalized_unit, confidence }) => normalized_unit === input.unit && confidence >= 15,
  )
  if (relevant.length === 0) return undefined
  // Axis anchors commonly span the entire scope plot and therefore overlap
  // every stacked channel control. The rendered trace itself owns the local
  // vertical band used to associate its printed V/div setting.
  const curve_pixels = input.graph.digitized_curve.points.map(({ pixel_y }) => pixel_y)
  const curve_min = Math.min(...curve_pixels)
  const curve_max = Math.max(...curve_pixels)
  const distanceToCurve = (candidate: ReferenceDivisionScaleSource) => {
    const center = (candidate.ocr_bbox_px.top + candidate.ocr_bbox_px.height / 2) / OCR_SCALE
    return center < curve_min ? curve_min - center : center > curve_max ? center - curve_max : 0
  }
  const ranked = relevant
    .map((candidate) => ({ candidate, distance: distanceToCurve(candidate) }))
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        right.candidate.confidence - left.candidate.confidence ||
        left.candidate.ocr_bbox_px.top - right.candidate.ocr_bbox_px.top,
    )
  const nearest = ranked[0]
  if (!nearest || nearest.distance > 48) return undefined
  const equally_local = ranked.filter(({ distance }) => distance <= nearest.distance + 8)
  if (new Set(equally_local.map(({ candidate }) => candidate.value_per_division_si)).size !== 1) {
    return undefined
  }
  return equally_local[0]!.candidate
}

/**
 * Recovers a dropped SI prefix, or a low-confidence `p` reading of a printed
 * micro glyph, only when the same focused Horizontal panel has an immediately
 * adjacent time measurement that supplies the micro prefix. This is
 * source-owned OCR normalization: both the imperfect division token and the
 * corroborating token are retained in the receipt.
 */
export function recoverMissingTimeDivisionPrefix(
  scale: ReferenceDivisionScaleSource | undefined,
  horizontal_words: readonly TesseractWord[],
): ReferenceDivisionScaleSource | undefined {
  const focused_scale = (() => {
    const time_candidates = divisionScaleCandidates(horizontal_words).filter(
      ({ normalized_unit }) => normalized_unit === "s",
    )
    const values = [...new Set(time_candidates.map(({ value_per_division_si }) => value_per_division_si))]
    if (values.length !== 1) return undefined
    return time_candidates.sort((left, right) => right.confidence - left.confidence)[0]
  })()
  const contextual_scale = focused_scale ?? scale
  if (!contextual_scale || contextual_scale.normalized_unit !== "s") return scale
  const scale_numeric = Number(
    contextual_scale.raw_text
      .normalize("NFKC")
      .replace(/[−–—]/g, "-")
      .match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)/)?.[0],
  )
  if (!(scale_numeric > 0)) return scale
  const scale_multiplier = contextual_scale.value_per_division_si / scale_numeric
  const missing_prefix = scale_multiplier === 1
  const low_confidence_micro_as_p = contextual_scale.confidence < 15 && scale_multiplier === 1e-12
  if (!missing_prefix && !low_confidence_micro_as_p) return scale
  const scale_bottom = contextual_scale.ocr_bbox_px.top + contextual_scale.ocr_bbox_px.height
  const scale_right = contextual_scale.ocr_bbox_px.left + contextual_scale.ocr_bbox_px.width
  const candidates = measurementCandidates(horizontal_words).flatMap((measurement) => {
    if (measurement.unit !== "s" || !(measurement.value_si > 0)) return []
    const numeric = Number(
      measurement.raw_text
        .normalize("NFKC")
        .replace(/[−–—]/g, "-")
        .match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)/)?.[0],
    )
    if (!(numeric > 0)) return []
    const multiplier = measurement.value_si / numeric
    if (!(multiplier > 0 && multiplier < 1)) return []
    const vertical_gap = measurement.bbox.top - scale_bottom
    const measurement_right = measurement.bbox.left + measurement.bbox.width
    const horizontal_overlap = Math.max(
      0,
      Math.min(scale_right, measurement_right) -
        Math.max(contextual_scale.ocr_bbox_px.left, measurement.bbox.left),
    )
    if (vertical_gap < 0 || vertical_gap > 60 || horizontal_overlap < 12) return []
    return [{ measurement, multiplier, vertical_gap }]
  })
  candidates.sort((left, right) => left.vertical_gap - right.vertical_gap)
  const nearest = candidates[0]
  if (!nearest || nearest.multiplier !== 1e-6) return scale
  const equally_near = candidates.filter(
    (candidate) => Math.abs(candidate.vertical_gap - nearest.vertical_gap) <= 2,
  )
  if (new Set(equally_near.map(({ multiplier }) => multiplier)).size !== 1) return scale
  return {
    ...contextual_scale,
    value_per_division_si: scale_numeric * nearest.multiplier,
    normalization: {
      algorithm: missing_prefix
        ? "missing_time_prefix_from_adjacent_measurement_v1"
        : "low_confidence_micro_prefix_from_adjacent_measurement_v1",
      corroborating_raw_text: nearest.measurement.raw_text,
      multiplier: nearest.multiplier,
    },
  }
}

export function relativeScaleAgreement(declared: number, source: number): boolean {
  return Math.abs(declared - source) <= Math.max(1e-12, Math.abs(source) * 0.04)
}
