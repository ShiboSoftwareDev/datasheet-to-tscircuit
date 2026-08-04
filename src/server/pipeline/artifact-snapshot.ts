import { createHash, randomUUID } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { chmod, link, lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises"
import { extname, join } from "node:path"
import type { PipelineArtifact } from "@/shared/pipeline-types"
import { PipelineError } from "./pipeline-error"

const COPY_BUFFER_BYTES = 64 * 1024

function artifactError(input: {
  code: string
  message: string
  stage_id: string
  artifact: PipelineArtifact
  cause?: unknown
}): PipelineError {
  return new PipelineError(
    {
      code: input.code,
      message: input.message,
      stage_id: input.stage_id,
      operation: "snapshot_stage_artifact",
      artifact_refs: [
        {
          artifact_id: input.artifact.artifact_id,
          path: input.artifact.path,
        },
      ],
      hint: "Regenerate the artifact and declare metadata from the final, closed file.",
      retryable: false,
    },
    input.cause === undefined ? undefined : { cause: input.cause },
  )
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameFileVersion(left: Stats, right: Stats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function safeArtifactLabel(artifact_id: string): string {
  const label = artifact_id.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 48)
  return label || "artifact"
}

function safeArtifactExtension(path: string): string {
  const extension = extname(path)
  return /^\.[a-zA-Z0-9]{1,12}$/.test(extension) ? extension : ""
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  await handle?.close().catch(() => undefined)
}

async function unlinkQuietly(path: string | undefined): Promise<void> {
  if (path !== undefined) await unlink(path).catch(() => undefined)
}

async function copyAndHash(input: {
  source: FileHandle
  destination: FileHandle
}): Promise<{ readonly hash: string; readonly size_bytes: number }> {
  const hash = createHash("sha256")
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
  let read_position = 0

  while (true) {
    const { bytesRead } = await input.source.read(buffer, 0, buffer.byteLength, read_position)
    if (bytesRead === 0) break
    const chunk = buffer.subarray(0, bytesRead)
    hash.update(chunk)

    let written = 0
    while (written < bytesRead) {
      const result = await input.destination.write(buffer, written, bytesRead - written, null)
      if (result.bytesWritten === 0) throw new Error("Snapshot write made no progress")
      written += result.bytesWritten
    }
    read_position += bytesRead
  }

  return {
    hash: hash.digest("hex"),
    size_bytes: read_position,
  }
}

async function snapshotArtifact(input: {
  artifact: PipelineArtifact
  artifact_index: number
  artifact_count: number
  snapshot_dir: string
  stage_id: string
}): Promise<PipelineArtifact> {
  const { artifact, stage_id } = input
  const path_metadata = await lstat(artifact.path).catch((cause) => {
    throw artifactError({
      code: "artifact_source_unreadable",
      message: `Stage ${stage_id} artifact ${artifact.artifact_id} could not be inspected`,
      stage_id,
      artifact,
      cause,
    })
  })
  if (path_metadata.isSymbolicLink()) {
    throw artifactError({
      code: "artifact_source_is_symlink",
      message: `Stage ${stage_id} artifact ${artifact.artifact_id} must not be a symlink`,
      stage_id,
      artifact,
    })
  }
  if (!path_metadata.isFile()) {
    throw artifactError({
      code: "artifact_source_not_regular_file",
      message: `Stage ${stage_id} artifact ${artifact.artifact_id} is not a regular file`,
      stage_id,
      artifact,
    })
  }

  let source: FileHandle | undefined
  let destination: FileHandle | undefined
  let temporary_path: string | undefined
  try {
    source = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((cause) => {
      const path_changed = ["ELOOP", "ENOENT", "ENOTDIR"].includes(errorCode(cause) ?? "")
      throw artifactError({
        code: path_changed ? "artifact_source_changed" : "artifact_source_unreadable",
        message: path_changed
          ? `Stage ${stage_id} artifact ${artifact.artifact_id} changed while it was opened`
          : `Stage ${stage_id} artifact ${artifact.artifact_id} could not be opened safely`,
        stage_id,
        artifact,
        cause,
      })
    })
    const opened_metadata = await source.stat()
    if (!opened_metadata.isFile() || !sameFileIdentity(path_metadata, opened_metadata)) {
      throw artifactError({
        code: "artifact_source_changed",
        message: `Stage ${stage_id} artifact ${artifact.artifact_id} changed while it was opened`,
        stage_id,
        artifact,
      })
    }
    if (opened_metadata.size !== artifact.size_bytes) {
      throw artifactError({
        code: "artifact_size_mismatch",
        message: `Stage ${stage_id} artifact ${artifact.artifact_id} declared ${artifact.size_bytes} bytes but contains ${opened_metadata.size}`,
        stage_id,
        artifact,
      })
    }

    temporary_path = join(input.snapshot_dir, `.${randomUUID()}.partial`)
    destination = await open(
      temporary_path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    const copied = await copyAndHash({ source, destination })
    await destination.sync()

    const [finished_metadata, current_path_metadata] = await Promise.all([
      source.stat(),
      lstat(artifact.path).catch(() => undefined),
    ])
    if (
      !current_path_metadata?.isFile() ||
      current_path_metadata.isSymbolicLink() ||
      !sameFileVersion(opened_metadata, finished_metadata) ||
      !sameFileVersion(opened_metadata, current_path_metadata)
    ) {
      throw artifactError({
        code: "artifact_source_changed",
        message: `Stage ${stage_id} artifact ${artifact.artifact_id} changed while it was being snapshotted`,
        stage_id,
        artifact,
      })
    }
    if (copied.size_bytes !== artifact.size_bytes) {
      throw artifactError({
        code: "artifact_size_mismatch",
        message: `Stage ${stage_id} artifact ${artifact.artifact_id} declared ${artifact.size_bytes} bytes but ${copied.size_bytes} bytes were copied`,
        stage_id,
        artifact,
      })
    }
    if (copied.hash !== artifact.hash.value) {
      throw artifactError({
        code: "artifact_hash_mismatch",
        message: `Stage ${stage_id} artifact ${artifact.artifact_id} does not match its declared SHA-256`,
        stage_id,
        artifact,
      })
    }

    await closeQuietly(destination)
    destination = undefined
    await chmod(temporary_path, 0o400)
    const width = Math.max(2, String(input.artifact_count).length)
    const snapshot_path = join(
      input.snapshot_dir,
      `${String(input.artifact_index + 1).padStart(width, "0")}-${safeArtifactLabel(artifact.artifact_id)}-${artifact.hash.value}-${randomUUID()}${safeArtifactExtension(artifact.path)}`,
    )
    await link(temporary_path, snapshot_path)
    await unlink(temporary_path)
    temporary_path = undefined

    return Object.freeze({
      ...artifact,
      path: snapshot_path,
    })
  } catch (error) {
    if (error instanceof PipelineError) throw error
    throw artifactError({
      code: "artifact_snapshot_failed",
      message: `Stage ${stage_id} artifact ${artifact.artifact_id} could not be snapshotted`,
      stage_id,
      artifact,
      cause: error,
    })
  } finally {
    await Promise.all([closeQuietly(source), closeQuietly(destination), unlinkQuietly(temporary_path)])
  }
}

export async function snapshotPipelineArtifacts(input: {
  artifacts: readonly PipelineArtifact[]
  debug_dir: string
  stage_id: string
}): Promise<readonly PipelineArtifact[]> {
  if (input.artifacts.length === 0) return Object.freeze([])

  const snapshot_dir = join(input.debug_dir, "artifacts")
  await mkdir(snapshot_dir, { recursive: true, mode: 0o700 })
  const snapshot_dir_metadata = await lstat(snapshot_dir).catch(() => undefined)
  if (!snapshot_dir_metadata?.isDirectory() || snapshot_dir_metadata.isSymbolicLink()) {
    throw new PipelineError({
      code: "artifact_snapshot_directory_invalid",
      message: `Stage ${input.stage_id} artifact snapshot directory is not a real directory`,
      stage_id: input.stage_id,
      operation: "snapshot_stage_artifact",
      artifact_refs: [{ path: snapshot_dir }],
      retryable: false,
    })
  }

  const snapshots: PipelineArtifact[] = []
  for (const [artifact_index, artifact] of input.artifacts.entries()) {
    snapshots.push(
      await snapshotArtifact({
        artifact,
        artifact_index,
        artifact_count: input.artifacts.length,
        snapshot_dir,
        stage_id: input.stage_id,
      }),
    )
  }
  return Object.freeze(snapshots)
}
