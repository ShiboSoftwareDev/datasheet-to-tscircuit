import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { getLockRoot, hashContent } from "./benchmark-lock-paths"
import type { LockedFile } from "./types"

interface SetupEvidenceLock {
  version: 1
  locked_at: string
  files: LockedFile[]
}

interface SetupEvidenceFile extends LockedFile {
  content: Buffer
}

function getSetupEvidenceLockFile(model_dir: string): string {
  return join(getLockRoot(model_dir), "setup-evidence-lock.json")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseSetupEvidenceLock(value: unknown): SetupEvidenceLock {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.locked_at !== "string" ||
    !Array.isArray(value.files) ||
    !value.files.every(
      (file) => isRecord(file) && typeof file.file === "string" && typeof file.sha256 === "string",
    )
  ) {
    throw new Error("The server-owned setup evidence lock is invalid")
  }
  return value as unknown as SetupEvidenceLock
}

async function listFilesRecursively(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name)
      if (entry.isDirectory()) return listFilesRecursively(path)
      return entry.isFile() ? [path] : []
    }),
  )
  return nested.flat()
}

async function readCurrentSetupEvidence(model_dir: string): Promise<SetupEvidenceFile[]> {
  const evidence_root = join(model_dir, "evidence")
  const absolute_paths = [
    join(model_dir, "benchmark-draft.json"),
    join(model_dir, "setup-complete.json"),
    ...(await listFilesRecursively(evidence_root)),
  ]
  const files = await Promise.all(
    absolute_paths.map(async (absolute_path) => {
      const content = await readFile(absolute_path)
      const file = relative(model_dir, absolute_path)
      return { file, content, sha256: hashContent(content) }
    }),
  )
  return files.sort((a, b) => a.file.localeCompare(b.file))
}

async function writeFileAtomically(file_path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file_path), { recursive: true })
  const temporary_path = `${file_path}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary_path, content)
    await rename(temporary_path, file_path)
  } finally {
    await rm(temporary_path, { force: true }).catch(() => undefined)
  }
}

function comparableFiles(files: LockedFile[]): LockedFile[] {
  return files.map(({ file, sha256 }) => ({ file, sha256 }))
}

function getSetupEvidenceDrift(locked: LockedFile[], current: LockedFile[]): string[] {
  const locked_files = new Map(locked.map(({ file, sha256 }) => [file, sha256]))
  const current_files = new Map(current.map(({ file, sha256 }) => [file, sha256]))
  return [
    ...locked.flatMap(({ file, sha256 }) => (current_files.get(file) === sha256 ? [] : [file])),
    ...current.flatMap(({ file }) => (locked_files.has(file) ? [] : [file])),
  ].sort()
}

export async function createOrVerifySetupEvidenceLock(model_dir: string): Promise<SetupEvidenceLock> {
  const current = await readCurrentSetupEvidence(model_dir)
  const lock_file = getSetupEvidenceLockFile(model_dir)
  const existing = await readFile(lock_file, "utf8")
    .then((text) => parseSetupEvidenceLock(JSON.parse(text) as unknown))
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    })
  if (existing) {
    if (JSON.stringify(existing.files) !== JSON.stringify(comparableFiles(current))) {
      throw new Error(
        "Completed setup evidence changed after the server locked it; benchmark finalization may not rewrite benchmark-draft.json, setup-complete.json, or evidence/",
      )
    }
    return existing
  }

  const lock: SetupEvidenceLock = {
    version: 1,
    locked_at: new Date().toISOString(),
    files: comparableFiles(current),
  }
  const snapshot_root = join(getLockRoot(model_dir), "setup-snapshot")
  await rm(snapshot_root, { recursive: true, force: true })
  await Promise.all(
    current.map(({ file, content }) => writeFileAtomically(join(snapshot_root, file), content)),
  )
  await writeFileAtomically(lock_file, `${JSON.stringify(lock, null, 2)}\n`)
  return lock
}

export async function clearSetupEvidenceLockForCorrection(model_dir: string): Promise<void> {
  const lock_root = getLockRoot(model_dir)
  if (await Bun.file(join(lock_root, "lock.json")).exists()) {
    throw new Error("Cannot reopen setup evidence after the finalized benchmark suite has been locked")
  }
  await Promise.all([
    rm(getSetupEvidenceLockFile(model_dir), { force: true }),
    rm(join(lock_root, "setup-snapshot"), { recursive: true, force: true }),
  ])
}

/**
 * Restores the canonical setup snapshot before benchmark finalization.
 *
 * A completed setup agent can leave a late child process behind after its
 * parent exits. If that process rewrites evidence while the workflow waits for
 * the component, the immutable server snapshot—not the late writer—remains the
 * authority. Finalization itself is still checked strictly after it runs.
 */
export async function restoreSetupEvidenceFromSnapshot(model_dir: string): Promise<string[]> {
  const lock_file = getSetupEvidenceLockFile(model_dir)
  const lock = await readFile(lock_file, "utf8")
    .then((text) => parseSetupEvidenceLock(JSON.parse(text) as unknown))
    .catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    })
  if (!lock) return []

  const current = await readCurrentSetupEvidence(model_dir).catch(() => [])
  const drift = getSetupEvidenceDrift(lock.files, comparableFiles(current))
  if (drift.length === 0) return []

  const snapshot_root = join(getLockRoot(model_dir), "setup-snapshot")
  const snapshot_files = await Promise.all(
    lock.files.map(async ({ file, sha256 }) => {
      const content = await readFile(join(snapshot_root, file))
      if (hashContent(content) !== sha256) {
        throw new Error(`The server-owned setup snapshot is corrupted at ${file}`)
      }
      return { file, content }
    }),
  )

  await rm(join(model_dir, "evidence"), { recursive: true, force: true })
  await Promise.all(
    snapshot_files.map(({ file, content }) => writeFileAtomically(join(model_dir, file), content)),
  )
  await verifySetupEvidenceLock(model_dir)
  return drift
}

export async function verifySetupEvidenceLock(model_dir: string): Promise<void> {
  const lock = parseSetupEvidenceLock(
    JSON.parse(await readFile(getSetupEvidenceLockFile(model_dir), "utf8")) as unknown,
  )
  const current = await readCurrentSetupEvidence(model_dir)
  const drift = getSetupEvidenceDrift(lock.files, comparableFiles(current))
  if (drift.length > 0) {
    throw new Error(
      `Benchmark finalization modified server-locked setup evidence; benchmark-draft.json, setup-complete.json, and evidence/ are immutable after setup. Changed files: ${drift.slice(0, 12).join(", ")}${
        drift.length > 12 ? `, and ${drift.length - 12} more` : ""
      }`,
    )
  }
}
