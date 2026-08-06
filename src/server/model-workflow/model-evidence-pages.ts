import { lstat, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { inflateSync } from "node:zlib"
import {
  createStageWorkspace,
  promoteStageDirectory,
  promoteStageFile,
  validatePngArtifact,
  validateStageDirectory,
} from "../infrastructure/artifacts"
import type { ProcessRunner } from "../infrastructure/process"
import {
  MODEL_REFERENCE_CROP_DPI,
  MODEL_REFERENCE_CROP_MIN_HEIGHT,
  MODEL_REFERENCE_CROP_MIN_WIDTH,
  type ModelCharacterization,
  type ModelReferenceCropRegion,
  type ModelRequirement,
} from "../modeling/types"

const MAX_MODEL_EVIDENCE_PAGES = 16
const MAX_RENDERED_EVIDENCE_BYTES = 64 * 1024 * 1024

interface PngDimensions {
  width: number
  height: number
}

export interface DecodedModelEvidencePng extends PngDimensions {
  rgbAt(x: number, y: number): [number, number, number]
}

async function readPngDimensions(path: string): Promise<PngDimensions> {
  const bytes = await readFile(path)
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (
    bytes.byteLength < 24 ||
    signature.some((expected, index) => bytes[index] !== expected) ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error(`Rendered model evidence is missing a valid PNG header: ${path}`)
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function paethPredictor(left: number, above: number, upper_left: number): number {
  const estimate = left + above - upper_left
  const left_distance = Math.abs(estimate - left)
  const above_distance = Math.abs(estimate - above)
  const upper_left_distance = Math.abs(estimate - upper_left)
  if (left_distance <= above_distance && left_distance <= upper_left_distance) return left
  return above_distance <= upper_left_distance ? above : upper_left
}

export async function decodeModelEvidencePng(
  path: string,
  requirement_id: string,
): Promise<DecodedModelEvidencePng> {
  const bytes = await readFile(path)
  let offset = 8
  let width = 0
  let height = 0
  let bit_depth = 0
  let color_type = -1
  let interlace = -1
  const idat_chunks: Buffer[] = []
  while (offset + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString("ascii", offset + 4, offset + 8)
    const data_start = offset + 8
    const data_end = data_start + length
    if (data_end + 4 > bytes.byteLength)
      throw new Error(`Reference crop ${requirement_id} has invalid PNG chunks`)
    if (type === "IHDR") {
      width = bytes.readUInt32BE(data_start)
      height = bytes.readUInt32BE(data_start + 4)
      bit_depth = bytes[data_start + 8] ?? 0
      color_type = bytes[data_start + 9] ?? -1
      interlace = bytes[data_start + 12] ?? -1
    } else if (type === "IDAT") {
      idat_chunks.push(bytes.subarray(data_start, data_end))
    }
    offset = data_end + 4
    if (type === "IEND") break
  }
  if (width < MODEL_REFERENCE_CROP_MIN_WIDTH || height < MODEL_REFERENCE_CROP_MIN_HEIGHT) {
    throw new Error(
      `Reference crop for requirement ${requirement_id} is ${width}x${height}; an exact graph crop must be at least ${MODEL_REFERENCE_CROP_MIN_WIDTH}x${MODEL_REFERENCE_CROP_MIN_HEIGHT} pixels at ${MODEL_REFERENCE_CROP_DPI} DPI`,
    )
  }
  const channels =
    color_type === 0 ? 1 : color_type === 2 ? 3 : color_type === 4 ? 2 : color_type === 6 ? 4 : 0
  if (bit_depth !== 8 || channels === 0 || interlace !== 0 || idat_chunks.length === 0) {
    throw new Error(
      `Reference crop for requirement ${requirement_id} uses an unsupported PNG encoding; expected non-interlaced 8-bit grayscale/RGB pixels`,
    )
  }
  const row_bytes = width * channels
  const inflated = inflateSync(Buffer.concat(idat_chunks))
  if (inflated.byteLength !== height * (row_bytes + 1)) {
    throw new Error(`Reference crop for requirement ${requirement_id} has an invalid decoded PNG size`)
  }
  const pixels = Buffer.alloc(width * height * channels)
  for (let row = 0; row < height; row += 1) {
    const encoded_offset = row * (row_bytes + 1)
    const filter = inflated[encoded_offset]
    if (filter === undefined || filter > 4) {
      throw new Error(`Reference crop for requirement ${requirement_id} uses an invalid PNG row filter`)
    }
    const row_offset = row * row_bytes
    for (let column = 0; column < row_bytes; column += 1) {
      const encoded = inflated[encoded_offset + 1 + column] ?? 0
      const left = column >= channels ? (pixels[row_offset + column - channels] ?? 0) : 0
      const above = row > 0 ? (pixels[row_offset - row_bytes + column] ?? 0) : 0
      const upper_left =
        row > 0 && column >= channels ? (pixels[row_offset - row_bytes + column - channels] ?? 0) : 0
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paethPredictor(left, above, upper_left)
      pixels[row_offset + column] = (encoded + predictor) & 0xff
    }
  }
  const rgbAt = (x: number, y: number): [number, number, number] => {
    const pixel_offset = (y * width + x) * channels
    const first = pixels[pixel_offset] ?? 0
    const raw: [number, number, number] =
      color_type === 0 || color_type === 4
        ? [first, first, first]
        : [first, pixels[pixel_offset + 1] ?? first, pixels[pixel_offset + 2] ?? first]
    const alpha =
      color_type === 4
        ? (pixels[pixel_offset + 1] ?? 255)
        : color_type === 6
          ? (pixels[pixel_offset + 3] ?? 255)
          : 255
    return raw.map((value) => Math.round((value * alpha + 255 * (255 - alpha)) / 255)) as [
      number,
      number,
      number,
    ]
  }
  return { width, height, rgbAt }
}

export async function assertPngContainsVisibleContent(path: string, requirement_id: string): Promise<void> {
  const { width, height, rgbAt } = await decodeModelEvidencePng(path, requirement_id)
  const corners = [rgbAt(0, 0), rgbAt(width - 1, 0), rgbAt(0, height - 1), rgbAt(width - 1, height - 1)]
  const background = ([0, 1, 2] as const).map((channel) => {
    const values = corners.map((color) => color[channel]).sort((left, right) => left - right)
    return Math.round(((values[1] ?? 0) + (values[2] ?? 0)) / 2)
  })
  let contrasting_pixels = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = rgbAt(x, y)
      if (color.some((value, channel) => Math.abs(value - (background[channel] ?? 0)) >= 18)) {
        contrasting_pixels += 1
      }
    }
  }
  const minimum_contrast = Math.max(128, Math.ceil(width * height * 0.001))
  if (contrasting_pixels < minimum_contrast) {
    throw new Error(
      `Reference crop for requirement ${requirement_id} is blank or near-uniform (${contrasting_pixels} contrasting pixels; ${minimum_contrast} required); crop the printed axes and trace`,
    )
  }
}

function assertCropShape(requirement: ModelRequirement, crop: ModelReferenceCropRegion): void {
  if (crop.render_dpi !== MODEL_REFERENCE_CROP_DPI) {
    throw new Error(
      `Reference crop for requirement ${requirement.requirement_id} must use ${MODEL_REFERENCE_CROP_DPI} DPI`,
    )
  }
  for (const [field, value, minimum] of [
    ["page", crop.page, 1],
    ["x_px", crop.x_px, 0],
    ["y_px", crop.y_px, 0],
    ["width_px", crop.width_px, 1],
    ["height_px", crop.height_px, 1],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(
        `Reference crop for requirement ${requirement.requirement_id} has invalid ${field}; expected a safe integer greater than or equal to ${minimum}`,
      )
    }
  }
  if (requirement.sources[0]?.page !== crop.page) {
    throw new Error(
      `Reference crop for requirement ${requirement.requirement_id} uses PDF page ${crop.page}, but the primary cited page is ${requirement.sources[0]?.page ?? "missing"}`,
    )
  }
}

function assertCropFitsPage(input: {
  requirement_id: string
  crop: ModelReferenceCropRegion
  page: PngDimensions
}): void {
  const { crop, page, requirement_id } = input
  if (
    crop.x_px > page.width ||
    crop.y_px > page.height ||
    crop.width_px > page.width - crop.x_px ||
    crop.height_px > page.height - crop.y_px
  ) {
    throw new Error(
      `Reference crop for requirement ${requirement_id} is out of bounds on PDF page ${crop.page}: ` +
        `requested (${crop.x_px}, ${crop.y_px}) ${crop.width_px}x${crop.height_px} within ` +
        `${page.width}x${page.height} pixels at ${MODEL_REFERENCE_CROP_DPI} DPI`,
    )
  }
  if (crop.x_px === 0 && crop.y_px === 0 && crop.width_px === page.width && crop.height_px === page.height) {
    throw new Error(
      `Reference crop for requirement ${requirement_id} is the full PDF page; identify the exact graph rectangle instead`,
    )
  }
}

/**
 * Renders cited datasheet pages with a server-owned tool and binds every
 * modeled requirement to those trusted pixels. Exact graph rectangles are then
 * cropped from the same canonical PDF rendering and become the curve reference.
 */
export async function materializeModelEvidencePages(input: {
  workspace: string
  datasheet_path: string
  characterization: ModelCharacterization
  process_runner: ProcessRunner
  signal: AbortSignal
  on_output?: (stream: "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<ModelCharacterization> {
  const modeled_requirements = input.characterization.requirements.filter(
    ({ support }) => support.status === "modeled",
  )
  const pages = [
    ...new Set(modeled_requirements.flatMap((requirement) => requirement.sources.map(({ page }) => page))),
  ].sort((left, right) => left - right)
  if (pages.length === 0) throw new Error("Modeled requirements do not cite a datasheet page")
  if (pages.length > MAX_MODEL_EVIDENCE_PAGES) {
    throw new Error(
      `Modeled requirements cite ${pages.length} pages; the retained-reference limit is ${MAX_MODEL_EVIDENCE_PAGES}`,
    )
  }
  const cropped_requirements = modeled_requirements.flatMap((requirement) => {
    const crop = requirement.reference_curve?.crop
    if (!crop) return []
    assertCropShape(requirement, crop)
    return [{ requirement, crop }]
  })
  const evidence_dir = join(input.workspace, "evidence")
  const evidence_metadata = await lstat(evidence_dir).catch(() => undefined)
  if (evidence_metadata && (!evidence_metadata.isDirectory() || evidence_metadata.isSymbolicLink())) {
    throw new Error("Model evidence output must be a real directory, not a symlink")
  }
  const figures_dir = join(evidence_dir, "figures")
  const figures_metadata = await lstat(figures_dir).catch(() => undefined)
  if (
    cropped_requirements.length > 0 &&
    figures_metadata &&
    (!figures_metadata.isDirectory() || figures_metadata.isSymbolicLink())
  ) {
    throw new Error("Model evidence figures output must be a real directory, not a symlink")
  }
  await mkdir(evidence_dir, { recursive: true })
  const render_workspace = await createStageWorkspace({
    prefix: "model-evidence-render",
    files: [{ source: input.datasheet_path, destination: "datasheet.pdf" }],
  })
  try {
    const rendered_evidence_dir = join(render_workspace.path, "evidence")
    await mkdir(rendered_evidence_dir, { recursive: true })
    for (const page of pages) {
      input.signal.throwIfAborted()
      const output_prefix = join(rendered_evidence_dir, `source-page-${page}`)
      try {
        await input.process_runner.run({
          command: [
            "pdftoppm",
            "-f",
            String(page),
            "-l",
            String(page),
            "-r",
            String(MODEL_REFERENCE_CROP_DPI),
            "-png",
            "-singlefile",
            join(render_workspace.path, "datasheet.pdf"),
            output_prefix,
          ],
          command_label: `Render model evidence page ${page}`,
          cwd: render_workspace.path,
          signal: input.signal,
          wall_timeout_ms: 120_000,
          max_output_chars: 20_000,
          on_output: input.on_output,
        })
      } catch (error) {
        input.signal.throwIfAborted()
        throw new Error(
          `Modeled requirement cites PDF page ${page}, but the server could not render that page`,
          { cause: error },
        )
      }
    }
    await validateStageDirectory({
      root: rendered_evidence_dir,
      max_files: pages.length,
      max_total_bytes: MAX_RENDERED_EVIDENCE_BYTES,
      validate_file: validatePngArtifact,
    })
    const page_dimensions = new Map<number, PngDimensions>()
    for (const page of pages) {
      page_dimensions.set(
        page,
        await readPngDimensions(join(rendered_evidence_dir, `source-page-${page}.png`)),
      )
    }

    if (cropped_requirements.length > 0) {
      await mkdir(join(rendered_evidence_dir, "figures"), { recursive: true })
    }
    for (const { requirement, crop } of cropped_requirements) {
      input.signal.throwIfAborted()
      const dimensions = page_dimensions.get(crop.page)
      if (!dimensions) {
        throw new Error(
          `Reference crop for requirement ${requirement.requirement_id} cites PDF page ${crop.page}, but no canonical page rendering exists`,
        )
      }
      assertCropFitsPage({ requirement_id: requirement.requirement_id, crop, page: dimensions })
      const output_prefix = join(rendered_evidence_dir, "figures", requirement.requirement_id)
      try {
        await input.process_runner.run({
          command: [
            "pdftoppm",
            "-f",
            String(crop.page),
            "-l",
            String(crop.page),
            "-r",
            String(MODEL_REFERENCE_CROP_DPI),
            "-x",
            String(crop.x_px),
            "-y",
            String(crop.y_px),
            "-W",
            String(crop.width_px),
            "-H",
            String(crop.height_px),
            "-png",
            "-singlefile",
            join(render_workspace.path, "datasheet.pdf"),
            output_prefix,
          ],
          command_label: `Render model reference graph ${requirement.requirement_id}`,
          cwd: render_workspace.path,
          signal: input.signal,
          wall_timeout_ms: 120_000,
          max_output_chars: 20_000,
          on_output: input.on_output,
        })
      } catch (error) {
        input.signal.throwIfAborted()
        throw new Error(
          `The server could not render the reference crop for requirement ${requirement.requirement_id} from PDF page ${crop.page}`,
          { cause: error },
        )
      }
    }
    await validateStageDirectory({
      root: rendered_evidence_dir,
      max_files: pages.length + cropped_requirements.length,
      max_total_bytes: MAX_RENDERED_EVIDENCE_BYTES,
      validate_file: validatePngArtifact,
    })
    for (const { requirement, crop } of cropped_requirements) {
      const crop_path = join(rendered_evidence_dir, "figures", `${requirement.requirement_id}.png`)
      const actual = await readPngDimensions(crop_path)
      if (actual.width !== crop.width_px || actual.height !== crop.height_px) {
        throw new Error(
          `Reference crop for requirement ${requirement.requirement_id} rendered as ${actual.width}x${actual.height} pixels; expected exactly ${crop.width_px}x${crop.height_px}`,
        )
      }
      // This is deliberately a pixel-presence check only. The independent
      // source observer and rectangle-overlap receipt establish graph identity.
      await assertPngContainsVisibleContent(crop_path, requirement.requirement_id)
    }
    await Promise.all(
      pages.map((page) =>
        promoteStageFile({
          workspace: render_workspace.path,
          source: join("evidence", `source-page-${page}.png`),
          destination_root: input.workspace,
          destination: join("evidence", `source-page-${page}.png`),
          max_bytes: 32 * 1024 * 1024,
          signal: input.signal,
        }),
      ),
    )
    if (cropped_requirements.length > 0) {
      await promoteStageDirectory({
        workspace: render_workspace.path,
        source: join("evidence", "figures"),
        destination_root: input.workspace,
        destination: join("evidence", "figures"),
        max_files: cropped_requirements.length,
        max_total_bytes: MAX_RENDERED_EVIDENCE_BYTES,
        validate_file: validatePngArtifact,
        signal: input.signal,
      })
    }
  } finally {
    await render_workspace.dispose().catch(() => undefined)
  }

  return {
    ...input.characterization,
    requirements: input.characterization.requirements.map((requirement) => {
      const cloned_reference_curve = requirement.reference_curve
        ? {
            ...requirement.reference_curve,
            points: requirement.reference_curve.points.map((point) => ({ ...point })),
            ...(requirement.reference_curve.crop ? { crop: { ...requirement.reference_curve.crop } } : {}),
          }
        : undefined
      if (requirement.support.status !== "modeled") {
        return {
          ...requirement,
          support: { ...requirement.support },
          conditions: { ...requirement.conditions },
          expected: { ...requirement.expected },
          ...(cloned_reference_curve ? { reference_curve: cloned_reference_curve } : {}),
          sources: requirement.sources.map((source) => ({ ...source })),
        }
      }
      const primary_page = requirement.sources[0]!.page
      const canonical_image = cloned_reference_curve?.crop
        ? `evidence/figures/${requirement.requirement_id}.png`
        : `evidence/source-page-${primary_page}.png`
      return {
        ...requirement,
        support: { ...requirement.support },
        conditions: { ...requirement.conditions },
        expected: { ...requirement.expected },
        ...(cloned_reference_curve
          ? { reference_curve: { ...cloned_reference_curve, image: canonical_image } }
          : {}),
        sources: requirement.sources.map((source) => ({
          ...source,
          image: `evidence/source-page-${source.page}.png`,
        })),
      }
    }),
    assumptions: [...input.characterization.assumptions],
    limitations: [...input.characterization.limitations],
  }
}
