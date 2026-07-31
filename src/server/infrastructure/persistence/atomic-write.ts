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

/** Replace one persisted checkpoint without ever exposing a partially written file. */
export function atomicWriteTextSync(path: string, content: string): void {
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
    const directory_descriptor = openSync(directory, constants.O_RDONLY)
    try {
      fsyncSync(directory_descriptor)
    } finally {
      closeSync(directory_descriptor)
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

export const atomicWriteJsonSync: CheckpointWriter = (path, value) => {
  atomicWriteTextSync(path, `${JSON.stringify(value, null, 2)}\n`)
}
