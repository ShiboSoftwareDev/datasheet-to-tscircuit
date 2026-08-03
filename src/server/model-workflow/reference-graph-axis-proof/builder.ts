import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { createStageWorkspace } from "../../infrastructure/artifacts"
import type { ProcessRunner } from "../../infrastructure/process"
import { decodeModelEvidencePng } from "../model-evidence-pages"
import { eligibleObservedGraphs, type ReferenceGraphObservation } from "../reference-graph-observation"
import { canonicalReferenceCropProof } from "../reference-graph-crop-proof"
import { axisTicks } from "./explicit-ticks"
import {
  divisionScaleCandidates,
  measurementCandidates,
  parseTesseractTsv,
  tesseractVersion,
} from "./ocr-extraction"
import { extractPdfTextBBox, figureIdentityFromPdfText, nominalVoltageFromPdfText } from "./pdf-extraction"
import {
  dominantGrid,
  neutralGridProfile,
  ocrScopePanels,
  recoverMissingTimeDivisionPrefix,
  relativeScaleAgreement,
  uniqueDivisionScale,
} from "./scope-divisions"
import { canonicalJson, MAX_TSV_BYTES, OCR_DPI, OCR_SCALE, sha256 } from "./shared"
import type {
  ReferenceDivisionScaleSource,
  ReferenceGraphAxisCalibrationReceipt,
  ReferenceGraphAxisProofResult,
  ReferenceGraphSourceProof,
  ReferenceGridCalibrationSource,
  TesseractWord,
} from "./types"

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function stableTraceEdgeBaseline(
  points: readonly { pixel_y: number }[],
  tolerance_px: number,
): { nominal_baseline_pixel: number; nominal_trace_point_indexes: number[] } | undefined {
  if (points.length < 2 || !(tolerance_px > 0)) return undefined
  const edge_indexes = [...new Set([0, 1, points.length - 2, points.length - 1])]
  const clusters = edge_indexes.map((candidate_index) => {
    const center = points[candidate_index]!.pixel_y
    const indexes = edge_indexes.filter((index) => Math.abs(points[index]!.pixel_y - center) <= tolerance_px)
    const pixel_values = indexes.map((index) => points[index]!.pixel_y)
    const baseline = median(pixel_values)
    const spread = Math.max(...pixel_values) - Math.min(...pixel_values)
    return { candidate_index, indexes, baseline, spread }
  })
  clusters.sort(
    (left, right) =>
      right.indexes.length - left.indexes.length ||
      left.spread - right.spread ||
      left.candidate_index - right.candidate_index,
  )
  const best = clusters[0]
  if (!best || best.indexes.length < 2) return undefined
  return {
    nominal_baseline_pixel: best.baseline,
    nominal_trace_point_indexes: points.flatMap((point, index) =>
      Math.abs(point.pixel_y - best.baseline) <= tolerance_px ? [index] : [],
    ),
  }
}

async function proveGraphAxis(input: {
  graph: ReturnType<typeof eligibleObservedGraphs>[number]
  source_pdf_sha256: string
  workspace: string
  process_runner: ProcessRunner
  signal: AbortSignal
  engine_version: string
}): Promise<ReferenceGraphAxisProofResult> {
  const render_prefix = join(input.workspace, `${input.graph.graph_id}-axis`)
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
      join(input.workspace, "datasheet.pdf"),
      render_prefix,
    ],
    command_label: `Render canonical axis crop ${input.graph.graph_id}`,
    cwd: input.workspace,
    signal: input.signal,
    wall_timeout_ms: 120_000,
    max_output_chars: 20_000,
  })
  const image_path = `${render_prefix}.png`
  const ocr_base = join(input.workspace, `${input.graph.graph_id}-ocr`)
  await input.process_runner.run({
    command: ["tesseract", image_path, ocr_base, "-l", "eng", "--psm", "11", "tsv"],
    command_label: `OCR canonical axis crop ${input.graph.graph_id}`,
    cwd: input.workspace,
    signal: input.signal,
    wall_timeout_ms: 120_000,
    max_output_chars: 20_000,
  })
  const [png, tsv] = await Promise.all([readFile(image_path), readFile(`${ocr_base}.tsv`, "utf8")])
  if (Buffer.byteLength(tsv) < 1 || Buffer.byteLength(tsv) > MAX_TSV_BYTES) {
    return {
      status: "ineligible",
      graph_id: input.graph.graph_id,
      code: "axis_calibration_unproven",
      reason: "Canonical crop OCR did not produce a bounded text receipt.",
      diagnostic: {
        recognized_measurements: [],
        missing_proofs: ["bounded_tesseract_tsv"],
      },
    }
  }
  const expected_width = crop.width_px * OCR_SCALE
  const expected_height = crop.height_px * OCR_SCALE
  const png_dimensions = await decodeModelEvidencePng(image_path, `axis proof ${input.graph.graph_id}`)
  if (png_dimensions.width !== expected_width || png_dimensions.height !== expected_height) {
    throw new Error(`Canonical axis crop ${input.graph.graph_id} rendered with unexpected dimensions`)
  }
  const bbox_html = await extractPdfTextBBox({
    graph: input.graph,
    workspace: input.workspace,
    process_runner: input.process_runner,
    signal: input.signal,
  })
  const figure_identity = figureIdentityFromPdfText({ graph: input.graph, bbox_html })
  const full_words = parseTesseractTsv(tsv)
  const measurements = measurementCandidates(full_words)
  const ticks = axisTicks({ graph: input.graph, candidates: measurements })
  const crop_proof = canonicalReferenceCropProof(crop)
  const common = {
    version: 1 as const,
    graph_id: input.graph.graph_id,
    source_pdf_sha256: input.source_pdf_sha256,
    page: input.graph.page,
    canonical_crop: crop_proof.canonical_crop,
    canonical_crop_sha256: crop_proof.canonical_crop_sha256,
    ocr_render: {
      render_dpi: 600 as const,
      observer_to_ocr_scale: 3 as const,
      width_px: png_dimensions.width,
      height_px: png_dimensions.height,
      png_sha256: sha256(png),
    },
  }
  let receipt: ReferenceGraphAxisCalibrationReceipt | undefined
  if (ticks && figure_identity) {
    receipt = {
      ...common,
      algorithm: "canonical_pdf_tesseract_explicit_ticks_v1",
      figure_identity,
      ocr: {
        engine: "tesseract",
        engine_version: input.engine_version,
        language: "eng",
        page_segmentation_mode: 11,
        tsv_sha256: sha256(tsv),
      },
      x_axis: {
        quantity: "time",
        unit: "s",
        first: ticks.x_first,
        second: ticks.x_second,
        seconds_per_pixel:
          (input.graph.digitized_curve.x_axis.second.value - input.graph.digitized_curve.x_axis.first.value) /
          (input.graph.digitized_curve.x_axis.second.pixel - input.graph.digitized_curve.x_axis.first.pixel),
      },
      y_axis: {
        quantity: "voltage",
        unit: "V",
        first: ticks.y_first,
        second: ticks.y_second,
        volts_per_pixel:
          (input.graph.digitized_curve.y_axis.second.value - input.graph.digitized_curve.y_axis.first.value) /
          (input.graph.digitized_curve.y_axis.second.pixel - input.graph.digitized_curve.y_axis.first.pixel),
      },
    }
  }
  const missing_proofs: string[] = []
  let panel_words: TesseractWord[] = []
  let panel_tsv_sha256: string | undefined
  let division_candidates: ReferenceDivisionScaleSource[] = []
  let time_scale: ReferenceDivisionScaleSource | undefined
  let voltage_scale: ReferenceDivisionScaleSource | undefined
  let x_grid: ReferenceGridCalibrationSource | undefined
  let y_grid: ReferenceGridCalibrationSource | undefined
  let x_grid_lines: number[] = []
  let y_grid_lines: number[] = []
  let nominal_source: ReturnType<typeof nominalVoltageFromPdfText>
  let nominal_point_indexes: number[] = []
  let nominal_baseline_pixel: number | undefined
  if (!receipt) {
    const panels = await ocrScopePanels({
      graph: input.graph,
      full_words,
      render_width: png_dimensions.width,
      render_height: png_dimensions.height,
      workspace: input.workspace,
      process_runner: input.process_runner,
      signal: input.signal,
    })
    panel_words = panels?.words ?? []
    panel_tsv_sha256 = panels?.combined_tsv_sha256
    const full_division_candidates = divisionScaleCandidates(full_words)
    const horizontal_division_candidates = divisionScaleCandidates(panels?.horizontal_words ?? [])
    const channel_division_candidates = divisionScaleCandidates(panels?.channel_words ?? [])
    division_candidates = [
      ...full_division_candidates,
      ...horizontal_division_candidates,
      ...channel_division_candidates,
    ]
    // Prefer semantically localized scope panels. A unique scale visible in
    // the exact canonical crop remains valid when a tight crop includes the
    // printed value but clips the faint panel heading used for focused OCR.
    // Ambiguous full-crop values still fail closed.
    time_scale =
      uniqueDivisionScale(horizontal_division_candidates, "s") ??
      uniqueDivisionScale(full_division_candidates, "s")
    time_scale = recoverMissingTimeDivisionPrefix(time_scale, panels?.horizontal_words ?? [])
    voltage_scale =
      uniqueDivisionScale(channel_division_candidates, "V") ??
      uniqueDivisionScale(full_division_candidates, "V")
    x_grid_lines = neutralGridProfile({ decoded: png_dimensions, axis: "x", graph: input.graph })
    y_grid_lines = neutralGridProfile({ decoded: png_dimensions, axis: "y", graph: input.graph })
    x_grid = dominantGrid({
      lines: x_grid_lines,
      first_anchor: input.graph.digitized_curve.x_axis.first.pixel,
      second_anchor: input.graph.digitized_curve.x_axis.second.pixel,
    })
    y_grid = dominantGrid({
      lines: y_grid_lines,
      first_anchor: input.graph.digitized_curve.y_axis.first.pixel,
      second_anchor: input.graph.digitized_curve.y_axis.second.pixel,
    })
    nominal_source = nominalVoltageFromPdfText({ graph: input.graph, bbox_html })
    const edge_baseline = stableTraceEdgeBaseline(
      input.graph.digitized_curve.points,
      (y_grid?.median_spacing_px ?? 0) * 0.15,
    )
    nominal_baseline_pixel = edge_baseline?.nominal_baseline_pixel
    nominal_point_indexes = edge_baseline?.nominal_trace_point_indexes ?? []
    const observer_declared_seconds_per_pixel = Math.abs(
      (input.graph.digitized_curve.x_axis.second.value - input.graph.digitized_curve.x_axis.first.value) /
        (input.graph.digitized_curve.x_axis.second.pixel - input.graph.digitized_curve.x_axis.first.pixel),
    )
    const observer_declared_volts_per_pixel = Math.abs(
      (input.graph.digitized_curve.y_axis.second.value - input.graph.digitized_curve.y_axis.first.value) /
        (input.graph.digitized_curve.y_axis.second.pixel - input.graph.digitized_curve.y_axis.first.pixel),
    )
    const source_seconds_per_pixel =
      time_scale && x_grid ? time_scale.value_per_division_si / x_grid.median_spacing_px : undefined
    const source_volts_per_pixel =
      voltage_scale && y_grid ? voltage_scale.value_per_division_si / y_grid.median_spacing_px : undefined
    if (!figure_identity) missing_proofs.push("adjacent_figure_identity")
    if (!panels) missing_proofs.push("oscilloscope_panels")
    if (!time_scale) missing_proofs.push("unique_printed_time_per_division")
    if (!voltage_scale) missing_proofs.push("unique_printed_voltage_per_division")
    if (!x_grid) missing_proofs.push("time_grid_and_anchor_alignment")
    if (!y_grid) missing_proofs.push("voltage_grid_and_anchor_alignment")
    if (!nominal_source) missing_proofs.push("printed_output_nominal_voltage")
    if (input.graph.digitized_curve.x_axis.first.value !== 0) {
      missing_proofs.push("server_elapsed_time_zero_origin")
    }
    if (input.graph.digitized_curve.x_axis.first.pixel >= input.graph.digitized_curve.x_axis.second.pixel) {
      missing_proofs.push("time_axis_screen_orientation")
    }
    if (input.graph.digitized_curve.y_axis.first.pixel <= input.graph.digitized_curve.y_axis.second.pixel) {
      missing_proofs.push("voltage_axis_screen_orientation")
    }
    if (nominal_point_indexes.length < 2 || nominal_baseline_pixel === undefined) {
      missing_proofs.push("nominal_voltage_trace_baseline")
    }
    if (
      source_seconds_per_pixel === undefined ||
      !relativeScaleAgreement(observer_declared_seconds_per_pixel, source_seconds_per_pixel)
    ) {
      missing_proofs.push("declared_time_scale_matches_source")
    }
    if (
      source_volts_per_pixel === undefined ||
      !relativeScaleAgreement(observer_declared_volts_per_pixel, source_volts_per_pixel)
    ) {
      missing_proofs.push("declared_voltage_scale_matches_source")
    }
    if (
      missing_proofs.length === 0 &&
      figure_identity &&
      panel_tsv_sha256 &&
      time_scale &&
      voltage_scale &&
      x_grid &&
      y_grid &&
      nominal_source &&
      nominal_baseline_pixel !== undefined &&
      source_seconds_per_pixel !== undefined &&
      source_volts_per_pixel !== undefined
    ) {
      receipt = {
        ...common,
        algorithm: "canonical_pdf_tesseract_scope_divisions_v2",
        figure_identity,
        ocr: {
          engine: "tesseract",
          engine_version: input.engine_version,
          language: "eng",
          page_segmentation_mode: 11,
          tsv_sha256: sha256(tsv),
          panel_tsv_sha256,
        },
        x_axis: {
          quantity: "time",
          unit: "s",
          division_scale: time_scale,
          grid: {
            ...x_grid,
            first_anchor_error_px: 0,
            second_anchor_error_px: 0,
          },
          // Eligibility above checks the observer declaration. The retained v2
          // receipt records the resulting server-canonical value so rebuilding
          // it from the canonicalized observation is exactly idempotent.
          declared_seconds_per_pixel: source_seconds_per_pixel,
          source_seconds_per_pixel,
        },
        y_axis: {
          quantity: "voltage",
          unit: "V",
          division_scale: voltage_scale,
          grid: {
            ...y_grid,
            first_anchor_error_px: 0,
            second_anchor_error_px: 0,
          },
          declared_volts_per_pixel: source_volts_per_pixel,
          source_volts_per_pixel,
          nominal_baseline_volts: nominal_source.value,
          nominal_source_text: nominal_source.source_text,
          nominal_source_bbox_pdf_points: nominal_source.bbox,
          nominal_baseline_pixel,
          nominal_trace_point_indexes: nominal_point_indexes,
        },
      }
    }
  }
  if (!receipt) {
    const recognized_measurements = [
      ...measurements.map(
        ({ raw_text, bbox }) =>
          `${raw_text}@${((bbox.left + bbox.width / 2) / OCR_SCALE).toFixed(2)},${((bbox.top + bbox.height / 2) / OCR_SCALE).toFixed(2)}`,
      ),
      ...division_candidates.map(({ raw_text }) => raw_text),
      ...(x_grid_lines.length > 0 ? [`x-grid:${x_grid_lines.map((line) => line.toFixed(2)).join(",")}`] : []),
      ...(y_grid_lines.length > 0 ? [`y-grid:${y_grid_lines.map((line) => line.toFixed(2)).join(",")}`] : []),
    ]
      .filter((text, index, all) => all.indexOf(text) === index)
      .slice(0, 32)
    return {
      status: "ineligible",
      graph_id: input.graph.graph_id,
      code: "axis_calibration_unproven",
      reason:
        "The exact canonical crop lacks a complete source-grounded explicit-tick or oscilloscope-division axis calibration.",
      diagnostic: {
        recognized_measurements,
        missing_proofs:
          missing_proofs.length > 0
            ? missing_proofs.slice(0, 24)
            : ["two_aligned_time_ticks", "two_aligned_voltage_ticks", "adjacent_figure_identity"],
      },
    }
  }
  return {
    status: "verified",
    graph_id: input.graph.graph_id,
    receipt,
    receipt_sha256: sha256(canonicalJson(receipt)),
  }
}

/**
 * Builds a deterministic, source-owned calibration receipt. Unsupported or
 * ambiguous graph axes are data-level ineligibility, not agent retry errors.
 */
export async function buildReferenceGraphSourceProof(input: {
  observation: ReferenceGraphObservation
  datasheet_path: string
  process_runner: ProcessRunner
  signal: AbortSignal
}): Promise<ReferenceGraphSourceProof> {
  const source_pdf = await readFile(input.datasheet_path)
  const actual_sha256 = sha256(source_pdf)
  if (actual_sha256 !== input.observation.source_pdf_sha256) {
    throw new Error("Reference-axis proof received a datasheet that does not match the observation digest")
  }
  const graphs = eligibleObservedGraphs(input.observation)
  if (graphs.length === 0) {
    return { version: 1, source_pdf_sha256: actual_sha256, results: [] }
  }
  const workspace = await createStageWorkspace({
    prefix: "model-reference-axis-proof",
    files: [{ source: input.datasheet_path, destination: "datasheet.pdf" }],
  })
  try {
    await mkdir(workspace.path, { recursive: true })
    let engine_version: string
    try {
      engine_version = await tesseractVersion({
        process_runner: input.process_runner,
        cwd: workspace.path,
        signal: input.signal,
      })
    } catch (error) {
      input.signal.throwIfAborted()
      throw new Error(
        "Reference-axis verification requires the tesseract OCR runtime; install tesseract-ocr in the production image and local test environment.",
        { cause: error },
      )
    }
    const results: ReferenceGraphAxisProofResult[] = []
    for (const graph of graphs) {
      input.signal.throwIfAborted()
      results.push(
        await proveGraphAxis({
          graph,
          source_pdf_sha256: actual_sha256,
          workspace: workspace.path,
          process_runner: input.process_runner,
          signal: input.signal,
          engine_version,
        }),
      )
    }
    return { version: 1, source_pdf_sha256: actual_sha256, results }
  } finally {
    await workspace.dispose().catch(() => undefined)
  }
}
