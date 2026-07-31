import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir, rename, rm } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

const EVIDENCE_COMMIT_FILE = "evidence-commit.json"
const EVIDENCE_JSON_FILES = [
  "component-evidence.json",
  "footprint-plan.json",
  "component-schematic-plan.json",
  "typical-application-plan.json",
] as const
const REQUIRED_EVIDENCE_FILES = new Set<string>([...EVIDENCE_JSON_FILES, "visual-reference/land-pattern.png"])

interface EvidenceCommitEntry {
  sha256: string
  size_bytes: number
}

interface EvidenceCommitManifest {
  version: 1
  committed_at: string
  files: Record<string, EvidenceCommitEntry>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function resolveEvidencePath(job_dir: string, relative_path: string): string {
  if (
    !relative_path ||
    relative_path.includes("\\") ||
    isAbsolute(relative_path) ||
    relative_path.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error(`Invalid evidence commit path: ${relative_path}`)
  }
  const path = resolve(job_dir, relative_path)
  const from_job = relative(job_dir, path)
  if (!from_job || from_job === ".." || from_job.startsWith(`..${sep}`) || isAbsolute(from_job)) {
    throw new Error(`Evidence commit path escapes the job directory: ${relative_path}`)
  }
  return path
}

async function readCommittedFile(job_dir: string, relative_path: string): Promise<Uint8Array> {
  const path = resolveEvidencePath(job_dir, relative_path)
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Committed evidence is not a regular file: ${relative_path}`)
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error(`Committed evidence changed while opening: ${relative_path}`)
    }
    return new Uint8Array(await handle.readFile())
  } finally {
    await handle.close()
  }
}

async function listVisualReferences(job_dir: string): Promise<string[]> {
  const root = join(job_dir, "visual-reference")
  const root_metadata = await lstat(root)
  if (!root_metadata.isDirectory() || root_metadata.isSymbolicLink()) {
    throw new Error("Committed evidence visual-reference must be a real directory")
  }
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) throw new Error(`Evidence contains a symlink: ${path}`)
      if (metadata.isDirectory()) {
        await visit(path)
      } else if (metadata.isFile()) {
        files.push(relative(job_dir, path).replaceAll("\\", "/"))
      } else {
        throw new Error(`Evidence contains a special file: ${path}`)
      }
    }
  }
  await visit(root)
  return files.sort()
}

async function evidenceFilePaths(job_dir: string): Promise<string[]> {
  return [...EVIDENCE_JSON_FILES, ...(await listVisualReferences(job_dir))].sort()
}

function hashEntry(bytes: Uint8Array): EvidenceCommitEntry {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size_bytes: bytes.byteLength,
  }
}

export async function clearEvidenceCommit(job_dir: string): Promise<void> {
  await rm(join(job_dir, EVIDENCE_COMMIT_FILE), { force: true })
}

export async function writeEvidenceCommit(job_dir: string): Promise<string> {
  const files: Record<string, EvidenceCommitEntry> = {}
  for (const relative_path of await evidenceFilePaths(job_dir)) {
    files[relative_path] = hashEntry(await readCommittedFile(job_dir, relative_path))
  }
  for (const required of REQUIRED_EVIDENCE_FILES) {
    if (!files[required]) throw new Error(`Evidence commit is missing required file ${required}`)
  }
  const manifest: EvidenceCommitManifest = {
    version: 1,
    committed_at: new Date().toISOString(),
    files,
  }
  const commit_path = join(job_dir, EVIDENCE_COMMIT_FILE)
  const temporary_path = join(job_dir, `.${EVIDENCE_COMMIT_FILE}.${crypto.randomUUID()}.tmp`)
  try {
    await Bun.write(temporary_path, `${JSON.stringify(manifest, null, 2)}\n`)
    await rename(temporary_path, commit_path)
  } finally {
    await rm(temporary_path, { force: true })
  }
  return commit_path
}

export async function hasCommittedEvidence(job_dir: string): Promise<boolean> {
  try {
    const value: unknown = await Bun.file(join(job_dir, EVIDENCE_COMMIT_FILE)).json()
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.files)) return false
    const actual_paths = await evidenceFilePaths(job_dir)
    const committed_paths = Object.keys(value.files).sort()
    if (actual_paths.join("\0") !== committed_paths.join("\0")) return false
    for (const required of REQUIRED_EVIDENCE_FILES) {
      if (!committed_paths.includes(required)) return false
    }
    for (const relative_path of committed_paths) {
      const entry = value.files[relative_path]
      if (
        !isRecord(entry) ||
        typeof entry.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !Number.isInteger(entry.size_bytes) ||
        (entry.size_bytes as number) < 0
      ) {
        return false
      }
      const bytes = await readCommittedFile(job_dir, relative_path)
      const actual = hashEntry(bytes)
      if (actual.size_bytes !== entry.size_bytes || actual.sha256 !== entry.sha256) return false
    }
    return true
  } catch {
    return false
  }
}
