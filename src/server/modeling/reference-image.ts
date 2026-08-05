import { readdir, readFile, realpath, stat } from "node:fs/promises"
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path"
import type { ModelPreviewArtifactIdentity, ModelSelectedPreview } from "@/shared/job-types"
import {
  modelPreviewArtifactIdentitiesEqual,
  parseModelPreviewArtifactIdentity,
} from "@/shared/model-selected-preview"
import { readVerifiedPublicationArtifact, resolveAcceptedModelPublication } from "./model-publication"
import { MAX_STORED_MODEL_PREVIEW_BYTES, parseStoredModelPreviewBytes } from "./ui-projection-storage"

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? listFiles(path) : [path]
    }),
  )
  return nested.flat()
}

interface BenchmarkImageSource {
  page?: number
  figure?: string
  image?: string
}

interface BenchmarkImageRecord {
  sources: BenchmarkImageSource[]
  /** Canonical server-rendered crops use the requirement id as their filename. */
  identifiers: string[]
}

export type BenchmarkReferenceImage =
  | { file_path: string; file_name: string; content_type: string; bytes?: never }
  | { bytes: Uint8Array<ArrayBuffer>; file_name: string; content_type: string; file_path?: never }

export type ModelReferenceImageIdentityErrorCode =
  | "preview_artifact_identity_required"
  | "preview_artifact_identity_mismatch"
  | "preview_artifact_identity_invalid"

export class ModelReferenceImageIdentityError extends Error {
  readonly status: number
  readonly error_code: ModelReferenceImageIdentityErrorCode

  constructor(input: {
    error_code: ModelReferenceImageIdentityErrorCode
    message: string
    status: number
    cause?: unknown
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause })
    this.name = "ModelReferenceImageIdentityError"
    this.error_code = input.error_code
    this.status = input.status
  }
}

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseBenchmark(validation_plan: unknown, benchmark_id: string): BenchmarkImageRecord | undefined {
  if (isRecord(validation_plan) && Array.isArray(validation_plan.cases)) {
    const validation_case = validation_plan.cases.find(
      (value) => isRecord(value) && value.id === benchmark_id,
    )
    if (isRecord(validation_case) && Array.isArray(validation_case.observations)) {
      const identifiers = new Set<string>([benchmark_id])
      if (Array.isArray(validation_case.requirement_ids)) {
        for (const requirement_id of validation_case.requirement_ids) {
          if (typeof requirement_id === "string" && requirement_id.trim()) {
            identifiers.add(requirement_id.trim())
          }
        }
      }
      const sources = validation_case.observations.flatMap((observation) => {
        if (!isRecord(observation)) return []
        if (typeof observation.requirement_id === "string" && observation.requirement_id.trim()) {
          identifiers.add(observation.requirement_id.trim())
        }
        if (!isRecord(observation.evidence)) return []
        const metadata = isRecord(observation.evidence.metadata) ? observation.evidence.metadata : undefined
        return [
          {
            page:
              typeof observation.evidence.page === "number" &&
              Number.isInteger(observation.evidence.page) &&
              observation.evidence.page > 0
                ? observation.evidence.page
                : undefined,
            figure: typeof metadata?.figure === "string" ? metadata.figure : undefined,
            image: typeof observation.evidence.image === "string" ? observation.evidence.image : undefined,
          },
        ]
      })
      return { sources, identifiers: [...identifiers] }
    }
  }
  return undefined
}

async function readBenchmark(
  model_dir: string,
  benchmark_id: string,
): Promise<BenchmarkImageRecord | undefined> {
  const validation_plan: unknown = await readFile(join(model_dir, "validation-plan.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => undefined)
  return parseBenchmark(validation_plan, benchmark_id)
}

function isInsideDirectory(directory: string, file_path: string): boolean {
  const relative_path = relative(directory, file_path)
  return relative_path !== "" && !relative_path.startsWith("..") && !isAbsolute(relative_path)
}

async function resolveExplicitImage(
  model_dir: string,
  evidence_dir: string,
  raw_path: string | undefined,
): Promise<string | undefined> {
  if (!raw_path?.trim()) return undefined
  const evidence_real_path = await realpath(evidence_dir).catch(() => undefined)
  if (!evidence_real_path) return undefined
  const candidates = [resolve(model_dir, raw_path), resolve(evidence_dir, raw_path)]
  for (const candidate_path of candidates) {
    const file_path = await realpath(candidate_path).catch(() => undefined)
    if (
      !file_path ||
      !isInsideDirectory(evidence_real_path, file_path) ||
      !IMAGE_CONTENT_TYPES[extname(file_path).toLowerCase()]
    ) {
      continue
    }
    const file_stat = await stat(file_path).catch(() => undefined)
    if (file_stat?.isFile() && file_stat.size > 0) return file_path
  }
  return undefined
}

function figureKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^figure/, "fig")
    .replace(/[^a-z0-9]/g, "")
}

function chooseBestMatch(files: string[]): string | undefined {
  return files.sort((first, second) => first.length - second.length || first.localeCompare(second))[0]
}

function findFigureImage(files: string[], figure: string | undefined): string | undefined {
  if (!figure?.trim()) return undefined
  const expected_key = figureKey(figure)
  const keyed_files = files.map((file_path) => ({
    file_path,
    key: figureKey(basename(file_path, extname(file_path))),
  }))
  const exact_matches = keyed_files.filter((candidate) => candidate.key === expected_key)
  if (exact_matches.length > 0) return chooseBestMatch(exact_matches.map(({ file_path }) => file_path))
  const suffixed_matches = keyed_files.filter((candidate) => candidate.key.endsWith(expected_key))
  return suffixed_matches.length === 1 ? suffixed_matches[0]?.file_path : undefined
}

function findIdentifierImage(files: string[], identifiers: readonly string[]): string | undefined {
  const expected = new Set(identifiers)
  return chooseBestMatch(files.filter((file_path) => expected.has(basename(file_path, extname(file_path)))))
}

function findPageImage(files: string[], page: number | undefined): string | undefined {
  if (!page) return undefined
  const exact_page_pattern = new RegExp(`^(?:datasheet[-_ ]*)?page[-_ ]*0*${page}$`, "i")
  const exact_matches = files.filter((file_path) =>
    exact_page_pattern.test(basename(file_path, extname(file_path))),
  )
  if (exact_matches.length > 0) return chooseBestMatch(exact_matches)

  const page_pattern = new RegExp(`(?:^|[-_ ])page[-_ ]*0*${page}(?:$|[-_ ])`, "i")
  const page_matches = files.filter((file_path) => page_pattern.test(basename(file_path, extname(file_path))))
  return page_matches.length === 1 ? page_matches[0] : undefined
}

function explicitPublishedImageCandidates(raw_path: string | undefined): string[] {
  const trimmed = raw_path?.trim()
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\\") || trimmed.includes("\0")) return []
  const segments = trimmed.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return []
  return trimmed.startsWith("evidence/") ? [trimmed] : [`evidence/${trimmed}`]
}

function parseReferencePreviewArtifact(input: {
  bytes: Uint8Array
  label: string
  fresh_accepted?: boolean
  expected_artifact_identity?: ModelPreviewArtifactIdentity
}): ModelSelectedPreview {
  try {
    return parseStoredModelPreviewBytes(input.bytes, {
      fresh_accepted: input.fresh_accepted,
      expected_artifact_identity: input.expected_artifact_identity,
    })
  } catch (error) {
    throw new ModelReferenceImageIdentityError({
      error_code: "preview_artifact_identity_invalid",
      message: `${input.label} does not contain a valid immutable selected-preview identity`,
      status: 500,
      cause: error,
    })
  }
}

async function readDirectorySelectedPreview(
  root: string,
  benchmark_id: string,
): Promise<ModelSelectedPreview | undefined> {
  const path = join(root, "cases", `${benchmark_id}.preview.json`)
  let bytes: Uint8Array
  try {
    bytes = await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw new ModelReferenceImageIdentityError({
      error_code: "preview_artifact_identity_invalid",
      message: `Selected preview ${benchmark_id} could not be read while binding its reference image`,
      status: 500,
      cause: error,
    })
  }
  if (bytes.byteLength > MAX_STORED_MODEL_PREVIEW_BYTES) {
    throw new ModelReferenceImageIdentityError({
      error_code: "preview_artifact_identity_invalid",
      message: `Selected preview ${benchmark_id} exceeds its production read limit`,
      status: 500,
    })
  }
  return parseReferencePreviewArtifact({
    bytes,
    label: `Selected preview ${benchmark_id}`,
  })
}

function assertReferenceImageArtifactIdentity(input: {
  selected_preview: ModelSelectedPreview | undefined
  requested_artifact_identity?: ModelPreviewArtifactIdentity
  expected_artifact_identity?: ModelPreviewArtifactIdentity
}): void {
  const stored = input.selected_preview?.artifact_identity
  const requested = input.requested_artifact_identity
  const expected = input.expected_artifact_identity
  if (stored && expected && !modelPreviewArtifactIdentitiesEqual(stored, expected)) {
    throw new ModelReferenceImageIdentityError({
      error_code: "preview_artifact_identity_invalid",
      message: "The selected preview identity does not match its current candidate or accepted publication",
      status: 500,
    })
  }
  if (!stored) {
    if (expected) {
      throw new ModelReferenceImageIdentityError({
        error_code: "preview_artifact_identity_invalid",
        message: "The selected preview is missing its current candidate or accepted publication identity",
        status: 500,
      })
    }
    if (requested) {
      throw new ModelReferenceImageIdentityError({
        error_code: "preview_artifact_identity_mismatch",
        message: "The requested preview identity is not present in this legacy preview artifact",
        status: 409,
      })
    }
    return
  }
  if (!requested) {
    throw new ModelReferenceImageIdentityError({
      error_code: "preview_artifact_identity_required",
      message:
        "This reference image requires preview_generation and model_revision from its selected preview",
      status: 400,
    })
  }
  if (!modelPreviewArtifactIdentitiesEqual(stored, requested)) {
    throw new ModelReferenceImageIdentityError({
      error_code: "preview_artifact_identity_mismatch",
      message: "The requested reference image does not belong to the current selected preview artifact",
      status: 409,
    })
  }
}

export async function resolveDirectoryReferenceImage(
  root: string,
  benchmark_id: string,
): Promise<{ benchmark_found: boolean; image?: BenchmarkReferenceImage }> {
  const benchmark = await readBenchmark(root, benchmark_id)
  if (!benchmark) return { benchmark_found: false }
  const evidence_dir = resolve(root, "evidence")
  for (const raw_path of benchmark.sources.map((source) => source.image)) {
    const file_path = await resolveExplicitImage(root, evidence_dir, raw_path)
    if (!file_path) continue
    const content_type = IMAGE_CONTENT_TYPES[extname(file_path).toLowerCase()]
    if (content_type) {
      return {
        benchmark_found: true,
        image: { file_path, file_name: basename(file_path), content_type },
      }
    }
  }
  const image_files = (await listFiles(evidence_dir)).filter(
    (file_path) => IMAGE_CONTENT_TYPES[extname(file_path).toLowerCase()],
  )
  const file_path =
    findIdentifierImage(image_files, benchmark.identifiers) ??
    benchmark.sources
      .map((source) => findFigureImage(image_files, source.figure))
      .find((match) => match !== undefined) ??
    benchmark.sources
      .map((source) => findPageImage(image_files, source.page))
      .find((match) => match !== undefined)
  if (!file_path) return { benchmark_found: true }
  const content_type = IMAGE_CONTENT_TYPES[extname(file_path).toLowerCase()]
  return {
    benchmark_found: true,
    ...(content_type
      ? { image: { file_path, file_name: basename(file_path), content_type } as BenchmarkReferenceImage }
      : {}),
  }
}

export async function resolveBenchmarkReferenceImage(input: {
  job_id: string
  model_dir: string
  benchmark_id: string
  prefer_current_preview?: boolean
  current_preview_generation?: string
  current_model_revision?: string
  requested_artifact_identity?: ModelPreviewArtifactIdentity
  require_accepted_publication?: boolean
}): Promise<BenchmarkReferenceImage | undefined> {
  if (
    input.require_accepted_publication &&
    (input.prefer_current_preview || input.current_preview_generation)
  ) {
    throw new Error("A committed accepted publication cannot select mutable candidate evidence")
  }
  if (Boolean(input.current_preview_generation) !== Boolean(input.current_model_revision)) {
    throw new Error("current_preview_generation and current_model_revision must be provided together")
  }
  if (input.current_preview_generation) {
    const expected_artifact_identity = parseModelPreviewArtifactIdentity({
      preview_generation: input.current_preview_generation,
      model_revision: input.current_model_revision,
    })
    const root = join(input.model_dir, "current-previews", input.current_preview_generation)
    if (!(await readBenchmark(root, input.benchmark_id))) return undefined
    assertReferenceImageArtifactIdentity({
      selected_preview: await readDirectorySelectedPreview(root, input.benchmark_id),
      requested_artifact_identity: input.requested_artifact_identity,
      expected_artifact_identity,
    })
    const current = await resolveDirectoryReferenceImage(root, input.benchmark_id)
    return current.image
  }
  if (input.prefer_current_preview) {
    const root = join(input.model_dir, "current-preview")
    if (await readBenchmark(root, input.benchmark_id)) {
      const selected_preview = await readDirectorySelectedPreview(root, input.benchmark_id)
      assertReferenceImageArtifactIdentity({
        selected_preview,
        requested_artifact_identity: input.requested_artifact_identity,
      })
      const current = await resolveDirectoryReferenceImage(root, input.benchmark_id)
      // A matching current benchmark owns its evidence state. Falling back to an
      // older accepted image would present unrelated proof for this candidate.
      return current.image
    }
  }
  const publication = await resolveAcceptedModelPublication(input.model_dir, input.job_id)
  if (publication) {
    const plan_bytes = await readVerifiedPublicationArtifact({
      publication,
      bundle: "accepted_model",
      relative_path: "validation-plan.json",
      max_bytes: 8 * 1024 * 1024,
    })
    const benchmark = parseBenchmark(JSON.parse(new TextDecoder().decode(plan_bytes)), input.benchmark_id)
    if (!benchmark) return undefined
    const preview_relative_path = `validation/cases/${input.benchmark_id}.preview.json`
    const preview_manifest_entry = publication.accepted_bundle_manifest.files[preview_relative_path]
    let selected_preview: ModelSelectedPreview | undefined
    const expected_artifact_identity = {
      preview_generation: basename(publication.accepted_model_dir),
      model_revision: publication.commit.revision,
    }
    if (preview_manifest_entry) {
      const preview_bytes = await readVerifiedPublicationArtifact({
        publication,
        bundle: "accepted_model",
        relative_path: preview_relative_path,
        max_bytes: MAX_STORED_MODEL_PREVIEW_BYTES,
      })
      selected_preview = parseReferencePreviewArtifact({
        bytes: preview_bytes,
        label: `Accepted selected preview ${input.benchmark_id}`,
        fresh_accepted: publication.commit.version === 3,
        expected_artifact_identity: publication.commit.version === 3 ? expected_artifact_identity : undefined,
      })
    } else if (publication.commit.version === 3) {
      throw new ModelReferenceImageIdentityError({
        error_code: "preview_artifact_identity_invalid",
        message: `Fresh accepted publication is missing ${preview_relative_path}`,
        status: 500,
      })
    }
    assertReferenceImageArtifactIdentity({
      selected_preview,
      requested_artifact_identity: input.requested_artifact_identity,
      expected_artifact_identity: publication.commit.version === 3 ? expected_artifact_identity : undefined,
    })
    const image_files = Object.keys(publication.accepted_bundle_manifest.files).filter(
      (relative_path) =>
        relative_path.startsWith("evidence/") &&
        Boolean(IMAGE_CONTENT_TYPES[extname(relative_path).toLowerCase()]),
    )
    const explicit_match = benchmark.sources
      .flatMap((source) => explicitPublishedImageCandidates(source.image))
      .find((relative_path) => image_files.includes(relative_path))
    const relative_path =
      explicit_match ??
      findIdentifierImage(image_files, benchmark.identifiers) ??
      benchmark.sources
        .map((source) => findFigureImage(image_files, source.figure))
        .find((match) => match !== undefined) ??
      benchmark.sources
        .map((source) => findPageImage(image_files, source.page))
        .find((match) => match !== undefined)
    if (!relative_path) return undefined
    const content_type = IMAGE_CONTENT_TYPES[extname(relative_path).toLowerCase()]
    if (!content_type) return undefined
    return {
      bytes: await readVerifiedPublicationArtifact({
        publication,
        bundle: "accepted_model",
        relative_path,
        max_bytes: 32 * 1024 * 1024,
      }),
      file_name: basename(relative_path),
      content_type,
    }
  }
  if (input.require_accepted_publication) {
    throw new Error(
      "published-model.json is missing even though the completed spice_generation pipeline crossed the publish commit barrier",
    )
  }
  const root_benchmark = await readBenchmark(input.model_dir, input.benchmark_id)
  if (root_benchmark) {
    assertReferenceImageArtifactIdentity({
      selected_preview: await readDirectorySelectedPreview(input.model_dir, input.benchmark_id),
      requested_artifact_identity: input.requested_artifact_identity,
    })
    return (await resolveDirectoryReferenceImage(input.model_dir, input.benchmark_id)).image
  }
  const current_root = join(input.model_dir, "current-preview")
  if (!(await readBenchmark(current_root, input.benchmark_id))) return undefined
  assertReferenceImageArtifactIdentity({
    selected_preview: await readDirectorySelectedPreview(current_root, input.benchmark_id),
    requested_artifact_identity: input.requested_artifact_identity,
  })
  return (await resolveDirectoryReferenceImage(current_root, input.benchmark_id)).image
}
