import { constants } from "node:fs"
import { lstat, mkdir, open } from "node:fs/promises"
import { dirname } from "node:path"
import type { JobLog } from "@/shared/job-types"
import { atomicWriteTextSync } from "./atomic-write"

/** Public store snapshots retain only this recent event window in memory. */
export const RECENT_LOG_EVENT_LIMIT = 500

/** One current NDJSON file and one archive are retained, each within this bound. */
export const PERSISTED_LOG_FILE_BYTE_LIMIT = 2 * 1024 * 1024

/** Prevent one unusually large subprocess chunk from defeating file rotation bounds. */
export const PERSISTED_LOG_EVENT_BYTE_LIMIT = 256 * 1024

export type LogEventWriter = (file_path: string, log: JobLog) => Promise<void>

const LOG_ARCHIVE_SUFFIX = ".1"
const TRUNCATION_MARKER = "[... earlier bytes in this log event were truncated ...]\n"
const append_queues = new Map<string, Promise<void>>()

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

function serializeLog(log: JobLog): string {
  return `${JSON.stringify(log)}\n`
}

export function getLogArchivePath(file_path: string): string {
  return `${file_path}${LOG_ARCHIVE_SUFFIX}`
}

export function capRecentLogs(logs: readonly JobLog[]): JobLog[] {
  return logs.slice(-RECENT_LOG_EVENT_LIMIT)
}

/** Return the exact log event that will be persisted, held in memory, and sent over SSE. */
export function prepareBoundedLogEvent(log: JobLog): JobLog {
  if (byteLength(serializeLog(log)) <= PERSISTED_LOG_EVENT_BYTE_LIMIT) return log

  let minimum = 0
  let maximum = log.message.length
  let retained_message = TRUNCATION_MARKER
  while (minimum <= maximum) {
    const retained_characters = Math.floor((minimum + maximum) / 2)
    const retained_tail = retained_characters === 0 ? "" : log.message.slice(-retained_characters)
    const candidate_message = `${TRUNCATION_MARKER}${retained_tail}`
    const candidate = { ...log, message: candidate_message }
    if (byteLength(serializeLog(candidate)) <= PERSISTED_LOG_EVENT_BYTE_LIMIT) {
      retained_message = candidate_message
      minimum = retained_characters + 1
    } else {
      maximum = retained_characters - 1
    }
  }
  return { ...log, message: retained_message }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  )
}

/** Read at most `max_bytes` from a file tail without following symlinks. */
export async function readBoundedUtf8Tail(
  file_path: string,
  max_bytes = PERSISTED_LOG_FILE_BYTE_LIMIT,
): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(file_path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isMissingFile(error)) return ""
    throw error
  }
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error(`Persisted log is not a regular file: ${file_path}`)
    const bounded_bytes = Math.max(1, max_bytes)
    const content_start = Math.max(0, metadata.size - bounded_bytes)
    const read_start = content_start > 0 ? content_start - 1 : 0
    const bytes_to_read = metadata.size - read_start
    const buffer = Buffer.alloc(bytes_to_read)
    let bytes_read = 0
    while (bytes_read < bytes_to_read) {
      const result = await handle.read(
        buffer,
        bytes_read,
        bytes_to_read - bytes_read,
        read_start + bytes_read,
      )
      if (result.bytesRead === 0) break
      bytes_read += result.bytesRead
    }
    const bytes = buffer.subarray(0, bytes_read)
    if (content_start === 0) return bytes.toString("utf8")
    const previous_byte = bytes[0]
    const tail = bytes.subarray(1)
    if (previous_byte === 0x0a) return tail.toString("utf8")
    const first_newline = tail.indexOf(0x0a)
    return first_newline < 0 ? "" : tail.subarray(first_newline + 1).toString("utf8")
  } finally {
    await handle.close()
  }
}

async function rotateCurrentLog(file_path: string): Promise<void> {
  const archive_text = await readBoundedUtf8Tail(file_path)
  atomicWriteTextSync(getLogArchivePath(file_path), archive_text)
  atomicWriteTextSync(file_path, "")
}

async function appendBoundedLogEventNow(file_path: string, log: JobLog): Promise<void> {
  const line = serializeLog(log)
  const line_bytes = byteLength(line)
  if (line_bytes > PERSISTED_LOG_EVENT_BYTE_LIMIT) {
    throw new Error(`Persisted log event exceeds ${PERSISTED_LOG_EVENT_BYTE_LIMIT} bytes`)
  }
  await mkdir(dirname(file_path), { recursive: true })
  let metadata: Awaited<ReturnType<typeof lstat>> | undefined
  try {
    metadata = await lstat(file_path)
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink())) {
    throw new Error(`Persisted log must be a regular file and not a symlink: ${file_path}`)
  }
  const current_size = metadata ? Number(metadata.size) : 0
  if (current_size + line_bytes > PERSISTED_LOG_FILE_BYTE_LIMIT) {
    await rotateCurrentLog(file_path)
  }
  const handle = await open(
    file_path,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const initial_size = Number((await handle.stat()).size)
    try {
      await handle.writeFile(line, "utf8")
    } catch (error) {
      await handle.truncate(initial_size).catch(() => undefined)
      throw error
    }
  } finally {
    await handle.close()
  }
}

/** Serialize rotation and append operations for each log path. */
export const appendBoundedLogEvent: LogEventWriter = (file_path, log) => {
  const previous = append_queues.get(file_path) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(() => appendBoundedLogEventNow(file_path, log))
  append_queues.set(file_path, operation)
  const clear = () => {
    if (append_queues.get(file_path) === operation) append_queues.delete(file_path)
  }
  void operation.then(clear, clear)
  return operation
}
