import { randomUUID } from "node:crypto"
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"

export type CheckpointWriter = (path: string, value: unknown) => void

export interface AtomicWriteResult {
  durability: "directory_synced" | "rename_visible"
  durability_warning?: string
}

interface AtomicWriteOptions {
  sync_directory?: (directory: string) => void
}

function syncDirectory(directory: string): void {
  const directory_descriptor = openSync(directory, constants.O_RDONLY)
  try {
    fsyncSync(directory_descriptor)
  } finally {
    closeSync(directory_descriptor)
  }
}

/** Replace one persisted checkpoint without ever exposing a partially written file. */
export function atomicWriteTextSync(
  path: string,
  content: string,
  options: AtomicWriteOptions = {},
): AtomicWriteResult {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporary_path = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let file_descriptor: number | undefined
  try {
    file_descriptor = openSync(temporary_path, "wx", 0o600)
    writeFileSync(file_descriptor, content, "utf8")
    fsyncSync(file_descriptor)
    closeSync(file_descriptor)
    file_descriptor = undefined
    renameSync(temporary_path, path)
    try {
      ;(options.sync_directory ?? syncDirectory)(directory)
      return { durability: "directory_synced" }
    } catch (error) {
      // rename is the visibility boundary. Reporting this as an ordinary write
      // failure would let callers roll back live state even though readers can
      // already observe the new checkpoint.
      return {
        durability: "rename_visible",
        durability_warning: `Atomic checkpoint ${basename(path)} was renamed, but its directory sync failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  } finally {
    if (file_descriptor !== undefined) closeSync(file_descriptor)
    try {
      unlinkSync(temporary_path)
    } catch {
      // A successful rename removes the temporary path; failed writes are cleaned up here.
    }
  }
}

export function atomicWriteJsonSync(
  path: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): AtomicWriteResult {
  return atomicWriteTextSync(path, `${JSON.stringify(value, null, 2)}\n`, options)
}
