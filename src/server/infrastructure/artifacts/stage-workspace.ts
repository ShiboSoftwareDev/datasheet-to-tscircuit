import { constants } from "node:fs"
import { lstat, mkdir, mkdtemp, open, opendir, readdir, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path"
import { inflateSync } from "node:zlib"

export interface StageWorkspace {
  readonly path: string
  dispose(): Promise<void>
}

export interface StageDirectoryFile {
  readonly relative_path: string
  readonly size_bytes: number
  readonly bytes: Uint8Array
}

export type StageDirectoryFileValidator = (file: StageDirectoryFile) => void | Promise<void>

const DEFAULT_DIRECTORY_FILE_LIMIT = 128
const DEFAULT_DIRECTORY_BYTE_LIMIT = 64 * 1024 * 1024
const DEFAULT_DIRECTORY_ENTRY_LIMIT = 512
const DEFAULT_DIRECTORY_DEPTH_LIMIT = 16
const MAX_PNG_FILE_BYTES = 32 * 1024 * 1024
const MAX_PNG_DIMENSION = 16_384
const MAX_PNG_PIXELS = 25_000_000
const MAX_PNG_DECODED_BYTES = 100 * 1024 * 1024
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const
const RETAINED_ATTEMPT_MARKER = "retained-attempt.json"

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return crc >>> 0
})

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunkType(bytes: Uint8Array): string {
  return String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0)
}

function pngPassDimensions(
  width: number,
  height: number,
  interlace: number,
): Array<{ width: number; height: number }> {
  if (interlace === 0) return [{ width, height }]
  return [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ].flatMap(([start_x, start_y, step_x, step_y]) => {
    const pass_width = width <= start_x ? 0 : Math.ceil((width - start_x) / step_x)
    const pass_height = height <= start_y ? 0 : Math.ceil((height - start_y) / step_y)
    return pass_width > 0 && pass_height > 0 ? [{ width: pass_width, height: pass_height }] : []
  })
}

function pngFailure(file: StageDirectoryFile, detail: string): Error {
  return new Error(`Reference image is not a valid PNG (${detail}): ${file.relative_path}`)
}

function safeRelativePath(path: string): string {
  const normalized = normalize(path).replaceAll("\\", "/")
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`Artifact path must stay inside its workspace: ${path}`)
  }
  return normalized
}

function resolveInside(root: string, path: string): string {
  const resolved = resolve(root, safeRelativePath(path))
  const from_root = relative(root, resolved)
  if (!from_root || from_root === ".." || from_root.startsWith(`..${sep}`)) {
    throw new Error(`Artifact path escapes its workspace: ${path}`)
  }
  return resolved
}

async function readRegularFile(path: string, max_bytes: number): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
    throw new Error(`Artifact must be a regular file and not a symlink: ${path}`, { cause: error })
  })
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error(`Artifact is not a regular file: ${path}`)
    if (metadata.size > max_bytes) {
      throw new Error(`Artifact is unexpectedly large (${metadata.size} bytes): ${path}`)
    }
    const bytes = Buffer.allocUnsafe(metadata.size + 1)
    let bytes_read = 0
    while (bytes_read < bytes.byteLength) {
      const result = await handle.read(bytes, bytes_read, bytes.byteLength - bytes_read, bytes_read)
      if (result.bytesRead === 0) break
      bytes_read += result.bytesRead
    }
    if (bytes_read !== metadata.size) {
      throw new Error(`Artifact changed while being read: ${path}`)
    }
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes_read)
  } finally {
    await handle.close()
  }
}

function requiredPositiveLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw error
  }
}

/** Read an agent-owned JSON file through a bounded, no-final-symlink boundary. */
export async function readBoundedJsonArtifact(input: {
  path: string
  max_bytes: number
  max_depth?: number
  max_nodes?: number
}): Promise<unknown> {
  const max_bytes = requiredPositiveLimit(input.max_bytes, "JSON artifact max_bytes")
  const max_depth = requiredPositiveLimit(input.max_depth ?? 64, "JSON artifact max_depth")
  const max_nodes = requiredPositiveLimit(input.max_nodes ?? 100_000, "JSON artifact max_nodes")
  const bytes = await readRegularFile(input.path, max_bytes)
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    throw new Error(`Artifact is not valid UTF-8: ${input.path}`, { cause: error })
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `Artifact contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }

  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    nodes += 1
    if (nodes > max_nodes) {
      throw new Error(`JSON artifact exceeds the ${max_nodes}-node limit: ${input.path}`)
    }
    if (current.depth > max_depth) {
      throw new Error(`JSON artifact exceeds the ${max_depth}-level depth limit: ${input.path}`)
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 })
    } else if (typeof current.value === "object" && current.value !== null) {
      for (const child of Object.values(current.value)) {
        pending.push({ value: child, depth: current.depth + 1 })
      }
    }
  }
  return value
}

/** Read an agent-owned text file through a bounded, no-final-symlink boundary. */
export async function readBoundedTextArtifact(input: { path: string; max_bytes: number }): Promise<string> {
  const max_bytes = requiredPositiveLimit(input.max_bytes, "Text artifact max_bytes")
  const bytes = await readRegularFile(input.path, max_bytes)
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    throw new Error(`Artifact is not valid UTF-8 text: ${input.path}`, { cause: error })
  }
}

async function collectRegularDirectory(input: {
  root: string
  max_files?: number
  max_total_bytes?: number
  max_entries?: number
  max_depth?: number
  validate_file?: StageDirectoryFileValidator
}): Promise<StageDirectoryFile[]> {
  const root_metadata = await lstat(input.root).catch(() => undefined)
  if (!root_metadata?.isDirectory() || root_metadata.isSymbolicLink()) {
    throw new Error(`Artifact directory must be a real directory: ${input.root}`)
  }
  const max_files = requiredPositiveLimit(
    input.max_files ?? DEFAULT_DIRECTORY_FILE_LIMIT,
    "Artifact directory max_files",
  )
  const max_total_bytes = requiredPositiveLimit(
    input.max_total_bytes ?? DEFAULT_DIRECTORY_BYTE_LIMIT,
    "Artifact directory max_total_bytes",
  )
  const max_entries = requiredPositiveLimit(
    input.max_entries ?? DEFAULT_DIRECTORY_ENTRY_LIMIT,
    "Artifact directory max_entries",
  )
  const max_depth = requiredPositiveLimit(
    input.max_depth ?? DEFAULT_DIRECTORY_DEPTH_LIMIT,
    "Artifact directory max_depth",
  )
  const files: StageDirectoryFile[] = []
  let total_bytes = 0
  let entries_seen = 0

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > max_depth) {
      throw new Error(`Artifact directory exceeds the ${max_depth}-level depth limit: ${input.root}`)
    }
    const entries = []
    const handle = await opendir(directory)
    for await (const entry of handle) {
      entries_seen += 1
      if (entries_seen > max_entries) {
        throw new Error(`Artifact directory exceeds the ${max_entries}-entry limit: ${input.root}`)
      }
      entries.push(entry)
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) throw new Error(`Artifact directory contains a symlink: ${path}`)
      if (metadata.isDirectory()) {
        await visit(path, depth + 1)
        continue
      }
      if (!metadata.isFile()) throw new Error(`Artifact directory contains a special file: ${path}`)
      if (files.length >= max_files) {
        throw new Error(`Artifact directory exceeds the ${max_files}-file limit: ${input.root}`)
      }
      const remaining_bytes = max_total_bytes - total_bytes
      if (metadata.size > remaining_bytes) {
        throw new Error(`Artifact directory exceeds the ${max_total_bytes}-byte limit: ${input.root}`)
      }
      const bytes = await readRegularFile(path, remaining_bytes)
      total_bytes += bytes.byteLength
      const file = {
        relative_path: relative(input.root, path),
        size_bytes: bytes.byteLength,
        bytes,
      }
      await input.validate_file?.(file)
      files.push(file)
    }
  }
  await visit(input.root, 0)
  return files
}

async function writeRegularDirectory(destination: string, files: readonly StageDirectoryFile[]) {
  await mkdir(destination, { recursive: true })
  for (const file of files) {
    const path = resolveInside(destination, file.relative_path)
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(path, file.bytes)
  }
}

async function syncRegularFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectoryTree(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await syncDirectoryTree(path)
    else if (entry.isFile()) await syncRegularFile(path)
    else throw new Error(`Cannot durably publish a special filesystem entry: ${path}`)
  }
  await syncDirectory(directory)
}

async function syncDirectoryChain(directory: string, root: string): Promise<void> {
  const resolved_root = resolve(root)
  let current = resolve(directory)
  while (true) {
    const from_root = relative(resolved_root, current)
    if (from_root === ".." || from_root.startsWith(`..${sep}`) || isAbsolute(from_root)) {
      throw new Error(`Publication directory ${directory} is outside ${root}`)
    }
    await syncDirectory(current)
    if (current === resolved_root) return
    const parent = dirname(current)
    if (parent === current) throw new Error(`Publication directory ${directory} is outside ${root}`)
    current = parent
  }
}

export function validatePngArtifact(file: StageDirectoryFile): void {
  if (extname(file.relative_path).toLowerCase() !== ".png") {
    throw new Error(`Reference-image directory may contain only PNG files: ${file.relative_path}`)
  }
  const bytes = file.bytes
  if (bytes.byteLength > MAX_PNG_FILE_BYTES) throw pngFailure(file, "file exceeds 32 MiB")
  if (bytes.byteLength < 45 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    throw pngFailure(file, "signature or required chunks are missing")
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset: number = PNG_SIGNATURE.length
  let width = 0
  let height = 0
  let bit_depth = 0
  let color_type = -1
  let interlace: number = 0
  let seen_ihdr = false
  let seen_plte = false
  let seen_idat = false
  let idat_ended = false
  let seen_iend = false
  const idat_chunks: Uint8Array[] = []

  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) throw pngFailure(file, "truncated chunk header")
    const length = view.getUint32(offset)
    const chunk_end = offset + 12 + length
    if (!Number.isSafeInteger(chunk_end) || chunk_end > bytes.byteLength) {
      throw pngFailure(file, "truncated chunk payload")
    }
    const type_bytes = bytes.subarray(offset + 4, offset + 8)
    const type = pngChunkType(type_bytes)
    if (!/^[A-Za-z]{4}$/.test(type)) throw pngFailure(file, "invalid chunk type")
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    const declared_crc = view.getUint32(offset + 8 + length)
    const actual_crc = crc32(bytes.subarray(offset + 4, offset + 8 + length))
    if (declared_crc !== actual_crc) throw pngFailure(file, `${type} CRC mismatch`)
    if (seen_idat && type !== "IDAT" && type !== "IEND") idat_ended = true

    if (type === "IHDR") {
      if (seen_ihdr || offset !== PNG_SIGNATURE.length || length !== 13) {
        throw pngFailure(file, "IHDR must be the first and only 13-byte header")
      }
      seen_ihdr = true
      width = view.getUint32(offset + 8)
      height = view.getUint32(offset + 12)
      bit_depth = view.getUint8(offset + 16)
      color_type = view.getUint8(offset + 17)
      const compression = view.getUint8(offset + 18)
      const filter = view.getUint8(offset + 19)
      interlace = view.getUint8(offset + 20)
      const valid_depths: Record<number, readonly number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      }
      if (!valid_depths[color_type]?.includes(bit_depth)) {
        throw pngFailure(file, `unsupported bit depth ${bit_depth} for color type ${color_type}`)
      }
      if (compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) {
        throw pngFailure(file, "unsupported compression, filter, or interlace method")
      }
      const pixels = width * height
      if (
        width < 1 ||
        height < 1 ||
        width > MAX_PNG_DIMENSION ||
        height > MAX_PNG_DIMENSION ||
        !Number.isSafeInteger(pixels) ||
        pixels > MAX_PNG_PIXELS ||
        pixels * 4 > MAX_PNG_DECODED_BYTES
      ) {
        throw pngFailure(file, `unsafe dimensions ${width}x${height}`)
      }
    } else if (!seen_ihdr) {
      throw pngFailure(file, "chunk appears before IHDR")
    } else if (type === "PLTE") {
      if (seen_plte || seen_idat || length === 0 || length % 3 !== 0 || length > 768) {
        throw pngFailure(file, "invalid PLTE chunk")
      }
      if (color_type === 0 || color_type === 4) throw pngFailure(file, "PLTE is forbidden for grayscale")
      seen_plte = true
    } else if (type === "IDAT") {
      if (idat_ended) throw pngFailure(file, "IDAT chunks must be consecutive")
      if (color_type === 3 && !seen_plte) throw pngFailure(file, "indexed PNG is missing PLTE")
      seen_idat = true
      idat_chunks.push(data)
    } else if (type === "IEND") {
      if (length !== 0 || !seen_idat || seen_iend) throw pngFailure(file, "invalid IEND chunk")
      seen_iend = true
      offset = chunk_end
      if (offset !== bytes.byteLength) throw pngFailure(file, "bytes appear after IEND")
      break
    } else if (/^[A-Z]/.test(type)) {
      throw pngFailure(file, `unknown critical chunk ${type}`)
    }
    offset = chunk_end
  }

  if (!seen_ihdr || !seen_idat || !seen_iend) throw pngFailure(file, "IHDR, IDAT, or IEND is missing")
  const channels_by_color_type: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
  const channels = channels_by_color_type[color_type]
  if (channels === undefined) throw pngFailure(file, `unsupported color type ${color_type}`)
  const bits_per_pixel = channels * bit_depth
  const passes = pngPassDimensions(width, height, interlace)
  const expected_inflated_bytes = passes.reduce(
    (total, pass) => total + (Math.ceil((pass.width * bits_per_pixel) / 8) + 1) * pass.height,
    0,
  )
  if (expected_inflated_bytes > MAX_PNG_DECODED_BYTES) {
    throw pngFailure(file, `decoded scanlines exceed ${MAX_PNG_DECODED_BYTES} bytes`)
  }
  let inflated: Uint8Array
  try {
    inflated = inflateSync(Buffer.concat(idat_chunks.map((chunk) => Buffer.from(chunk))), {
      maxOutputLength: expected_inflated_bytes,
    })
  } catch (error) {
    throw new Error(`Reference image is not a valid PNG (IDAT stream is invalid): ${file.relative_path}`, {
      cause: error,
    })
  }
  if (inflated.byteLength !== expected_inflated_bytes) {
    throw pngFailure(
      file,
      `decoded scanlines contain ${inflated.byteLength} bytes, expected ${expected_inflated_bytes}`,
    )
  }
  let scanline_offset = 0
  for (const pass of passes) {
    const scanline_bytes = Math.ceil((pass.width * bits_per_pixel) / 8)
    for (let row = 0; row < pass.height; row += 1) {
      const filter_type = inflated[scanline_offset]
      if (filter_type === undefined || filter_type > 4) {
        throw pngFailure(file, `invalid scanline filter ${String(filter_type)}`)
      }
      scanline_offset += scanline_bytes + 1
    }
  }
}

export async function validateStageDirectory(input: {
  root: string
  max_files?: number
  max_total_bytes?: number
  max_entries?: number
  max_depth?: number
  validate_file?: StageDirectoryFileValidator
}): Promise<void> {
  await collectRegularDirectory(input)
}

export async function createStageWorkspace(input: {
  prefix: string
  files: Array<{ source: string; destination?: string; required?: boolean }>
  directories?: Array<{ source: string; destination?: string; required?: boolean }>
}): Promise<StageWorkspace> {
  const path = await mkdtemp(join(tmpdir(), `${input.prefix}-`))
  try {
    for (const file of input.files) {
      const metadata = await lstat(file.source).catch(() => undefined)
      if (!metadata?.isFile() || metadata.isSymbolicLink()) {
        if (file.required !== false) throw new Error(`Required stage input is missing: ${file.source}`)
        continue
      }
      const destination = resolveInside(path, file.destination ?? basename(file.source))
      await mkdir(dirname(destination), { recursive: true })
      await Bun.write(destination, await readRegularFile(file.source, 64 * 1024 * 1024))
    }
    for (const directory of input.directories ?? []) {
      const metadata = await lstat(directory.source).catch(() => undefined)
      if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
        if (directory.required !== false) {
          throw new Error(`Required stage input directory is missing: ${directory.source}`)
        }
        continue
      }
      const destination = resolveInside(path, directory.destination ?? basename(directory.source))
      const files = await collectRegularDirectory({
        root: directory.source,
        max_files: 256,
        max_total_bytes: 128 * 1024 * 1024,
      })
      await writeRegularDirectory(destination, files)
    }
  } catch (error) {
    await rm(path, { recursive: true, force: true })
    throw error
  }
  return {
    path,
    dispose: () => rm(path, { recursive: true, force: true }),
  }
}

export async function promoteStageFile(input: {
  workspace: string
  source: string
  destination_root: string
  destination?: string
  max_bytes?: number
  signal?: AbortSignal
}): Promise<void> {
  input.signal?.throwIfAborted()
  const source = resolveInside(input.workspace, input.source)
  const bytes = await readRegularFile(source, input.max_bytes ?? 10 * 1024 * 1024)
  input.signal?.throwIfAborted()
  const destination = resolveInside(input.destination_root, input.destination ?? input.source)
  await mkdir(dirname(destination), { recursive: true })
  const temporary = join(dirname(destination), `.${basename(destination)}.${crypto.randomUUID()}.tmp`)
  const previous = `${temporary}.previous`
  let previous_moved = false
  let candidate_published = false
  try {
    await Bun.write(temporary, bytes)
    await syncRegularFile(temporary)
    input.signal?.throwIfAborted()
    const destination_metadata = await lstatIfPresent(destination)
    if (destination_metadata && (!destination_metadata.isFile() || destination_metadata.isSymbolicLink())) {
      throw new Error(`Artifact file destination must be a regular file when it exists: ${destination}`)
    }
    if (destination_metadata) {
      await rename(destination, previous)
      previous_moved = true
      await syncDirectoryChain(dirname(destination), input.destination_root)
    }
    input.signal?.throwIfAborted()
    await rename(temporary, destination)
    candidate_published = true
    await syncDirectoryChain(dirname(destination), input.destination_root)

    if (previous_moved) {
      await rm(previous, { force: true }).catch(() => undefined)
      previous_moved = false
      await syncDirectoryChain(dirname(destination), input.destination_root).catch(() => undefined)
    }
  } catch (error) {
    const rollback_errors: unknown[] = []
    if (candidate_published) {
      try {
        await rename(destination, temporary)
        candidate_published = false
      } catch (rollback_error) {
        rollback_errors.push(rollback_error)
      }
    }
    if (previous_moved) {
      try {
        await rename(previous, destination)
        previous_moved = false
      } catch (rollback_error) {
        rollback_errors.push(rollback_error)
      }
    }
    try {
      await syncDirectoryChain(dirname(destination), input.destination_root)
    } catch (rollback_error) {
      rollback_errors.push(rollback_error)
    }
    if (rollback_errors.length > 0) {
      throw new AggregateError(
        [error, ...rollback_errors],
        `Artifact file publication failed and could not be rolled back completely: ${destination}`,
        { cause: error },
      )
    }
    throw error
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function promoteStageDirectory(input: {
  workspace: string
  source: string
  destination_root: string
  destination?: string
  required?: boolean
  max_files?: number
  max_total_bytes?: number
  max_entries?: number
  max_depth?: number
  validate_file?: StageDirectoryFileValidator
  signal?: AbortSignal
}): Promise<void> {
  input.signal?.throwIfAborted()
  const source = resolveInside(input.workspace, input.source)
  const metadata = await lstat(source).catch(() => undefined)
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    if (input.required !== false) throw new Error(`Stage did not produce directory ${input.source}`)
    return
  }
  const files = await collectRegularDirectory({
    root: source,
    max_files: input.max_files,
    max_total_bytes: input.max_total_bytes,
    max_entries: input.max_entries,
    max_depth: input.max_depth,
    validate_file: input.validate_file,
  })
  input.signal?.throwIfAborted()
  const destination = resolveInside(input.destination_root, input.destination ?? input.source)
  await mkdir(dirname(destination), { recursive: true })
  const temporary = join(dirname(destination), `.${basename(destination)}.${crypto.randomUUID()}.tmp`)
  const previous = `${temporary}.previous`
  let previous_moved = false
  let candidate_published = false
  try {
    await writeRegularDirectory(temporary, files)
    await syncDirectoryTree(temporary)
    input.signal?.throwIfAborted()
    const destination_metadata = await lstatIfPresent(destination)
    if (
      destination_metadata &&
      (!destination_metadata.isDirectory() || destination_metadata.isSymbolicLink())
    ) {
      throw new Error(
        `Artifact directory destination must be a real directory when it exists: ${destination}`,
      )
    }
    if (destination_metadata) {
      await rename(destination, previous)
      previous_moved = true
      await syncDirectoryChain(dirname(destination), input.destination_root)
    }
    input.signal?.throwIfAborted()
    await rename(temporary, destination)
    candidate_published = true
    await syncDirectoryChain(dirname(destination), input.destination_root)

    // The candidate is authoritative once its rename is directory-synced.
    // Removing the hidden prior value is cleanup and must not downgrade that
    // committed publication if cleanup durability later fails.
    if (previous_moved) {
      await rm(previous, { recursive: true, force: true }).catch(() => undefined)
      previous_moved = false
      await syncDirectoryChain(dirname(destination), input.destination_root).catch(() => undefined)
    }
  } catch (error) {
    const rollback_errors: unknown[] = []
    if (candidate_published) {
      try {
        await rename(destination, temporary)
        candidate_published = false
      } catch (rollback_error) {
        rollback_errors.push(rollback_error)
      }
    }
    if (previous_moved) {
      try {
        await rename(previous, destination)
        previous_moved = false
      } catch (rollback_error) {
        rollback_errors.push(rollback_error)
      }
    }
    try {
      await syncDirectoryChain(dirname(destination), input.destination_root)
    } catch (rollback_error) {
      rollback_errors.push(rollback_error)
    }
    if (rollback_errors.length > 0) {
      throw new AggregateError(
        [error, ...rollback_errors],
        `Artifact directory publication failed and could not be rolled back completely: ${destination}`,
        { cause: error },
      )
    }
    throw error
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function retainStageRejection(input: {
  workspace: string
  debug_dir: string
  attempt: number
  error_message: string
  files?: readonly string[]
  directories?: readonly string[]
}): Promise<void> {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error("Rejected artifact attempt must be a positive safe integer")
  }
  const rejected_attempts_dir = join(input.debug_dir, "rejected-attempts")
  const attempt_dir = join(rejected_attempts_dir, String(input.attempt))
  const temporary_dir = join(rejected_attempts_dir, `.${input.attempt}.${crypto.randomUUID()}.retaining`)
  await mkdir(rejected_attempts_dir, { recursive: true })
  await mkdir(temporary_dir)
  try {
    await Bun.write(join(temporary_dir, "validation-error.txt"), `${input.error_message}\n`)
    for (const source of input.files ?? []) {
      const source_path = resolveInside(input.workspace, source)
      const metadata = await lstat(source_path).catch(() => undefined)
      if (!metadata?.isFile() || metadata.isSymbolicLink()) continue
      const bytes = await readRegularFile(source_path, 4 * 1024 * 1024)
      const destination = resolveInside(temporary_dir, source)
      await mkdir(dirname(destination), { recursive: true })
      await Bun.write(destination, bytes)
    }
    for (const source of input.directories ?? []) {
      const source_path = resolveInside(input.workspace, source)
      const metadata = await lstat(source_path).catch(() => undefined)
      if (!metadata?.isDirectory() || metadata.isSymbolicLink()) continue
      const files = await collectRegularDirectory({
        root: source_path,
        max_files: 64,
        max_total_bytes: 32 * 1024 * 1024,
      })
      await writeRegularDirectory(resolveInside(temporary_dir, source), files)
    }
    await Bun.write(
      join(temporary_dir, RETAINED_ATTEMPT_MARKER),
      `${JSON.stringify({ version: 1, attempt: input.attempt })}\n`,
    )
    await rename(temporary_dir, attempt_dir)
  } finally {
    await rm(temporary_dir, { recursive: true, force: true })
  }
}

/**
 * Seeds a new isolated correction workspace from a previously retained
 * candidate. Every source is re-read through the same bounded, no-symlink
 * artifact boundary used for publication.
 */
export async function seedStageWorkspaceFromRejection(input: {
  workspace: string
  debug_dir: string
  attempt: number
  files?: readonly string[]
  directories?: readonly string[]
}): Promise<boolean> {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) return false
  const attempt_dir = join(input.debug_dir, "rejected-attempts", String(input.attempt))
  const attempt_metadata = await lstat(attempt_dir).catch(() => undefined)
  if (!attempt_metadata?.isDirectory() || attempt_metadata.isSymbolicLink()) return false
  const marker_path = join(attempt_dir, RETAINED_ATTEMPT_MARKER)
  const marker_metadata = await lstat(marker_path).catch(() => undefined)
  if (!marker_metadata?.isFile() || marker_metadata.isSymbolicLink()) return false
  const marker = await readBoundedJsonArtifact({
    path: marker_path,
    max_bytes: 4 * 1024,
    max_depth: 2,
    max_nodes: 4,
  })
  if (
    typeof marker !== "object" ||
    marker === null ||
    Array.isArray(marker) ||
    Reflect.get(marker, "version") !== 1 ||
    Reflect.get(marker, "attempt") !== input.attempt
  ) {
    return false
  }

  const files: Array<{ destination: string; bytes: Uint8Array }> = []
  const directories: Array<{ destination: string; files: StageDirectoryFile[] }> = []

  for (const source of input.files ?? []) {
    const source_path = resolveInside(attempt_dir, source)
    const metadata = await lstat(source_path).catch(() => undefined)
    if (!metadata?.isFile() || metadata.isSymbolicLink()) continue
    files.push({ destination: source, bytes: await readRegularFile(source_path, 4 * 1024 * 1024) })
  }
  for (const source of input.directories ?? []) {
    const source_path = resolveInside(attempt_dir, source)
    const metadata = await lstat(source_path).catch(() => undefined)
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) continue
    directories.push({
      destination: source,
      files: await collectRegularDirectory({
        root: source_path,
        max_files: 64,
        max_total_bytes: 32 * 1024 * 1024,
      }),
    })
  }

  if (files.length === 0 && directories.length === 0) return false
  for (const file of files) {
    const destination = resolveInside(input.workspace, file.destination)
    await mkdir(dirname(destination), { recursive: true })
    await Bun.write(destination, file.bytes)
  }
  for (const directory of directories) {
    await writeRegularDirectory(resolveInside(input.workspace, directory.destination), directory.files)
  }
  return true
}
