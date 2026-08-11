import { createHash, randomUUID } from "node:crypto"
import { constants, createReadStream, type Stats } from "node:fs"
import {
  chmod,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"
import type { PipelineTaskInputEnvelope, PipelineTaskInputFiles } from "@/shared/pipeline-types"
import { PipelineError } from "./pipeline-error"
import { loadPipelineTaskInput } from "./task-input"

const MANIFEST_VERSION = 1
const MANIFEST_KIND = "pipeline_task_file_manifest"
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024
const MAX_FILES = 100_000
const MAX_DIRECTORIES = 100_000
const COPY_BUFFER_BYTES = 64 * 1024
const MAX_STABLE_FILE_SNAPSHOT_ATTEMPTS = 4
const EXCLUDED_FILE_NAMES = new Set([
  "agent.log",
  "agent.log.1",
  "agent-events.jsonl",
  "model-agent.log",
  "model-agent.log.1",
])

export interface PipelineTaskFileEntry {
  readonly path: string
  readonly hash: string
  readonly size_bytes: number
  readonly mode: number
}

export interface PipelineTaskFileManifest {
  readonly version: 1
  readonly kind: "pipeline_task_file_manifest"
  readonly directories: readonly string[]
  readonly files: readonly PipelineTaskFileEntry[]
}

export interface PipelineTaskInputBundle {
  readonly input_path: string
  readonly input_dir: string
  readonly bundle_root: string
  readonly objects_dir: string
  /** Original job directory when the retained bundle is still inside that job tree. */
  readonly retained_job_dir?: string
  readonly envelope: PipelineTaskInputEnvelope
  readonly manifest: PipelineTaskFileManifest
}

function findRetainedJobDir(input_dir: string, envelope: PipelineTaskInputEnvelope): string | undefined {
  const job_id = envelope.execution_context.job_id
  if (typeof job_id !== "string" || basename(job_id) !== job_id) return undefined
  let cursor = input_dir
  while (true) {
    if (basename(cursor) === job_id) return cursor
    const parent = dirname(cursor)
    if (parent === cursor) return undefined
    cursor = parent
  }
}

function pipelineError(input: {
  code: string
  message: string
  path?: string
  cause?: unknown
}): PipelineError {
  return new PipelineError(
    {
      code: input.code,
      message: input.message,
      stage_id: null,
      operation: "retain_task_input_files",
      ...(input.path ? { artifact_refs: [{ path: input.path }] } : {}),
      retryable: false,
    },
    input.cause === undefined ? undefined : { cause: input.cause },
  )
}

function safeRelativePath(path: string): boolean {
  if (!path || isAbsolute(path)) return false
  const parts = path.split(/[\\/]/)
  return parts.every((part) => Boolean(part) && part !== "." && part !== "..")
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  await handle?.close().catch(() => undefined)
}

async function unlinkQuietly(path: string | undefined): Promise<void> {
  if (path) await unlink(path).catch(() => undefined)
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

async function snapshotFileAttempt(input: {
  source_path: string
  relative_path: string
  objects_dir: string
}): Promise<PipelineTaskFileEntry> {
  const before = await lstat(input.source_path)
  if (before.isSymbolicLink() || !before.isFile()) {
    throw pipelineError({
      code: "task_input_file_invalid",
      message: `Task input contains a non-regular file: ${input.relative_path}`,
      path: input.source_path,
    })
  }

  let source: FileHandle | undefined
  let destination: FileHandle | undefined
  let temporary_path: string | undefined
  try {
    source = await open(input.source_path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await source.stat()
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) {
      throw pipelineError({
        code: "task_input_file_changed",
        message: `Task input changed while it was opened: ${input.relative_path}`,
        path: input.source_path,
      })
    }

    temporary_path = join(input.objects_dir, `.${randomUUID()}.partial`)
    destination = await open(
      temporary_path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
    let position = 0
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position)
      if (bytesRead === 0) break
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      let written = 0
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, null)
        if (result.bytesWritten === 0) throw new Error("Task input snapshot write made no progress")
        written += result.bytesWritten
      }
      position += bytesRead
    }
    await destination.sync()
    const [finished, current] = await Promise.all([source.stat(), lstat(input.source_path)])
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      !sameFile(opened, finished) ||
      !sameFile(opened, current)
    ) {
      throw pipelineError({
        code: "task_input_file_changed",
        message: `Task input changed while it was retained: ${input.relative_path}`,
        path: input.source_path,
      })
    }
    const digest = hash.digest("hex")
    const object_path = join(input.objects_dir, digest)
    await closeQuietly(destination)
    destination = undefined
    await chmod(temporary_path, 0o400)
    try {
      await link(temporary_path, object_path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const existing = await lstat(object_path).catch(() => undefined)
      if (
        !existing?.isFile() ||
        existing.isSymbolicLink() ||
        existing.size !== position ||
        (await hashFile(object_path)) !== digest
      ) {
        throw error
      }
    }
    await unlink(temporary_path)
    temporary_path = undefined
    return {
      path: input.relative_path,
      hash: digest,
      size_bytes: position,
      mode: opened.mode & 0o777,
    }
  } catch (error) {
    if (error instanceof PipelineError) throw error
    throw pipelineError({
      code: "task_input_file_snapshot_failed",
      message: `Could not retain task input file ${input.relative_path}`,
      path: input.source_path,
      cause: error,
    })
  } finally {
    // Bun on macOS can intermittently stall when two handles for the same
    // filesystem are closed concurrently. Close deterministically so Local
    // input materialization cannot hang between otherwise tiny files.
    await closeQuietly(destination)
    await closeQuietly(source)
    await unlinkQuietly(temporary_path)
  }
}

async function snapshotFile(input: {
  source_path: string
  relative_path: string
  objects_dir: string
}): Promise<PipelineTaskFileEntry> {
  for (let attempt = 1; attempt <= MAX_STABLE_FILE_SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      return await snapshotFileAttempt(input)
    } catch (error) {
      const source_changed =
        error instanceof PipelineError && error.diagnostic.code === "task_input_file_changed"
      if (!source_changed || attempt === MAX_STABLE_FILE_SNAPSHOT_ATTEMPTS) throw error
    }
  }
  throw new Error("Stable task input snapshot attempts were exhausted")
}

export async function retainPipelineTaskInputFiles(input: {
  root_dir: string
  debug_dir: string
  objects_dir: string
  excluded_roots?: readonly string[]
}): Promise<PipelineTaskInputFiles> {
  const root_dir = await realpath(input.root_dir)
  const root_metadata = await lstat(root_dir)
  if (!root_metadata.isDirectory() || root_metadata.isSymbolicLink()) {
    throw pipelineError({
      code: "task_input_root_invalid",
      message: "Task input root must be a real directory",
      path: input.root_dir,
    })
  }
  await mkdir(input.objects_dir, { recursive: true, mode: 0o700 })
  const excluded_roots = new Set(input.excluded_roots ?? [])
  const directories: string[] = []
  const files: PipelineTaskFileEntry[] = []

  const walk = async (directory: string, relative_directory = ""): Promise<void> => {
    const handle = await opendir(directory)
    const entries = []
    for await (const entry of handle) entries.push(entry)
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relative_path = relative_directory ? join(relative_directory, entry.name) : entry.name
      const top_level = relative_path.split(sep)[0]
      const is_runtime_history = relative_path === "runs" || relative_path === join("spice", "runs")
      if (entry.isDirectory() && (is_runtime_history || excluded_roots.has(top_level ?? ""))) continue
      if (entry.isFile() && EXCLUDED_FILE_NAMES.has(entry.name)) continue
      const source_path = join(directory, entry.name)
      const metadata = await lstat(source_path)
      if (metadata.isSymbolicLink()) {
        throw pipelineError({
          code: "task_input_symlink",
          message: `Task input refuses symbolic links: ${relative_path}`,
          path: source_path,
        })
      }
      if (metadata.isDirectory()) {
        directories.push(relative_path)
        if (directories.length > MAX_DIRECTORIES) {
          throw pipelineError({
            code: "task_input_too_broad",
            message: "Task input has too many directories",
          })
        }
        await walk(source_path, relative_path)
        continue
      }
      if (!metadata.isFile()) {
        throw pipelineError({
          code: "task_input_entry_invalid",
          message: `Task input contains an unsupported filesystem entry: ${relative_path}`,
          path: source_path,
        })
      }
      files.push(await snapshotFile({ source_path, relative_path, objects_dir: input.objects_dir }))
      if (files.length > MAX_FILES) {
        throw pipelineError({ code: "task_input_too_broad", message: "Task input has too many files" })
      }
    }
  }
  await walk(root_dir)
  const manifest: PipelineTaskFileManifest = {
    version: MANIFEST_VERSION,
    kind: MANIFEST_KIND,
    directories,
    files,
  }
  await writeFile(join(input.debug_dir, "input-files.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  return {
    kind: "pipeline_task_files",
    manifest_path: "input-files.json",
    objects_path: "../../input-objects",
  }
}

function parseManifest(value: unknown): PipelineTaskFileManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw pipelineError({
      code: "task_input_manifest_invalid",
      message: "Task input file manifest is invalid",
    })
  }
  const record = value as Record<string, unknown>
  if (
    record.version !== MANIFEST_VERSION ||
    record.kind !== MANIFEST_KIND ||
    !Array.isArray(record.directories) ||
    !Array.isArray(record.files) ||
    record.directories.length > MAX_DIRECTORIES ||
    record.files.length > MAX_FILES ||
    !record.directories.every((path) => typeof path === "string" && safeRelativePath(path))
  ) {
    throw pipelineError({
      code: "task_input_manifest_invalid",
      message: "Task input file manifest is invalid",
    })
  }
  const seen = new Set<string>()
  const files: PipelineTaskFileEntry[] = []
  for (const entry of record.files) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw pipelineError({
        code: "task_input_manifest_invalid",
        message: "Task input file entry is invalid",
      })
    }
    const file = entry as Record<string, unknown>
    if (
      typeof file.path !== "string" ||
      !safeRelativePath(file.path) ||
      seen.has(file.path) ||
      typeof file.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.hash) ||
      typeof file.size_bytes !== "number" ||
      !Number.isSafeInteger(file.size_bytes) ||
      file.size_bytes < 0 ||
      typeof file.mode !== "number" ||
      !Number.isInteger(file.mode) ||
      file.mode < 0 ||
      file.mode > 0o777
    ) {
      throw pipelineError({
        code: "task_input_manifest_invalid",
        message: "Task input file entry is invalid",
      })
    }
    seen.add(file.path)
    files.push({ path: file.path, hash: file.hash, size_bytes: file.size_bytes, mode: file.mode })
  }
  return {
    version: 1,
    kind: MANIFEST_KIND,
    directories: [...(record.directories as string[])],
    files,
  }
}

async function requireRegularFile(path: string, maximum_size?: number): Promise<Stats> {
  const metadata = await lstat(path).catch((cause) => {
    throw pipelineError({
      code: "task_input_bundle_missing",
      message: `Task input bundle is missing ${path}`,
      path,
      cause,
    })
  })
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (maximum_size !== undefined && metadata.size > maximum_size)
  ) {
    throw pipelineError({
      code: "task_input_bundle_invalid",
      message: `Task input bundle file is invalid: ${path}`,
      path,
    })
  }
  return metadata
}

export async function loadPipelineTaskInputBundle(input_path: string): Promise<PipelineTaskInputBundle> {
  const resolved_input = resolve(input_path)
  const envelope = await loadPipelineTaskInput(resolved_input)
  if (!envelope.input_files) {
    throw pipelineError({
      code: "task_input_files_missing",
      message: `Task ${envelope.pipeline_id}/${envelope.task_id} has no complete retained input filesystem`,
      path: resolved_input,
    })
  }
  const input_dir = dirname(resolved_input)
  const manifest_path = resolve(input_dir, envelope.input_files.manifest_path)
  const objects_dir = resolve(input_dir, envelope.input_files.objects_path)
  await requireRegularFile(manifest_path, MAX_MANIFEST_BYTES)
  const manifest = parseManifest(JSON.parse(await readFile(manifest_path, "utf8")) as unknown)
  const objects_metadata = await lstat(objects_dir).catch(() => undefined)
  if (!objects_metadata?.isDirectory() || objects_metadata.isSymbolicLink()) {
    throw pipelineError({
      code: "task_input_objects_invalid",
      message: "Task input object directory is invalid",
      path: objects_dir,
    })
  }
  for (const file of manifest.files) {
    const object_path = join(objects_dir, file.hash)
    const metadata = await requireRegularFile(object_path)
    if (metadata.size !== file.size_bytes || (await hashFile(object_path)) !== file.hash) {
      throw pipelineError({
        code: "task_input_object_mismatch",
        message: `Task input object does not match its manifest: ${file.path}`,
        path: object_path,
      })
    }
  }
  const retained_job_dir = findRetainedJobDir(input_dir, envelope)
  return {
    input_path: resolved_input,
    input_dir,
    bundle_root: resolve(input_dir, "../.."),
    objects_dir,
    ...(retained_job_dir ? { retained_job_dir } : {}),
    envelope,
    manifest,
  }
}

export async function materializePipelineTaskInputFiles(input: {
  bundle: PipelineTaskInputBundle
  destination_root: string
}): Promise<void> {
  for (const directory of input.bundle.manifest.directories) {
    await mkdir(join(input.destination_root, directory), { recursive: true, mode: 0o700 })
  }
  for (const file of input.bundle.manifest.files) {
    const destination = join(input.destination_root, file.path)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    const object_path = join(input.bundle.objects_dir, file.hash)
    let source: FileHandle | undefined
    let output: FileHandle | undefined
    let created = false
    let materialized = false
    try {
      source = await open(object_path, constants.O_RDONLY | constants.O_NOFOLLOW)
      const opened = await source.stat()
      if (!opened.isFile() || opened.size !== file.size_bytes) {
        throw new Error("retained object metadata changed")
      }
      output = await open(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      created = true
      const hash = createHash("sha256")
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
      let position = 0
      while (true) {
        const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position)
        if (bytesRead === 0) break
        hash.update(buffer.subarray(0, bytesRead))
        let written = 0
        while (written < bytesRead) {
          const result = await output.write(buffer, written, bytesRead - written, null)
          if (result.bytesWritten === 0) throw new Error("Task input materialization made no progress")
          written += result.bytesWritten
        }
        position += bytesRead
      }
      const [finished, current] = await Promise.all([source.stat(), lstat(object_path)])
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        !sameFile(opened, finished) ||
        !sameFile(opened, current) ||
        position !== file.size_bytes ||
        hash.digest("hex") !== file.hash
      ) {
        throw new Error("retained object changed while it was materialized")
      }
      // The retained object was already fsynced and hash-verified when the
      // portable bundle was created. A Local workspace is disposable, so
      // syncing every copied file only serializes filesystem-wide flushes and
      // can turn a small bundle into a multi-minute materialization.
      await output.chmod(file.mode)
      materialized = true
    } catch (cause) {
      throw pipelineError({
        code: "task_input_materialization_failed",
        message: `Could not materialize retained task input ${file.path}`,
        path: object_path,
        cause,
      })
    } finally {
      // See snapshotFile: concurrent FileHandle.close() calls can stall Bun on
      // macOS after the destination has already been fully materialized.
      await closeQuietly(output)
      await closeQuietly(source)
      if (created && !materialized) await unlinkQuietly(destination)
    }
  }
}

/** Restores a selected job to the exact retained pre-task filesystem boundary. */
export async function restorePipelineTaskInputFiles(input: {
  bundle: PipelineTaskInputBundle
  destination_root: string
  excluded_roots?: readonly string[]
  /** Live control files that must not be rewound to a retained task boundary. */
  preserved_paths?: readonly string[]
  /**
   * Live output roots that belong to the selected job, not to the retained
   * task input. Existing entries are never removed or overwritten; missing
   * retained entries may still be restored.
   */
  preserved_roots?: readonly string[]
}): Promise<void> {
  const destination_root = await realpath(input.destination_root)
  const temporary_root = join(destination_root, `.restoring-${randomUUID()}`)
  await mkdir(temporary_root)
  try {
    await materializePipelineTaskInputFiles({ bundle: input.bundle, destination_root: temporary_root })
    const retained_files = new Set(input.bundle.manifest.files.map(({ path }) => path))
    const retained_directories = new Set(input.bundle.manifest.directories)
    const excluded_roots = new Set(input.excluded_roots ?? [])
    const preserved_roots = new Set(input.preserved_roots ?? [])
    const preserved_paths = new Set(input.preserved_paths ?? [])

    const prune = async (directory: string, relative_directory = ""): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative_path = relative_directory ? join(relative_directory, entry.name) : entry.name
        const top_level = relative_path.split(sep)[0] ?? ""
        if (
          entry.name === basename(temporary_root) ||
          excluded_roots.has(top_level) ||
          preserved_roots.has(top_level) ||
          preserved_paths.has(relative_path) ||
          relative_path === "runs" ||
          relative_path.startsWith(`runs${sep}`) ||
          relative_path === join("spice", "runs") ||
          relative_path.startsWith(`${join("spice", "runs")}${sep}`) ||
          (entry.isFile() && EXCLUDED_FILE_NAMES.has(entry.name))
        ) {
          continue
        }
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          await prune(path, relative_path)
          if (!retained_directories.has(relative_path)) {
            await rm(path, { recursive: false }).catch(() => undefined)
          }
        } else if (!retained_files.has(relative_path)) {
          await rm(path, { force: true })
        }
      }
    }
    await prune(destination_root)

    for (const directory of input.bundle.manifest.directories) {
      await mkdir(join(destination_root, directory), { recursive: true, mode: 0o700 })
    }
    for (const file of input.bundle.manifest.files) {
      const source = join(temporary_root, file.path)
      const destination = join(destination_root, file.path)
      const top_level = file.path.split(sep)[0] ?? ""
      if (
        (preserved_roots.has(top_level) || preserved_paths.has(file.path)) &&
        (await lstat(destination).catch(() => undefined))
      ) {
        continue
      }
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await rename(source, destination)
    }
  } finally {
    await rm(temporary_root, { recursive: true, force: true }).catch(() => undefined)
  }
}
