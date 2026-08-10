import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { createStageWorkspace } from "../../infrastructure/artifacts"
import type { ProcessRunner } from "../../infrastructure/process"
import { decodeModelEvidencePng } from "../model-evidence-pages"
import {
  eligibleObservedGraphs,
  type EligibleObservedReferenceChannel,
  primaryResponseChannel,
  type ReferenceGraphObservation,
} from "../reference-graph-observation"
import { canonicalReferenceCropProof } from "../reference-graph-crop-proof"
import type { TimeGraphDiscovery, TimeGraphTransientFixtureEvidence } from "../time-graph-hints"
import { alignedExplicitAxisCalibration, axisTicks } from "./explicit-ticks"
import {
  divisionScaleCandidates,
  measurementCandidates,
  parseTesseractTsv,
  tesseractVersion,
} from "./ocr-extraction"
import { extractPdfTextBBox, figureIdentityFromPdfText, nominalVoltageFromPdfText } from "./pdf-extraction"
import type { ReferenceGraphImmutableSourceAnalysis } from "./preflight"
import {
  dominantGrid,
  divisionScaleNearestTrace,
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

export function printedNominalSourcesByGraphId(input: {
  observation: ReferenceGraphObservation
  discovery: TimeGraphDiscovery
}): Record<string, TimeGraphTransientFixtureEvidence> {
  const hint_by_id = new Map(input.discovery.hints.map((hint) => [hint.hint_id, hint]))
  const evidence_by_graph = new Map<string, TimeGraphTransientFixtureEvidence[]>()
  for (const review of input.observation.reviewed_hints) {
    if (review.disposition !== "graph" || !review.graph_id) continue
    const evidence = hint_by_id.get(review.hint_id)?.transient_fixture_evidence
    if (!evidence) continue
    const values = evidence_by_graph.get(review.graph_id) ?? []
    values.push(evidence)
    evidence_by_graph.set(review.graph_id, values)
  }
  return Object.fromEntries(
    [...evidence_by_graph.entries()].flatMap(([graph_id, values]) => {
      const unique = [...new Set(values.map((value) => JSON.stringify(value)))]
      return unique.length === 1
        ? [[graph_id, JSON.parse(unique[0]!) as TimeGraphTransientFixtureEvidence]]
        : []
    }),
  )
}

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
  graph: EligibleObservedReferenceChannel
  source_pdf_sha256: string
  workspace: string
  process_runner: ProcessRunner
  signal: AbortSignal
  engine_version: string
  printed_nominal_source?: TimeGraphTransientFixtureEvidence
  immutable_source_analysis?: ReferenceGraphImmutableSourceAnalysis
}): Promise<ReferenceGraphAxisProofResult> {
  const crop = input.graph.crop
  const crop_proof = canonicalReferenceCropProof(crop)
  const analysis = input.immutable_source_analysis
  if (
    analysis &&
    (analysis.graph_id !== input.graph.source_graph_id ||
      analysis.source_pdf_sha256 !== input.source_pdf_sha256 ||
      analysis.page !== input.graph.page ||
      analysis.canonical_crop_sha256 !== crop_proof.canonical_crop_sha256)
  ) {
    throw new Error(
      `Reference-axis proof received mismatched immutable analysis for ${input.graph.source_graph_id}`,
    )
  }
  let png: Buffer
  let tsv: string
  let png_dimensions: Awaited<ReturnType<typeof decodeModelEvidencePng>>
  let bbox_html: string
  let full_words: TesseractWord[]
  let engine_version = input.engine_version
  if (analysis) {
    png = analysis.png
    tsv = analysis.tsv
    png_dimensions = analysis.decoded
    bbox_html = analysis.bbox_html
    full_words = analysis.full_words
    engine_version = analysis.engine_version
  } else {
    const render_prefix = join(input.workspace, `${input.graph.graph_id}-axis`)
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
    ;[png, tsv] = await Promise.all([readFile(image_path), readFile(`${ocr_base}.tsv`, "utf8")])
    png_dimensions = await decodeModelEvidencePng(image_path, `axis proof ${input.graph.graph_id}`)
    bbox_html = await extractPdfTextBBox({
      graph: input.graph,
      workspace: input.workspace,
      process_runner: input.process_runner,
      signal: input.signal,
    })
    full_words = parseTesseractTsv(tsv)
  }
  if (Buffer.byteLength(tsv) < 1 || Buffer.byteLength(tsv) > MAX_TSV_BYTES) {
    return {
      status: "ineligible",
      graph_id: input.graph.source_graph_id,
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
  if (png_dimensions.width !== expected_width || png_dimensions.height !== expected_height) {
    throw new Error(`Canonical axis crop ${input.graph.graph_id} rendered with unexpected dimensions`)
  }
  const figure_identity = figureIdentityFromPdfText({
    graph: input.graph,
    bbox_html,
  })
  const measurements = measurementCandidates(full_words)
  const ticks = axisTicks({ graph: input.graph, candidates: measurements })
  const explicit_time = alignedExplicitAxisCalibration({
    axis: "x",
    unit: "s",
    candidates: measurements,
  })
  const common = {
    version: 1 as const,
    graph_id: input.graph.source_graph_id,
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
        engine_version,
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
  let nominal_source:
    | {
        kind: "pdf"
        value: number
        source_text: string
        bbox: NonNullable<ReturnType<typeof nominalVoltageFromPdfText>>["bbox"]
      }
    | {
        kind: "printed_experiment"
        evidence: TimeGraphTransientFixtureEvidence
      }
    | undefined
  let nominal_point_indexes: number[] = []
  let nominal_baseline_pixel: number | undefined
  let source_seconds_per_pixel: number | undefined
  let source_volts_per_pixel: number | undefined
  let use_explicit_time = false
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
      divisionScaleNearestTrace({
        candidates: [
          ...full_division_candidates,
          ...horizontal_division_candidates,
          ...channel_division_candidates,
        ],
        unit: "V",
        graph: input.graph,
      }) ??
      uniqueDivisionScale(channel_division_candidates, "V") ??
      uniqueDivisionScale(full_division_candidates, "V")
    x_grid_lines = neutralGridProfile({
      decoded: png_dimensions,
      axis: "x",
      graph: input.graph,
    })
    y_grid_lines = neutralGridProfile({
      decoded: png_dimensions,
      axis: "y",
      graph: input.graph,
    })
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
    const pdf_nominal_source = nominalVoltageFromPdfText({
      graph: input.graph,
      bbox_html,
    })
    const printed_nominal_source = input.printed_nominal_source
    if (pdf_nominal_source) {
      nominal_source = { kind: "pdf", ...pdf_nominal_source }
    } else if (
      printed_nominal_source &&
      printed_nominal_source.response.nominal_volts === input.graph.electrical_binding.response.nominal_volts
    ) {
      nominal_source = {
        kind: "printed_experiment",
        evidence: printed_nominal_source,
      }
    }
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
    use_explicit_time = !time_scale && explicit_time !== undefined
    source_seconds_per_pixel =
      time_scale && x_grid
        ? time_scale.value_per_division_si / x_grid.median_spacing_px
        : explicit_time?.units_per_pixel
    source_volts_per_pixel =
      voltage_scale && y_grid ? voltage_scale.value_per_division_si / y_grid.median_spacing_px : undefined
    if (!figure_identity) missing_proofs.push("adjacent_figure_identity")
    if (!panels) missing_proofs.push("oscilloscope_panels")
    if (!time_scale && !explicit_time) {
      missing_proofs.push("unique_printed_time_per_division_or_aligned_time_ticks")
    }
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
      (time_scale || explicit_time) &&
      voltage_scale &&
      x_grid &&
      y_grid &&
      nominal_source &&
      nominal_baseline_pixel !== undefined &&
      source_seconds_per_pixel !== undefined &&
      source_volts_per_pixel !== undefined
    ) {
      const canonical_x_grid = {
        ...x_grid,
        first_anchor_error_px: 0,
        second_anchor_error_px: 0,
      }
      const explicit_x_axis =
        use_explicit_time && explicit_time
          ? {
              quantity: "time" as const,
              unit: "s" as const,
              first: explicit_time.first,
              second: explicit_time.second,
              grid: canonical_x_grid,
              declared_seconds_per_pixel: source_seconds_per_pixel,
              source_seconds_per_pixel,
              supporting_tick_count: explicit_time.supporting_tick_count,
            }
          : undefined
      const division_x_axis =
        !use_explicit_time && time_scale
          ? {
              quantity: "time" as const,
              unit: "s" as const,
              division_scale: time_scale,
              grid: canonical_x_grid,
              // Eligibility above checks the observer declaration. The retained
              // receipt records the server-canonical value so rebuilding it from
              // the canonicalized observation is exactly idempotent.
              declared_seconds_per_pixel: source_seconds_per_pixel,
              source_seconds_per_pixel,
            }
          : undefined
      const scope_receipt_common = {
        ...common,
        figure_identity,
        ocr: {
          engine: "tesseract" as const,
          engine_version,
          language: "eng" as const,
          page_segmentation_mode: 11 as const,
          tsv_sha256: sha256(tsv),
          panel_tsv_sha256,
        },
        y_axis: {
          quantity: "voltage" as const,
          unit: "V" as const,
          division_scale: voltage_scale,
          grid: {
            ...y_grid,
            first_anchor_error_px: 0,
            second_anchor_error_px: 0,
          },
          declared_volts_per_pixel: source_volts_per_pixel,
          source_volts_per_pixel,
          nominal_baseline_volts:
            nominal_source.kind === "pdf"
              ? nominal_source.value
              : nominal_source.evidence.response.nominal_volts,
          nominal_baseline_pixel,
          nominal_trace_point_indexes: nominal_point_indexes,
        },
      }
      if (nominal_source.kind === "pdf") {
        const y_axis = {
          ...scope_receipt_common.y_axis,
          nominal_source_text: nominal_source.source_text,
          nominal_source_bbox_pdf_points: nominal_source.bbox,
        }
        if (explicit_x_axis) {
          receipt = {
            ...scope_receipt_common,
            algorithm: "canonical_pdf_tesseract_explicit_time_scope_voltage_v1",
            x_axis: explicit_x_axis,
            y_axis,
          }
        } else if (division_x_axis) {
          receipt = {
            ...scope_receipt_common,
            algorithm: "canonical_pdf_tesseract_scope_divisions_v2",
            x_axis: division_x_axis,
            y_axis,
          }
        }
      } else {
        const y_axis = {
          ...scope_receipt_common.y_axis,
          nominal_source: {
            algorithm: "printed_experiment_conditions_v3" as const,
            source_excerpts: structuredClone(nominal_source.evidence.source_excerpts),
            signal: nominal_source.evidence.response.signal,
            nominal_volts: nominal_source.evidence.response.nominal_volts,
          },
        }
        if (explicit_x_axis) {
          receipt = {
            ...scope_receipt_common,
            algorithm: "canonical_pdf_tesseract_explicit_time_scope_voltage_v2",
            x_axis: explicit_x_axis,
            y_axis,
          }
        } else if (division_x_axis) {
          receipt = {
            ...scope_receipt_common,
            algorithm: "canonical_pdf_tesseract_scope_divisions_v3",
            x_axis: division_x_axis,
            y_axis,
          }
        }
      }
    }
  }
  if (!receipt) {
    const x_anchor_pixel_span = Math.abs(
      input.graph.digitized_curve.x_axis.second.pixel - input.graph.digitized_curve.x_axis.first.pixel,
    )
    const y_anchor_pixel_span = Math.abs(
      input.graph.digitized_curve.y_axis.second.pixel - input.graph.digitized_curve.y_axis.first.pixel,
    )
    const recognized_measurements = [
      ...(source_seconds_per_pixel === undefined ||
      !missing_proofs.includes("declared_time_scale_matches_source")
        ? []
        : [
            `server-source-seconds-per-pixel:${source_seconds_per_pixel.toPrecision(12)}`,
            `server-required-x-anchor-value-span:${(source_seconds_per_pixel * x_anchor_pixel_span).toPrecision(12)}s`,
          ]),
      ...(source_volts_per_pixel === undefined ||
      !missing_proofs.includes("declared_voltage_scale_matches_source")
        ? []
        : [
            `server-source-volts-per-pixel:${source_volts_per_pixel.toPrecision(12)}`,
            `server-required-y-anchor-value-span:${(source_volts_per_pixel * y_anchor_pixel_span).toPrecision(12)}V`,
          ]),
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
      graph_id: input.graph.source_graph_id,
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
    graph_id: input.graph.source_graph_id,
    receipt,
    receipt_sha256: sha256(canonicalJson(receipt)),
  }
}

/**
 * Builds a deterministic, source-owned calibration receipt. Unsupported or
 * ambiguous graph axes are returned as typed data-level ineligibility so the
 * observer stage can provide precise correction feedback without confusing the
 * result with an OCR/runtime infrastructure failure.
 */
export async function buildReferenceGraphSourceProof(input: {
  observation: ReferenceGraphObservation
  datasheet_path: string
  process_runner: ProcessRunner
  signal: AbortSignal
  printed_nominal_sources_by_graph_id?: Readonly<Record<string, TimeGraphTransientFixtureEvidence>>
  immutable_source_analysis_by_graph_id?: Readonly<Record<string, ReferenceGraphImmutableSourceAnalysis>>
}): Promise<ReferenceGraphSourceProof> {
  const source_pdf = await readFile(input.datasheet_path)
  const actual_sha256 = sha256(source_pdf)
  if (actual_sha256 !== input.observation.source_pdf_sha256) {
    throw new Error("Reference-axis proof received a datasheet that does not match the observation digest")
  }
  const graphs = eligibleObservedGraphs(input.observation).map((graph) => {
    const channel = primaryResponseChannel(graph)
    if (!channel) {
      throw new Error(`Eligible reference graph ${graph.graph_id} has no bound primary response channel`)
    }
    return channel
  })
  if (graphs.length === 0) {
    return { version: 1, source_pdf_sha256: actual_sha256, results: [] }
  }
  const workspace = await createStageWorkspace({
    prefix: "model-reference-axis-proof",
    files: [{ source: input.datasheet_path, destination: "datasheet.pdf" }],
  })
  try {
    await mkdir(workspace.path, { recursive: true })
    let engine_version = ""
    if (
      graphs.some(
        (graph) => input.immutable_source_analysis_by_graph_id?.[graph.source_graph_id] === undefined,
      )
    ) {
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
          printed_nominal_source: input.printed_nominal_sources_by_graph_id?.[graph.source_graph_id],
          immutable_source_analysis: input.immutable_source_analysis_by_graph_id?.[graph.source_graph_id],
        }),
      )
    }
    return { version: 1, source_pdf_sha256: actual_sha256, results }
  } finally {
    await workspace.dispose().catch(() => undefined)
  }
}
