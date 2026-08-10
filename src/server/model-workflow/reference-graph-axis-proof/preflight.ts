import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createStageWorkspace } from "../../infrastructure/artifacts"
import type { ProcessRunner } from "../../infrastructure/process"
import { decodeModelEvidencePng } from "../model-evidence-pages"
import { canonicalReferenceCropProof } from "../reference-graph-crop-proof"
import type { FoundObservedReferenceGraph } from "../reference-graph-observation/eligibility"
import { alignedExplicitAxisCalibration } from "./explicit-ticks"
import {
  divisionScaleCandidates,
  measurementCandidates,
  parseTesseractTsv,
  tesseractVersion,
} from "./ocr-extraction"
import { extractPdfTextBBox, figureIdentityFromPdfText } from "./pdf-extraction"
import {
  dominantGridSpacing,
  neutralGridProfileForCrop,
  ocrScopePanels,
  recoverMissingTimeDivisionPrefix,
  uniqueDivisionScale,
} from "./scope-divisions"
import { MAX_TSV_BYTES, OCR_DPI, OCR_SCALE, sha256 } from "./shared"
import type {
  MeasurementCandidate,
  ReferenceDivisionScaleSource,
  ReferenceGraphPreflight,
  ReferenceGraphPreflightDivisionScale,
  TesseractWord,
} from "./types"

export interface ReferenceGraphImmutableSourceAnalysis {
  graph_id: string
  source_pdf_sha256: string
  page: number
  canonical_crop_sha256: string
  engine_version: string
  png: Buffer
  decoded: Awaited<ReturnType<typeof decodeModelEvidencePng>>
  tsv: string
  bbox_html: string
  full_words: TesseractWord[]
}

function uniqueSortedNumbers(numbers: readonly number[]): number[] {
  return [...new Set(numbers.filter(Number.isFinite))].sort((left, right) => left - right)
}

function recommendedGridAnchorPixels({
  lines,
  spacing,
  axis,
}: {
  lines: readonly number[]
  spacing: number | undefined
  axis: "x" | "y"
}): { minimum_value_pixel: number; maximum_value_pixel: number } | undefined {
  if (spacing === undefined || lines.length < 2) return undefined
  const clustered: number[][] = []
  for (const line of uniqueSortedNumbers(lines)) {
    const current = clustered.at(-1)
    if (!current || line - current.at(-1)! > spacing * 0.2) clustered.push([line])
    else current.push(line)
  }
  const centers = clustered.map((cluster) => cluster.reduce((sum, value) => sum + value, 0) / cluster.length)
  const tolerance = Math.max(2, spacing * 0.08)
  const runs: number[][] = []
  let current_run: number[] = []
  for (const center of centers) {
    const prior = current_run.at(-1)
    if (prior === undefined || Math.abs(center - prior - spacing) <= tolerance) current_run.push(center)
    else {
      if (current_run.length > 0) runs.push(current_run)
      current_run = [center]
    }
  }
  if (current_run.length > 0) runs.push(current_run)
  runs.sort((left, right) => {
    const left_span = left.at(-1)! - left[0]!
    const right_span = right.at(-1)! - right[0]!
    return right.length - left.length || right_span - left_span || left[0]! - right[0]!
  })
  const best = runs[0]
  if (!best || best.length < 3) return undefined
  const low_pixel = best[0]!
  const high_pixel = best.at(-1)!
  return axis === "x"
    ? { minimum_value_pixel: low_pixel, maximum_value_pixel: high_pixel }
    : { minimum_value_pixel: high_pixel, maximum_value_pixel: low_pixel }
}

function boundedDivisionScales(
  candidates: readonly ReferenceDivisionScaleSource[],
  unit: "s" | "V",
): ReferenceGraphPreflightDivisionScale[] {
  const seen = new Set<string>()
  return candidates
    .filter(({ normalized_unit, confidence }) => normalized_unit === unit && confidence >= 15)
    .sort(
      (left, right) =>
        left.ocr_bbox_px.top - right.ocr_bbox_px.top ||
        left.ocr_bbox_px.left - right.ocr_bbox_px.left ||
        left.value_per_division_si - right.value_per_division_si ||
        left.raw_text.localeCompare(right.raw_text),
    )
    .flatMap((candidate) => {
      const center = {
        x: (candidate.ocr_bbox_px.left + candidate.ocr_bbox_px.width / 2) / OCR_SCALE,
        y: (candidate.ocr_bbox_px.top + candidate.ocr_bbox_px.height / 2) / OCR_SCALE,
      }
      const key = JSON.stringify([candidate.raw_text, candidate.value_per_division_si, center.x, center.y])
      if (seen.has(key)) return []
      seen.add(key)
      return [
        {
          raw_text: candidate.raw_text,
          value_per_division_si: candidate.value_per_division_si,
          observer_center_px: center,
        },
      ]
    })
    .slice(0, 16)
}

function boundedMeasurements(candidates: readonly MeasurementCandidate[]) {
  const seen = new Set<string>()
  return [...candidates]
    .sort(
      (left, right) =>
        left.bbox.top - right.bbox.top ||
        left.bbox.left - right.bbox.left ||
        left.value_si - right.value_si ||
        left.raw_text.localeCompare(right.raw_text),
    )
    .flatMap((candidate) => {
      const center = {
        x: (candidate.bbox.left + candidate.bbox.width / 2) / OCR_SCALE,
        y: (candidate.bbox.top + candidate.bbox.height / 2) / OCR_SCALE,
      }
      const key = JSON.stringify([candidate.raw_text, candidate.unit, candidate.value_si, center.x, center.y])
      if (seen.has(key)) return []
      seen.add(key)
      return [
        {
          raw_text: candidate.raw_text,
          unit: candidate.unit,
          value_si: candidate.value_si,
          observer_center_px: center,
        },
      ]
    })
    .slice(0, 24)
}

/** Build deterministic immutable-source hints before the first agent attempt. */
export async function analyzeReferenceGraphPreflight(input: {
  graph: FoundObservedReferenceGraph
  source_pdf_sha256: string
  datasheet_path: string
  process_runner: ProcessRunner
  signal: AbortSignal
}): Promise<{
  preflight: ReferenceGraphPreflight
  source_analysis: ReferenceGraphImmutableSourceAnalysis
}> {
  input.signal.throwIfAborted()
  const source_pdf = await readFile(input.datasheet_path)
  if (sha256(source_pdf) !== input.source_pdf_sha256) {
    throw new Error("Reference graph preflight received a datasheet that does not match discovery")
  }
  const workspace = await createStageWorkspace({
    prefix: `model-reference-preflight-${input.graph.graph_id}`,
    files: [{ source: input.datasheet_path, destination: "datasheet.pdf" }],
  })
  try {
    const engine_version = await tesseractVersion({
      process_runner: input.process_runner,
      cwd: workspace.path,
      signal: input.signal,
    })
    const render_prefix = join(workspace.path, `${input.graph.graph_id}-preflight`)
    const crop = input.graph.crop
    await input.process_runner.run({
      command: [
        "pdftoppm",
        "-f",
        String(crop.page),
        "-l",
        String(crop.page),
        "-r",
        String(OCR_DPI),
        "-x",
        String(crop.x_px * OCR_SCALE),
        "-y",
        String(crop.y_px * OCR_SCALE),
        "-W",
        String(crop.width_px * OCR_SCALE),
        "-H",
        String(crop.height_px * OCR_SCALE),
        "-png",
        "-singlefile",
        join(workspace.path, "datasheet.pdf"),
        render_prefix,
      ],
      command_label: `Render reference preflight ${input.graph.graph_id}`,
      cwd: workspace.path,
      signal: input.signal,
      wall_timeout_ms: 120_000,
      max_output_chars: 20_000,
    })
    input.signal.throwIfAborted()
    const image_path = `${render_prefix}.png`
    const ocr_base = join(workspace.path, `${input.graph.graph_id}-preflight-ocr`)
    await input.process_runner.run({
      command: ["tesseract", image_path, ocr_base, "-l", "eng", "--psm", "11", "tsv"],
      command_label: `OCR reference preflight ${input.graph.graph_id}`,
      cwd: workspace.path,
      signal: input.signal,
      wall_timeout_ms: 120_000,
      max_output_chars: 20_000,
    })
    input.signal.throwIfAborted()
    const [png, tsv, decoded, bbox_html] = await Promise.all([
      readFile(image_path),
      readFile(`${ocr_base}.tsv`, "utf8"),
      decodeModelEvidencePng(image_path, `reference preflight ${input.graph.graph_id}`),
      extractPdfTextBBox({
        graph: input.graph,
        workspace: workspace.path,
        process_runner: input.process_runner,
        signal: input.signal,
      }),
    ])
    if (Buffer.byteLength(tsv) < 1 || Buffer.byteLength(tsv) > MAX_TSV_BYTES) {
      throw new Error(`Reference graph preflight ${input.graph.graph_id} OCR output is not bounded`)
    }
    const expected_width = crop.width_px * OCR_SCALE
    const expected_height = crop.height_px * OCR_SCALE
    if (decoded.width !== expected_width || decoded.height !== expected_height) {
      throw new Error(`Reference graph preflight ${input.graph.graph_id} rendered unexpected dimensions`)
    }
    const full_words = parseTesseractTsv(tsv)
    const measurements = measurementCandidates(full_words)
    const explicit_time = alignedExplicitAxisCalibration({
      axis: "x",
      unit: "s",
      candidates: measurements,
    })
    const explicit_voltage = alignedExplicitAxisCalibration({
      axis: "y",
      unit: "V",
      candidates: measurements,
    })
    const full_scales = divisionScaleCandidates(full_words)
    const x_lines = neutralGridProfileForCrop({ decoded, axis: "x" })
    const y_lines = neutralGridProfileForCrop({ decoded, axis: "y" })
    const x_spacing = dominantGridSpacing(x_lines)
    const y_spacing = dominantGridSpacing(y_lines)
    const x_anchor_pixels = recommendedGridAnchorPixels({
      lines: x_lines,
      spacing: x_spacing,
      axis: "x",
    })
    const y_anchor_pixels = recommendedGridAnchorPixels({
      lines: y_lines,
      spacing: y_spacing,
      axis: "y",
    })
    const panels = await ocrScopePanels({
      graph: input.graph,
      full_words,
      render_width: decoded.width,
      render_height: decoded.height,
      plot_right_px: x_anchor_pixels?.maximum_value_pixel,
      workspace: workspace.path,
      process_runner: input.process_runner,
      signal: input.signal,
    })
    input.signal.throwIfAborted()
    const horizontal_scales = divisionScaleCandidates(panels?.horizontal_words ?? [])
    const channel_scales = divisionScaleCandidates(panels?.channel_words ?? [])
    const division_scales = [...full_scales, ...horizontal_scales, ...channel_scales]
    let selected_time_scale =
      uniqueDivisionScale(horizontal_scales, "s") ?? uniqueDivisionScale(full_scales, "s")
    selected_time_scale = recoverMissingTimeDivisionPrefix(
      selected_time_scale,
      panels?.horizontal_words ?? [],
    )
    const voltage_division_values = uniqueSortedNumbers(
      division_scales
        .filter(({ normalized_unit, confidence }) => normalized_unit === "V" && confidence >= 15)
        .map(({ value_per_division_si }) => value_per_division_si),
    )
    const source_seconds_per_pixel_candidates = uniqueSortedNumbers([
      ...(explicit_time ? [explicit_time.units_per_pixel] : []),
      ...(selected_time_scale && x_spacing ? [selected_time_scale.value_per_division_si / x_spacing] : []),
    ])
    const source_volts_per_pixel_candidates =
      y_spacing === undefined ? [] : voltage_division_values.map((value) => value / y_spacing)
    const crop_proof = canonicalReferenceCropProof(crop)
    const preflight: ReferenceGraphPreflight = {
      version: 1,
      graph_id: input.graph.graph_id,
      source_pdf_sha256: input.source_pdf_sha256,
      page: input.graph.page,
      canonical_crop: crop_proof.canonical_crop,
      canonical_crop_sha256: crop_proof.canonical_crop_sha256,
      figure_identity: figureIdentityFromPdfText({
        graph: input.graph,
        bbox_html,
      }),
      x_axis: {
        quantity: "time",
        unit: "s",
        elapsed_time_origin: 0,
        grid_line_candidates_px: x_lines,
        ...(x_spacing === undefined ? {} : { median_grid_spacing_px: x_spacing }),
        ...(x_anchor_pixels ? { recommended_anchor_pixels: x_anchor_pixels } : {}),
        division_scale_candidates: boundedDivisionScales(division_scales, "s"),
        ...(explicit_time
          ? {
              explicit_tick_calibration: {
                first: explicit_time.first,
                second: explicit_time.second,
                seconds_per_pixel: explicit_time.units_per_pixel,
                supporting_tick_count: explicit_time.supporting_tick_count,
              },
            }
          : {}),
        source_seconds_per_pixel_candidates,
        required_anchor_value_span_candidates: x_anchor_pixels
          ? source_seconds_per_pixel_candidates.map(
              (units_per_pixel) =>
                units_per_pixel *
                Math.abs(x_anchor_pixels.maximum_value_pixel - x_anchor_pixels.minimum_value_pixel),
            )
          : [],
      },
      y_axis: {
        quantity: "voltage",
        unit: "V",
        grid_line_candidates_px: y_lines,
        ...(y_spacing === undefined ? {} : { median_grid_spacing_px: y_spacing }),
        ...(y_anchor_pixels ? { recommended_anchor_pixels: y_anchor_pixels } : {}),
        division_scale_candidates: boundedDivisionScales(division_scales, "V"),
        ...(explicit_voltage
          ? {
              explicit_tick_calibration: {
                first: explicit_voltage.first,
                second: explicit_voltage.second,
                volts_per_pixel: explicit_voltage.units_per_pixel,
                supporting_tick_count: explicit_voltage.supporting_tick_count,
              },
            }
          : {}),
        source_volts_per_pixel_candidates,
        required_anchor_value_span_candidates: y_anchor_pixels
          ? source_volts_per_pixel_candidates.map(
              (units_per_pixel) =>
                units_per_pixel *
                Math.abs(y_anchor_pixels.maximum_value_pixel - y_anchor_pixels.minimum_value_pixel),
            )
          : [],
      },
      recognized_measurements: boundedMeasurements(measurements),
    }
    return {
      preflight,
      source_analysis: {
        graph_id: input.graph.graph_id,
        source_pdf_sha256: input.source_pdf_sha256,
        page: input.graph.page,
        canonical_crop_sha256: crop_proof.canonical_crop_sha256,
        engine_version,
        png,
        decoded,
        tsv,
        bbox_html,
        full_words,
      },
    }
  } finally {
    await workspace.dispose().catch(() => undefined)
  }
}

/** Public JSON-only preflight entry point. */
export async function buildReferenceGraphPreflight(
  input: Parameters<typeof analyzeReferenceGraphPreflight>[0],
): Promise<ReferenceGraphPreflight> {
  return (await analyzeReferenceGraphPreflight(input)).preflight
}
