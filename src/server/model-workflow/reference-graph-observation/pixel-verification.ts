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
import { decodeModelEvidencePng } from "../model-evidence-pages"
import { assertExactCanonicalReferenceCrop } from "../reference-graph-crop-proof"
import { eligibleObservedGraphs, type EligibleObservedReferenceGraph } from "./eligibility"
import { sha256Json } from "./numeric-verification"
import type {
  ModelReferenceNumericVerification,
  ModelReferenceVerification,
  ReferenceGraphObservation,
  ReferenceGraphTraceColor,
} from "./types"

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
}): boolean {
  const center_x = Math.round(input.pixel_x)
  const center_y = Math.round(input.pixel_y)
  const search_radius = input.search_radius ?? 4
  for (
    let y = Math.max(0, center_y - search_radius);
    y <= Math.min(input.height - 1, center_y + search_radius);
    y += 1
  ) {
    for (
      let x = Math.max(0, center_x - search_radius);
      x <= Math.min(input.width - 1, center_x + search_radius);
      x += 1
    ) {
      if (colorDistance(input.rgbAt(x, y), input.color) <= input.color.tolerance) return true
    }
  }
  return false
}

interface PixelTraceMeasurement {
  source_image_sha256: string
  verified_point_count: number
  total_point_count: number
  trace_color_coverage: number
  search_radius_px: 4
  segment_support_ratio: number
  minimum_segment_support_ratio: 0.75
  segment_search_radius_px: 2
}

async function measureReferenceGraphTracePixels(input: {
  graph: EligibleObservedReferenceGraph
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
  const off_trace_count = transformed_points.filter(
    ({ pixel_x, pixel_y }) =>
      !pointTouchesTrace({
        ...decoded,
        pixel_x,
        pixel_y,
        color: input.graph.digitized_curve.trace_color,
      }),
  ).length
  if (off_trace_count > Math.max(1, Math.floor(transformed_points.length * 0.05))) {
    throw new Error(
      `Independent pixel-trace proof for ${input.error_subject} does not follow the rendered datasheet waveform`,
    )
  }
  let segment_sample_count = 0
  let supported_segment_sample_count = 0
  for (let point_index = 0; point_index + 1 < transformed_points.length; point_index += 1) {
    const start = transformed_points[point_index]!
    const end = transformed_points[point_index + 1]!
    const sample_count = Math.max(
      1,
      Math.ceil(Math.max(Math.abs(end.pixel_x - start.pixel_x), Math.abs(end.pixel_y - start.pixel_y))),
    )
    for (let sample_index = 0; sample_index <= sample_count; sample_index += 1) {
      const ratio = sample_index / sample_count
      segment_sample_count += 1
      if (
        pointTouchesTrace({
          ...decoded,
          pixel_x: start.pixel_x + (end.pixel_x - start.pixel_x) * ratio,
          pixel_y: start.pixel_y + (end.pixel_y - start.pixel_y) * ratio,
          color: input.graph.digitized_curve.trace_color,
          search_radius: 2,
        })
      ) {
        supported_segment_sample_count += 1
      }
    }
  }
  const segment_support_ratio =
    segment_sample_count === 0 ? 0 : supported_segment_sample_count / segment_sample_count
  if (segment_support_ratio < 0.75) {
    throw new Error(
      `Independent pixel-trace proof for ${input.error_subject} has disconnected point samples instead of a continuous rendered waveform`,
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
    minimum_segment_support_ratio: 0.75,
    segment_search_radius_px: 2,
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
  const eligible = eligibleObservedGraphs(input.observation)
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
    for (const graph of eligible) {
      await measureReferenceGraphTracePixels({
        graph,
        image_path: join(figures_dir, `${graph.graph_id}.png`),
        expected_width: graph.crop.width_px,
        expected_height: graph.crop.height_px,
        error_subject: `independent graph ${graph.graph_id}`,
      })
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
  const graphs = new Map(eligibleObservedGraphs(input.observation).map((graph) => [graph.graph_id, graph]))
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
    const image_path = join(input.evidence_dir, "figures", `${requirement.requirement_id}.png`)
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
