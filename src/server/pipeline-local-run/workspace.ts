import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { type FileHandle, mkdir, open, unlink, writeFile } from "node:fs/promises"
import { join, sep } from "node:path"
import type { PipelineJsonValue } from "@/shared/pipeline-types"
import type { PipelineTaskInputBundle } from "../pipeline/task-input-files"

function isRecord(value: PipelineJsonValue): value is Readonly<Record<string, PipelineJsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const COPY_BUFFER_BYTES = 64 * 1024
const RETAINED_OBJECT_HASH_PATTERN = /^[a-f0-9]{64}$/

declare const retainedObjectHashBrand: unique symbol
type RetainedObjectHash = string & { readonly [retainedObjectHashBrand]: true }

function retainedObjectHash(value: string): RetainedObjectHash {
  if (!RETAINED_OBJECT_HASH_PATTERN.test(value)) {
    throw new Error(`Retained input object hash is invalid: ${value}`)
  }
  return value as RetainedObjectHash
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  await handle?.close().catch(() => undefined)
}

async function copyRetainedObject(input: {
  sourcePath: string
  destinationPath: string
  expectedHash: string
  expectedSize: number
}): Promise<void> {
  let source: FileHandle | undefined
  let destination: FileHandle | undefined
  let destinationCreated = false
  let verified = false
  try {
    source = await open(input.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const sourceMetadata = await source.stat()
    if (!sourceMetadata.isFile()) throw new Error("Retained input object is not a regular file")

    destination = await open(
      input.destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o400,
    )
    destinationCreated = true
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
    let position = 0
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      let written = 0
      while (written < bytesRead) {
        const { bytesWritten } = await destination.write(buffer, written, bytesRead - written, null)
        if (bytesWritten === 0) throw new Error("Retained input object copy made no progress")
        written += bytesWritten
      }
      position += bytesRead
    }
    await destination.sync()
    const digest = hash.digest("hex")
    if (position !== input.expectedSize || digest !== input.expectedHash) {
      throw new Error(`Retained input object ${input.expectedHash} changed while it was copied`)
    }
    verified = true
  } finally {
    // Bun on macOS can stall when handles are closed concurrently. Keep the
    // close order deterministic, matching retained task input snapshots.
    await closeQuietly(destination)
    await closeQuietly(source)
    if (destinationCreated && !verified) await unlink(input.destinationPath).catch(() => undefined)
  }
}

export function rewriteWorkspacePaths({
  value,
  sourceJobDir,
  localJobDir,
}: {
  value: PipelineJsonValue
  sourceJobDir: string
  localJobDir: string
}): PipelineJsonValue {
  if (typeof value === "string") {
    if (value === sourceJobDir) return localJobDir
    if (value.startsWith(`${sourceJobDir}${sep}`)) {
      return join(localJobDir, value.slice(sourceJobDir.length + 1))
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteWorkspacePaths({ value: entry, sourceJobDir, localJobDir }))
  }
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      rewriteWorkspacePaths({ value: entry, sourceJobDir, localJobDir }),
    ]),
  )
}

/** Copies the self-contained retained input without materializing a job workspace. */
export async function retainLocalInputBundle(input: {
  bundle: PipelineTaskInputBundle
  executionDir: string
  envelope?: PipelineTaskInputBundle["envelope"]
}): Promise<string> {
  const retainedInputDir = join(input.executionDir, "input", "stages", input.bundle.envelope.task_id)
  const retainedObjectsDir = join(input.executionDir, "input", "input-objects")
  const retainedInputPath = join(retainedInputDir, "input.json")
  await mkdir(retainedInputDir, { recursive: true })
  await mkdir(retainedObjectsDir, { recursive: true })
  const objects = new Map<RetainedObjectHash, number>()
  for (const { hash, size_bytes } of input.bundle.manifest.files) {
    const objectHash = retainedObjectHash(hash)
    const previousSize = objects.get(objectHash)
    if (previousSize !== undefined && previousSize !== size_bytes) {
      throw new Error(`Retained input object ${hash} has conflicting sizes`)
    }
    objects.set(objectHash, size_bytes)
  }
  for (const [hash, size] of objects) {
    await copyRetainedObject({
      sourcePath: join(input.bundle.objects_dir, hash),
      destinationPath: join(retainedObjectsDir, hash),
      expectedHash: hash,
      expectedSize: size,
    })
  }
  await writeFile(
    join(retainedInputDir, "input-files.json"),
    `${JSON.stringify(input.bundle.manifest, null, 2)}\n`,
    "utf8",
  )
  await writeFile(
    retainedInputPath,
    `${JSON.stringify(input.envelope ?? input.bundle.envelope, null, 2)}\n`,
    "utf8",
  )
  return retainedInputPath
}

export interface LocalWorkspace {
  readonly localRunId: string
  readonly executionDir: string
  readonly jobsRoot: string
  readonly jobDir: string
  readonly inputPath: string
  readonly context: Readonly<Record<string, PipelineJsonValue>>
  readonly dependencyOutputs: Readonly<Record<string, PipelineJsonValue>>
}
