import { createHash } from "node:crypto"
import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  createStageWorkspace,
  validatePngArtifact,
  validateStageDirectory,
} from "../../infrastructure/artifacts"
import type { ProcessRunner } from "../../infrastructure/process"
import type { ModelCharacterization } from "../../modeling/types"
import { MODEL_REFERENCE_CROP_DPI } from "../../modeling/types"
import { decodeModelEvidencePng, modelReferenceFigureFile } from "../model-evidence-pages"
import { assertExactCanonicalReferenceCrop } from "../reference-graph-crop-proof"
import { eligibleObservedChannels, type EligibleObservedReferenceChannel } from "./eligibility"
import { sha256Json } from "./numeric-verification"
import type {
  ModelReferenceNumericVerification,
  ModelReferenceVerification,
  ReferenceGraphObservation,
  ReferenceGraphTraceColor,
} from "./types"

export interface ReferenceGraphPixelFailure {
  readonly graph_id: string
  readonly message: string
}

export class ReferenceGraphPixelVerificationError extends Error {
  readonly failures: readonly ReferenceGraphPixelFailure[]

  constructor(failures: readonly ReferenceGraphPixelFailure[]) {
    super(
      `Independent pixel-trace validation rejected ${failures.length} graph${failures.length === 1 ? "" : "s"}:\n${failures.map(({ message }) => `- ${message}`).join("\n")}`,
    )
    this.name = "ReferenceGraphPixelVerificationError"
    this.failures = failures
  }
}

function colorDistance(
  actual: readonly [number, number, number],
  expected: ReferenceGraphTraceColor,
): number {
  return Math.hypot(actual[0] - expected.r, actual[1] - expected.g, actual[2] - expected.b)
}

function pointTouchesTrace(input: {
  width: number
  height: number
  rgbAt(x: number, y: number): [number, number, number]
  pixel_x: number
  pixel_y: number
  color: ReferenceGraphTraceColor
  search_radius?: number
  horizontal_search_radius?: number
  vertical_search_radius?: number
}): boolean {
  const center_x = Math.round(input.pixel_x)
  const center_y = Math.round(input.pixel_y)
  const search_radius = input.search_radius ?? 4
  const horizontal_search_radius = input.horizontal_search_radius ?? search_radius
  const vertical_search_radius = input.vertical_search_radius ?? search_radius
  for (
    let y = Math.max(0, center_y - vertical_search_radius);
    y <= Math.min(input.height - 1, center_y + vertical_search_radius);
    y += 1
  ) {
    for (
      let x = Math.max(0, center_x - horizontal_search_radius);
      x <= Math.min(input.width - 1, center_x + horizontal_search_radius);
      x += 1
    ) {
      const actual = input.rgbAt(x, y)
      if (
        colorDistance(actual, input.color) <= input.color.tolerance ||
        bandColorMatches(actual, input.color)
      ) {
        return true
      }
    }
  }
  return false
}

interface OffTracePointDiagnostic {
  point_index: number
  pixel_x: number
  pixel_y: number
  nearest_color_distance: number
  nearest_matching_pixel?: {
    pixel_x: number
    pixel_y: number
    distance_px: number
  }
}

function diagnoseOffTracePoint(input: {
  width: number
  height: number
  rgbAt(x: number, y: number): [number, number, number]
  point_index: number
  pixel_x: number
  pixel_y: number
  color: ReferenceGraphTraceColor
  validation_radius: number
  diagnostic_radius: number
}): OffTracePointDiagnostic {
  const center_x = Math.round(input.pixel_x)
  const center_y = Math.round(input.pixel_y)
  let nearest_color_distance = Number.POSITIVE_INFINITY
  let nearest_matching_pixel: OffTracePointDiagnostic["nearest_matching_pixel"]
  for (
    let y = Math.max(0, center_y - input.diagnostic_radius);
    y <= Math.min(input.height - 1, center_y + input.diagnostic_radius);
    y += 1
  ) {
    for (
      let x = Math.max(0, center_x - input.diagnostic_radius);
      x <= Math.min(input.width - 1, center_x + input.diagnostic_radius);
      x += 1
    ) {
      const distance_px = Math.hypot(x - input.pixel_x, y - input.pixel_y)
      const distance_from_color = colorDistance(input.rgbAt(x, y), input.color)
      if (
        Math.abs(x - center_x) <= input.validation_radius &&
        Math.abs(y - center_y) <= input.validation_radius
      ) {
        nearest_color_distance = Math.min(nearest_color_distance, distance_from_color)
      }
      if (
        distance_from_color <= input.color.tolerance &&
        distance_px > input.validation_radius &&
        (!nearest_matching_pixel || distance_px < nearest_matching_pixel.distance_px)
      ) {
        nearest_matching_pixel = { pixel_x: x, pixel_y: y, distance_px }
      }
    }
  }
  return {
    point_index: input.point_index,
    pixel_x: input.pixel_x,
    pixel_y: input.pixel_y,
    nearest_color_distance,
    ...(nearest_matching_pixel ? { nearest_matching_pixel } : {}),
  }
}

function formatPixelCoordinate(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function formatOffTracePointDiagnostic(diagnostic: OffTracePointDiagnostic): string {
  const location = `#${diagnostic.point_index} (${formatPixelCoordinate(diagnostic.pixel_x)}, ${formatPixelCoordinate(diagnostic.pixel_y)})`
  if (diagnostic.nearest_matching_pixel) {
    const nearest = diagnostic.nearest_matching_pixel
    return `${location}: nearest declared-color pixel is (${nearest.pixel_x}, ${nearest.pixel_y}), ${nearest.distance_px.toFixed(1)}px away`
  }
  return `${location}: no declared-color pixel within 24px; closest validation-area color distance is ${diagnostic.nearest_color_distance.toFixed(1)}`
}

interface PixelTraceMeasurement {
  source_image_sha256: string
  verified_point_count: number
  total_point_count: number
  trace_color_coverage: number
  search_radius_px: 4
  segment_support_ratio: number
  minimum_segment_support_ratio: 0.85
  segment_search_radius_px: 6
}

const MINIMUM_SEGMENT_SUPPORT_RATIO = 0.85

function bandColorMatches(
  actual: readonly [number, number, number],
  expected: ReferenceGraphTraceColor,
): boolean {
  const expected_mean = (expected.r + expected.g + expected.b) / 3
  const actual_mean = (actual[0] + actual[1] + actual[2]) / 3
  const expected_chroma = [
    expected.r - expected_mean,
    expected.g - expected_mean,
    expected.b - expected_mean,
  ] as const
  const actual_chroma = [actual[0] - actual_mean, actual[1] - actual_mean, actual[2] - actual_mean] as const
  const expected_norm = Math.hypot(...expected_chroma)
  const actual_norm = Math.hypot(...actual_chroma)
  if (expected_norm < 30 || actual_norm < 12) {
    return colorDistance(actual, expected) <= expected.tolerance
  }
  const chroma_cosine =
    expected_chroma.reduce((sum, value, index) => sum + value * actual_chroma[index]!, 0) /
    (expected_norm * actual_norm)
  return chroma_cosine >= 0.8 && colorDistance(actual, expected) <= Math.min(230, expected.tolerance + 140)
}

function pointIsVerticallyBracketedByTrace(input: {
  width: number
  height: number
  rgbAt(x: number, y: number): [number, number, number]
  pixel_x: number
  pixel_y: number
  color: ReferenceGraphTraceColor
  horizontal_search_radius: number
  minimum_vertical_offset: number
  maximum_vertical_offset: number
}): boolean {
  const center_x = Math.round(input.pixel_x)
  const center_y = Math.round(input.pixel_y)
  let above = false
  let below = false
  for (
    let x = Math.max(0, center_x - input.horizontal_search_radius);
    x <= Math.min(input.width - 1, center_x + input.horizontal_search_radius);
    x += 1
  ) {
    for (let offset = input.minimum_vertical_offset; offset <= input.maximum_vertical_offset; offset += 1) {
      const above_y = center_y - offset
      const below_y = center_y + offset
      if (above_y >= 0 && bandColorMatches(input.rgbAt(x, above_y), input.color)) {
        above = true
      }
      if (below_y < input.height && bandColorMatches(input.rgbAt(x, below_y), input.color)) {
        below = true
      }
      if (above && below) return true
    }
  }
  return false
}

async function measureReferenceGraphTracePixels(input: {
  graph: EligibleObservedReferenceChannel
  image_path: string
  expected_width: number
  expected_height: number
  error_subject: string
}): Promise<PixelTraceMeasurement> {
  const decoded = await decodeModelEvidencePng(input.image_path, input.error_subject)
  if (decoded.width !== input.expected_width || decoded.height !== input.expected_height) {
    throw new Error(`Independent graph pixel proof for ${input.error_subject} has wrong crop dimensions`)
  }
  const transformed_points = input.graph.digitized_curve.points.map(({ pixel_x, pixel_y }) => ({
    pixel_x,
    pixel_y,
  }))
  if (
    transformed_points.some(
      ({ pixel_x, pixel_y }) =>
        pixel_x < 0 || pixel_x >= decoded.width || pixel_y < 0 || pixel_y >= decoded.height,
    )
  ) {
    throw new Error(
      `Independent pixel-trace proof for ${input.error_subject} contains a calibrated point outside the exact canonical crop`,
    )
  }
  const validation_radius = 4
  const off_trace_points = transformed_points.flatMap(({ pixel_x, pixel_y }, point_index) =>
    pointTouchesTrace({
      ...decoded,
      pixel_x,
      pixel_y,
      color: input.graph.digitized_curve.trace_color,
      search_radius: validation_radius,
    }) ||
    pointIsVerticallyBracketedByTrace({
      ...decoded,
      pixel_x,
      pixel_y,
      color: input.graph.digitized_curve.trace_color,
      horizontal_search_radius: 4,
      minimum_vertical_offset: 5,
      maximum_vertical_offset: 24,
    })
      ? []
      : [
          diagnoseOffTracePoint({
            ...decoded,
            point_index,
            pixel_x,
            pixel_y,
            color: input.graph.digitized_curve.trace_color,
            validation_radius,
            diagnostic_radius: 24,
          }),
        ],
  )
  const off_trace_count = off_trace_points.length
  const allowed_off_trace_count = Math.max(1, Math.floor(transformed_points.length * 0.05))
  if (off_trace_count > allowed_off_trace_count) {
    const color = input.graph.digitized_curve.trace_color
    const examples = off_trace_points.slice(0, 8).map(formatOffTracePointDiagnostic).join("; ")
    throw new Error(
      `Independent pixel-trace proof for ${input.error_subject} does not follow the rendered datasheet waveform: ${off_trace_count}/${transformed_points.length} calibrated points are off trace; at most ${allowed_off_trace_count} are allowed. Declared trace color is RGB(${color.r}, ${color.g}, ${color.b}) with tolerance ${color.tolerance}; validation radius is ${validation_radius}px. First failing crop-local points: ${examples}. Inspect the exact crop: when these points are on the correct same-hue centerline but the reported closest color distance exceeds the declared tolerance, recalibrate the representative RGB or widen tolerance (up to 120) to cover the line's antialiasing and brightness variation; otherwise move only the named points onto the rendered trace. Do not invent points to preserve an overly narrow color declaration.`,
    )
  }
  const segment_search_radius = 6
  let segment_sample_count = 0
  let supported_segment_sample_count = 0
  const segment_diagnostics: Array<{
    point_index: number
    start: { pixel_x: number; pixel_y: number }
    end: { pixel_x: number; pixel_y: number }
    sample_count: number
    supported_sample_count: number
  }> = []
  for (let point_index = 0; point_index + 1 < transformed_points.length; point_index += 1) {
    const start = transformed_points[point_index]!
    const end = transformed_points[point_index + 1]!
    const sample_count = Math.max(
      1,
      Math.ceil(Math.max(Math.abs(end.pixel_x - start.pixel_x), Math.abs(end.pixel_y - start.pixel_y))),
    )
    const weighted_sample_count = sample_count + 1
    segment_sample_count += weighted_sample_count
    const localized_raster_discontinuity =
      Math.abs(end.pixel_x - start.pixel_x) <= Math.max(2, Math.min(8, decoded.width * 0.0125)) &&
      Math.abs(end.pixel_y - start.pixel_y) >= 8 &&
      pointTouchesTrace({
        ...decoded,
        pixel_x: start.pixel_x,
        pixel_y: start.pixel_y,
        color: input.graph.digitized_curve.trace_color,
        search_radius: validation_radius,
      }) &&
      pointTouchesTrace({
        ...decoded,
        pixel_x: end.pixel_x,
        pixel_y: end.pixel_y,
        color: input.graph.digitized_curve.trace_color,
        search_radius: validation_radius,
      })
    let segment_supported_sample_count = localized_raster_discontinuity ? weighted_sample_count : 0
    if (!localized_raster_discontinuity) {
      for (let sample_index = 0; sample_index < weighted_sample_count; sample_index += 1) {
        const ratio = sample_index / Math.max(1, weighted_sample_count - 1)
        const sample = {
          ...decoded,
          pixel_x: start.pixel_x + (end.pixel_x - start.pixel_x) * ratio,
          pixel_y: start.pixel_y + (end.pixel_y - start.pixel_y) * ratio,
          color: input.graph.digitized_curve.trace_color,
        }
        if (
          pointTouchesTrace({
            ...sample,
            horizontal_search_radius: 1,
            vertical_search_radius: validation_radius,
          }) ||
          pointIsVerticallyBracketedByTrace({
            ...sample,
            horizontal_search_radius: 4,
            minimum_vertical_offset: 5,
            maximum_vertical_offset: 24,
          })
        ) {
          segment_supported_sample_count += 1
        }
      }
    }
    supported_segment_sample_count += segment_supported_sample_count
    segment_diagnostics.push({
      point_index,
      start,
      end,
      sample_count: weighted_sample_count,
      supported_sample_count: segment_supported_sample_count,
    })
  }
  const segment_support_ratio =
    segment_sample_count === 0 ? 0 : supported_segment_sample_count / segment_sample_count
  if (segment_support_ratio < MINIMUM_SEGMENT_SUPPORT_RATIO) {
    const weakest_segments = [...segment_diagnostics]
      .sort(
        (left, right) =>
          left.supported_sample_count / left.sample_count -
            right.supported_sample_count / right.sample_count ||
          right.sample_count - left.sample_count ||
          left.point_index - right.point_index,
      )
      .slice(0, 6)
      .map(({ point_index, start, end, sample_count, supported_sample_count }) => {
        const support_percent = ((supported_sample_count / sample_count) * 100).toFixed(1)
        return `#${point_index} (${formatPixelCoordinate(start.pixel_x)}, ${formatPixelCoordinate(start.pixel_y)}) -> #${point_index + 1} (${formatPixelCoordinate(end.pixel_x)}, ${formatPixelCoordinate(end.pixel_y)}): ${supported_sample_count}/${sample_count} straight-span samples (${support_percent}%) touch or are vertically bracketed by the declared-color trace`
      })
      .join("; ")
    throw new Error(
      `Independent pixel-trace proof for ${input.error_subject} has disconnected or shortcut point samples instead of a polyline that follows the rendered waveform: ${(segment_support_ratio * 100).toFixed(1)}% aggregate trace-following span support; at least ${(MINIMUM_SEGMENT_SUPPORT_RATIO * 100).toFixed(1)}% is required. Weakest point-to-point segments: ${weakest_segments}. Inspect the original-resolution crop and add or replace points inside every weak segment so the straight segment between each consecutive pair stays on the rendered response centerline, not another same-colored scope channel or a shortcut around a visible feature. Never remove, flatten, or reduce a visible spike, dip, edge, local maximum, or local minimum to satisfy continuity. Keep each visible extremum and insert intermediate points through its rendered path; reclaim point slots only from truly flat spans away from transitions. Preserve the required point count, 90% axis coverage, and maximum-gap rule.`,
    )
  }
  const pixel_count = decoded.width * decoded.height
  const stride = Math.max(1, Math.floor(pixel_count / 300_000))
  let sampled = 0
  let matching = 0
  for (let pixel = 0; pixel < pixel_count; pixel += stride) {
    sampled += 1
    const x = pixel % decoded.width
    const y = Math.floor(pixel / decoded.width)
    if (
      colorDistance(decoded.rgbAt(x, y), input.graph.digitized_curve.trace_color) <=
      input.graph.digitized_curve.trace_color.tolerance
    ) {
      matching += 1
    }
  }
  const trace_color_coverage = sampled === 0 ? 0 : matching / sampled
  if (trace_color_coverage < 0.000005 || trace_color_coverage > 0.2) {
    throw new Error(
      `Independent pixel-trace proof for ${input.error_subject} cannot distinguish the declared waveform color from absence or background`,
    )
  }
  return {
    source_image_sha256: createHash("sha256")
      .update(await readFile(input.image_path))
      .digest("hex"),
    verified_point_count: transformed_points.length - off_trace_count,
    total_point_count: input.graph.digitized_curve.points.length,
    trace_color_coverage,
    search_radius_px: 4,
    segment_support_ratio,
    minimum_segment_support_ratio: MINIMUM_SEGMENT_SUPPORT_RATIO,
    segment_search_radius_px: segment_search_radius,
  }
}

/** Validates observer-authored pixels before any characterization attempt runs. */
export async function verifyReferenceGraphObservationPixels(input: {
  observation: ReferenceGraphObservation
  datasheet_path: string
  process_runner: ProcessRunner
  signal: AbortSignal
  on_output?: (stream: "system" | "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<void> {
  const eligible = eligibleObservedChannels(input.observation)
  if (eligible.length === 0) return
  const workspace = await createStageWorkspace({
    prefix: "model-reference-pixel-proof",
    files: [{ source: input.datasheet_path, destination: "datasheet.pdf" }],
  })
  try {
    const figures_dir = join(workspace.path, "figures")
    await mkdir(figures_dir, { recursive: true })
    for (const graph of eligible) {
      input.signal.throwIfAborted()
      const output_prefix = join(figures_dir, graph.graph_id)
      await input.process_runner.run({
        command: [
          "pdftoppm",
          "-f",
          String(graph.page),
          "-l",
          String(graph.page),
          "-r",
          String(MODEL_REFERENCE_CROP_DPI),
          "-x",
          String(graph.crop.x_px),
          "-y",
          String(graph.crop.y_px),
          "-W",
          String(graph.crop.width_px),
          "-H",
          String(graph.crop.height_px),
          "-png",
          "-singlefile",
          join(workspace.path, "datasheet.pdf"),
          output_prefix,
        ],
        command_label: `Verify independent datasheet trace ${graph.graph_id}`,
        cwd: workspace.path,
        signal: input.signal,
        wall_timeout_ms: 120_000,
        max_output_chars: 20_000,
        on_output: input.on_output,
      })
    }
    await validateStageDirectory({
      root: figures_dir,
      max_files: eligible.length,
      max_total_bytes: 64 * 1024 * 1024,
      validate_file: validatePngArtifact,
    })
    const failures: ReferenceGraphPixelFailure[] = []
    for (const graph of eligible) {
      try {
        await measureReferenceGraphTracePixels({
          graph,
          image_path: join(figures_dir, `${graph.graph_id}.png`),
          expected_width: graph.crop.width_px,
          expected_height: graph.crop.height_px,
          error_subject: `independent graph ${graph.graph_id}`,
        })
      } catch (error) {
        input.signal.throwIfAborted()
        failures.push({
          graph_id: graph.graph_id,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (failures.length > 0) {
      throw new ReferenceGraphPixelVerificationError(failures)
    }
  } finally {
    await workspace.dispose().catch(() => undefined)
  }
}

/**
 * Completes the independent proof against server-rendered PDF pixels. Observer
 * coordinates are checked in the exact observer-owned crop. There is no
 * candidate-space translation or partial-inside allowance.
 */
export async function verifyReferenceGraphTracePixels(input: {
  characterization: ModelCharacterization
  observation: ReferenceGraphObservation
  numeric_verification: ModelReferenceNumericVerification
  evidence_dir: string
}): Promise<ModelReferenceVerification> {
  const requirements = new Map(
    input.characterization.requirements.map((requirement) => [requirement.requirement_id, requirement]),
  )
  const graphs = new Map(eligibleObservedChannels(input.observation).map((graph) => [graph.graph_id, graph]))
  const matches: ModelReferenceVerification["matches"] = []
  for (const match of input.numeric_verification.matches) {
    const requirement = requirements.get(match.requirement_id)
    const graph = graphs.get(match.graph_id)
    const candidate_crop = requirement?.reference_curve?.crop
    if (!requirement || !graph || !candidate_crop) {
      throw new Error(`Independent graph pixel proof is missing bound requirement ${match.requirement_id}`)
    }
    const crop_proof = assertExactCanonicalReferenceCrop({ requirement, graph })
    if (sha256Json(match.crop_proof) !== sha256Json(crop_proof)) {
      throw new Error(
        `Independent graph pixel proof has a stale canonical crop receipt for ${match.requirement_id}`,
      )
    }
    const image_path = modelReferenceFigureFile(input.evidence_dir, requirement)
    const pixel_trace = await measureReferenceGraphTracePixels({
      graph,
      image_path,
      expected_width: candidate_crop.width_px,
      expected_height: candidate_crop.height_px,
      error_subject: `modeled requirement ${requirement.requirement_id}`,
    })
    matches.push({
      ...match,
      pixel_trace,
    })
  }
  return {
    version: 2,
    source_pdf_sha256: input.numeric_verification.source_pdf_sha256,
    matches,
  }
}
