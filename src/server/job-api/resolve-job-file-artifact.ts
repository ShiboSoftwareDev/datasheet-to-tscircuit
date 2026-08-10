import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  applicationEvidenceFilePath,
  readCommittedApplicationEvidenceSnapshot,
} from "../component-workflow/application-evidence-commit"
import { readCommittedEvidenceSnapshot } from "../component-workflow/evidence-commit"
import { readModelPublication, readVerifiedPublicationArtifact } from "../modeling"

interface JobFileMetadata {
  download_name: string
  content_type: string
}

interface StaticJobFile extends JobFileMetadata {
  relative_path: string
  requires_committed_evidence?: true
  requires_committed_application_evidence?: true
}

type JobFileResolution =
  | { status: "invalid" }
  | { status: "missing"; download_name: string }
  | ({
      status: "ready"
      download_name: string
      content_type: string
      integrity_warning?: { code: "accepted_publication_invalid"; cause: string }
    } & (
      | { artifact_path: string; artifact_bytes?: never }
      | { artifact_bytes: Uint8Array<ArrayBuffer>; artifact_path?: never }
    ))

const static_job_files = {
  component: {
    relative_path: "index.circuit.tsx",
    download_name: "index.circuit.tsx",
    content_type: "text/typescript; charset=utf-8",
  },
  typical_application: {
    relative_path: "typical-application.circuit.tsx",
    download_name: "typical-application.circuit.tsx",
    content_type: "text/typescript; charset=utf-8",
  },
  log: {
    relative_path: "agent.log",
    download_name: "agent.log",
    content_type: "text/plain; charset=utf-8",
  },
  component_evidence: {
    relative_path: "component-evidence.json",
    download_name: "component-evidence.json",
    content_type: "application/json; charset=utf-8",
    requires_committed_evidence: true,
  },
  footprint_plan: {
    relative_path: "footprint-plan.json",
    download_name: "footprint-plan.json",
    content_type: "application/json; charset=utf-8",
    requires_committed_evidence: true,
  },
  application_plan: {
    relative_path: "typical-application-plan.json",
    download_name: "typical-application-plan.json",
    content_type: "application/json; charset=utf-8",
    requires_committed_application_evidence: true,
  },
  land_pattern: {
    relative_path: "visual-reference/land-pattern.png",
    download_name: "land-pattern.png",
    content_type: "image/png",
    requires_committed_evidence: true,
  },
  application_reference: {
    relative_path: "visual-reference/typical-application.png",
    download_name: "typical-application.png",
    content_type: "image/png",
    requires_committed_application_evidence: true,
  },
} as const satisfies Record<string, StaticJobFile>

const component_schematic_reference: JobFileMetadata = {
  download_name: "component-schematic-reference.png",
  content_type: "image/png",
}

const COMPONENT_SOURCE_BYTE_LIMIT = 2 * 1024 * 1024

type SafeJobFileRead =
  | { status: "missing" }
  | { status: "unsafe" }
  | { status: "ready"; bytes: Uint8Array<ArrayBuffer> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  )
}

function isInsideRoot(root: string, candidate: string): boolean {
  const candidate_relative_path = relative(root, candidate)
  return Boolean(
    candidate_relative_path &&
      candidate_relative_path !== ".." &&
      !candidate_relative_path.startsWith(`..${sep}`) &&
      !isAbsolute(candidate_relative_path),
  )
}

async function readSafeJobFile(
  job_dir: string,
  relative_path: string,
  max_bytes: number,
): Promise<SafeJobFileRead> {
  const resolved_job_dir = resolve(job_dir)
  const artifact_path = resolve(resolved_job_dir, relative_path)
  if (!isInsideRoot(resolved_job_dir, artifact_path)) return { status: "unsafe" }

  let path_metadata: Awaited<ReturnType<typeof lstat>>
  try {
    path_metadata = await lstat(artifact_path)
  } catch (error) {
    if (isMissingPathError(error)) return { status: "missing" }
    throw error
  }
  if (
    !path_metadata.isFile() ||
    path_metadata.isSymbolicLink() ||
    path_metadata.nlink !== 1 ||
    path_metadata.size === 0 ||
    path_metadata.size > max_bytes
  ) {
    return { status: "unsafe" }
  }

  const [real_job_dir, real_artifact_path] = await Promise.all([
    realpath(resolved_job_dir),
    realpath(artifact_path),
  ])
  if (!isInsideRoot(real_job_dir, real_artifact_path)) return { status: "unsafe" }

  const handle = await open(artifact_path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened_metadata = await handle.stat()
    const current_path_metadata = await lstat(artifact_path).catch(() => undefined)
    const current_real_path = await realpath(artifact_path).catch(() => undefined)
    if (
      !opened_metadata.isFile() ||
      opened_metadata.nlink !== 1 ||
      opened_metadata.size === 0 ||
      opened_metadata.size > max_bytes ||
      !current_path_metadata?.isFile() ||
      current_path_metadata.isSymbolicLink() ||
      current_path_metadata.dev !== opened_metadata.dev ||
      current_path_metadata.ino !== opened_metadata.ino ||
      !current_real_path ||
      !isInsideRoot(real_job_dir, current_real_path)
    ) {
      return { status: "unsafe" }
    }

    const bytes = new Uint8Array(opened_metadata.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead === 0) return { status: "unsafe" }
      offset += bytesRead
    }
    const trailing_byte = new Uint8Array(1)
    const { bytesRead: trailing_bytes_read } = await handle.read(
      trailing_byte,
      0,
      trailing_byte.byteLength,
      bytes.byteLength,
    )
    if (trailing_bytes_read !== 0) return { status: "unsafe" }
    return { status: "ready", bytes }
  } finally {
    await handle.close()
  }
}

async function readBaseComponentSource(
  job_dir: string,
  options: { allow_legacy_index_fallback: boolean },
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const preserved_component = await readSafeJobFile(
    job_dir,
    "component.circuit.tsx",
    COMPONENT_SOURCE_BYTE_LIMIT,
  )
  if (preserved_component.status === "ready") return preserved_component.bytes

  // An existing-but-unsafe preserved source is not evidence that this is a
  // legacy workspace. In particular, never fall through to a root model
  // wrapper when the canonical base artifact was replaced by a link or an
  // oversized file.
  if (preserved_component.status !== "missing" || !options.allow_legacy_index_fallback) {
    return undefined
  }
  const legacy_component = await readSafeJobFile(job_dir, "index.circuit.tsx", COMPONENT_SOURCE_BYTE_LIMIT)
  return legacy_component.status === "ready" ? legacy_component.bytes : undefined
}

function getPinoutImageCandidates(evidence: unknown): string[] {
  if (!isRecord(evidence) || !isRecord(evidence.pinout) || !Array.isArray(evidence.pinout.pins)) return []

  const image_counts = new Map<string, number>()
  for (const pin of evidence.pinout.pins) {
    if (!isRecord(pin) || !Array.isArray(pin.sources)) continue
    for (const source of pin.sources) {
      if (!isRecord(source) || typeof source.image !== "string") continue
      if (!source.image.startsWith("visual-reference/") || !source.image.toLowerCase().endsWith(".png")) {
        continue
      }
      image_counts.set(source.image, (image_counts.get(source.image) ?? 0) + 1)
    }
  }

  return [...image_counts]
    .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
    .map(([image_path]) => image_path)
}

function isVisualReferencePath(image_path: string): boolean {
  const visual_reference_dir = resolve("/evidence", "visual-reference")
  const artifact_path = resolve("/evidence", image_path)
  const artifact_relative_path = relative(visual_reference_dir, artifact_path)
  if (
    artifact_relative_path === "" ||
    artifact_relative_path === ".." ||
    artifact_relative_path.startsWith(`..${sep}`) ||
    isAbsolute(artifact_relative_path)
  ) {
    return false
  }
  return true
}

function findComponentSchematicReference(
  files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
): Uint8Array<ArrayBuffer> | undefined {
  const component_evidence = files.get("component-evidence.json")
  if (!component_evidence) return undefined
  let evidence: unknown
  try {
    evidence = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(component_evidence)) as unknown
  } catch {
    return undefined
  }
  for (const image_path of getPinoutImageCandidates(evidence)) {
    const artifact = isVisualReferencePath(image_path) ? files.get(image_path) : undefined
    if (artifact && artifact.byteLength > 0) return artifact
  }
  return undefined
}

async function resolveSafeRegularFile(job_dir: string, artifact_path: string): Promise<string | undefined> {
  const metadata = await lstat(artifact_path).catch(() => undefined)
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size === 0) return undefined
  const [job_real_path, artifact_real_path] = await Promise.all([
    realpath(job_dir).catch(() => undefined),
    realpath(artifact_path).catch(() => undefined),
  ])
  if (!job_real_path || !artifact_real_path) return undefined
  const artifact_relative_path = relative(job_real_path, artifact_real_path)
  if (
    artifact_relative_path === "" ||
    artifact_relative_path === ".." ||
    artifact_relative_path.startsWith(`..${sep}`) ||
    isAbsolute(artifact_relative_path)
  ) {
    return undefined
  }
  return artifact_real_path
}

export async function resolveJobFileArtifact(
  job_dir: string,
  job_id: string,
  file_kind: string | null,
): Promise<JobFileResolution> {
  let descriptor: JobFileMetadata
  let artifact_path: string | undefined

  if (file_kind === "component_schematic_reference") {
    descriptor = component_schematic_reference
    const committed_evidence = await readCommittedEvidenceSnapshot(job_dir)
    const artifact_bytes = committed_evidence
      ? findComponentSchematicReference(committed_evidence.files)
      : undefined
    if (!artifact_bytes) return { status: "missing", download_name: descriptor.download_name }
    return {
      status: "ready",
      artifact_bytes,
      download_name: descriptor.download_name,
      content_type: descriptor.content_type,
    }
  } else if (file_kind && file_kind in static_job_files) {
    const static_file = static_job_files[file_kind as keyof typeof static_job_files]
    descriptor = static_file
    if (file_kind === "component") {
      let publication: Awaited<ReturnType<typeof readModelPublication>>
      let publication_integrity_error: string | undefined
      try {
        publication = await readModelPublication(job_dir, job_id)
      } catch (error) {
        publication_integrity_error = error instanceof Error ? error.message : String(error)
      }
      if (publication) {
        try {
          const artifact_bytes = await readVerifiedPublicationArtifact({
            publication,
            bundle: "published_component",
            relative_path: static_file.relative_path,
            max_bytes: COMPONENT_SOURCE_BYTE_LIMIT,
          })
          return {
            status: "ready",
            artifact_bytes,
            download_name: descriptor.download_name,
            content_type: descriptor.content_type,
          }
        } catch (error) {
          publication_integrity_error = error instanceof Error ? error.message : String(error)
        }
      }
      const artifact_bytes = await readBaseComponentSource(job_dir, {
        // A root index is a compatibility file, not a commit point. Once any
        // publication fails verification it may be an unverified model mirror.
        allow_legacy_index_fallback: !publication && !publication_integrity_error,
      })
      if (!artifact_bytes) return { status: "missing", download_name: descriptor.download_name }
      return {
        status: "ready",
        artifact_bytes,
        download_name: descriptor.download_name,
        content_type: descriptor.content_type,
        ...(publication_integrity_error
          ? {
              integrity_warning: {
                code: "accepted_publication_invalid" as const,
                cause: publication_integrity_error,
              },
            }
          : {}),
      }
    }
    if (
      "requires_committed_application_evidence" in static_file &&
      static_file.requires_committed_application_evidence
    ) {
      const committed_application_evidence = await readCommittedApplicationEvidenceSnapshot(job_dir)
      const committed_legacy_evidence = committed_application_evidence
        ? undefined
        : await readCommittedEvidenceSnapshot(job_dir)
      const artifact_bytes =
        committed_application_evidence?.files.get(applicationEvidenceFilePath(static_file.relative_path)) ??
        committed_legacy_evidence?.files.get(static_file.relative_path)
      if (!artifact_bytes) return { status: "missing", download_name: descriptor.download_name }
      return {
        status: "ready",
        artifact_bytes,
        download_name: descriptor.download_name,
        content_type: descriptor.content_type,
      }
    }
    if ("requires_committed_evidence" in static_file && static_file.requires_committed_evidence) {
      const committed_evidence = await readCommittedEvidenceSnapshot(job_dir)
      const artifact_bytes = committed_evidence?.files.get(static_file.relative_path)
      if (!artifact_bytes) return { status: "missing", download_name: descriptor.download_name }
      return {
        status: "ready",
        artifact_bytes,
        download_name: descriptor.download_name,
        content_type: descriptor.content_type,
      }
    }
    artifact_path = join(job_dir, static_file.relative_path)
  } else {
    return { status: "invalid" }
  }

  const safe_artifact_path = artifact_path ? await resolveSafeRegularFile(job_dir, artifact_path) : undefined
  if (!safe_artifact_path) {
    return { status: "missing", download_name: descriptor.download_name }
  }

  return {
    status: "ready",
    artifact_path: safe_artifact_path,
    download_name: descriptor.download_name,
    content_type: descriptor.content_type,
  }
}
