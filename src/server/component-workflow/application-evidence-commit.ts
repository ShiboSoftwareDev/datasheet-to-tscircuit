import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { isDeepStrictEqual } from "node:util"
import {
  compareApplicationGraphs,
  parseApplicationConnectivityReview,
} from "./application-connectivity-verification"
import {
  applicationDesignEvidenceSources,
  parseApplicationDesignEvidence,
} from "./application-design-evidence"
import { parseTypicalApplicationPlan } from "./application-plan"

const COMMIT_FILE = "application-evidence-commit.json"
const REVISIONS_DIRECTORY = "application-evidence-revisions"
const REQUIRED_JSON_FILES = [
  "typical-application-plan.json",
  "application-connectivity-review.json",
  "application-connectivity-verification.json",
  "application-evidence-image-manifest.json",
] as const
const OPTIONAL_JSON_FILES = ["application-design-evidence.json"] as const
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

declare const applicationEvidenceFilePathBrand: unique symbol
export type ApplicationEvidenceFilePath = string & {
  readonly [applicationEvidenceFilePathBrand]: true
}

export function applicationEvidenceFilePath(value: string): ApplicationEvidenceFilePath {
  if (!value || value.includes("\\") || value.split("/").some((part) => !part || part === "..")) {
    throw new Error(`Invalid application evidence file path: ${value}`)
  }
  return value as ApplicationEvidenceFilePath
}

type ApplicationEvidenceFiles = ReadonlyMap<ApplicationEvidenceFilePath, Uint8Array<ArrayBuffer>>

interface FileEntry {
  sha256: string
  size_bytes: number
}

interface ApplicationEvidenceManifest {
  version: 1
  schema_id: "application-evidence-commit/v1"
  generation_id: string
  evidence_directory: string
  committed_at: string
  source_pdf: FileEntry
  files: Record<string, FileEntry>
}

export interface CommittedApplicationEvidenceSnapshot {
  version: 1
  evidence_dir: string
  files: ApplicationEvidenceFiles
  source_pdf: Uint8Array<ArrayBuffer>
}

export interface ApplicationEvidenceCommitResult {
  status: "committed"
  commit_path: string
  evidence_dir: string
  generation_id: string
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function entry(bytes: Uint8Array): FileEntry {
  return { sha256: sha256(bytes), size_bytes: bytes.byteLength }
}

function safePath(root: string, relative_path: string): string {
  if (
    !relative_path ||
    relative_path.includes("\\") ||
    relative_path.split("/").some((part) => !part || part === "..")
  ) {
    throw new Error(`Invalid application evidence path: ${relative_path}`)
  }
  const path = resolve(root, relative_path)
  const from_root = relative(root, path)
  if (!from_root || from_root === ".." || from_root.startsWith(`..${sep}`)) {
    throw new Error(`Application evidence path escapes its root: ${relative_path}`)
  }
  return path
}

async function boundedFile(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_FILE_BYTES) {
    throw new Error(`Application evidence is not a bounded regular file: ${path}`)
  }
  return Uint8Array.from(await readFile(path))
}

async function candidatePaths(source_dir: string): Promise<ApplicationEvidenceFilePath[]> {
  const paths = REQUIRED_JSON_FILES.map(applicationEvidenceFilePath)
  for (const optional_path of OPTIONAL_JSON_FILES) {
    const path = join(source_dir, optional_path)
    const present = await lstat(path).then(
      (metadata) => metadata.isFile() && !metadata.isSymbolicLink(),
      () => false,
    )
    if (present) paths.push(applicationEvidenceFilePath(optional_path))
  }
  const raw_manifest: unknown = JSON.parse(
    await readFile(join(source_dir, "application-evidence-image-manifest.json"), "utf8"),
  )
  if (!isRecord(raw_manifest) || !Array.isArray(raw_manifest.pages) || !isRecord(raw_manifest.aliases)) {
    throw new Error("Application evidence image manifest is invalid")
  }
  const image_paths = raw_manifest.pages.flatMap((page) =>
    isRecord(page) && typeof page.image === "string" ? [applicationEvidenceFilePath(page.image)] : [],
  )
  const alias = raw_manifest.aliases.typical_application
  if (isRecord(alias) && typeof alias.image === "string") {
    image_paths.push(applicationEvidenceFilePath(alias.image))
  }
  paths.push(...image_paths)
  return paths.sort()
}

function parseJson(files: ApplicationEvidenceFiles, path: ApplicationEvidenceFilePath): unknown {
  const bytes = files.get(path)
  if (!bytes) throw new Error(`Committed application evidence is missing ${path}`)
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    return parsed
  } catch (error) {
    throw new Error(`Committed application evidence contains invalid JSON at ${path}`, { cause: error })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateCandidate(input: { files: ApplicationEvidenceFiles; source_pdf: Uint8Array }): void {
  const raw_plan = parseJson(input.files, applicationEvidenceFilePath("typical-application-plan.json"))
  const plan = parseTypicalApplicationPlan(raw_plan)
  if (!isDeepStrictEqual(raw_plan, plan)) {
    throw new Error("typical-application-plan.json is not canonical")
  }
  const raw_review = parseJson(
    input.files,
    applicationEvidenceFilePath("application-connectivity-review.json"),
  )
  const review = parseApplicationConnectivityReview(raw_review, plan)
  if (!isDeepStrictEqual(raw_review, review)) {
    throw new Error("application-connectivity-review.json is not canonical")
  }
  const raw_verification = parseJson(
    input.files,
    applicationEvidenceFilePath("application-connectivity-verification.json"),
  )
  if (!isRecord(raw_verification)) {
    throw new Error("application-connectivity-verification.json must be an object")
  }
  const { verifier_attempts, verifier_agent_duration_ms, ...deterministic_verification } = raw_verification
  if (
    verifier_attempts !== undefined &&
    (!Number.isInteger(verifier_attempts) || (verifier_attempts as number) < 1)
  ) {
    throw new Error("application connectivity verifier_attempts must be positive")
  }
  if (
    verifier_agent_duration_ms !== undefined &&
    (typeof verifier_agent_duration_ms !== "number" || verifier_agent_duration_ms < 0)
  ) {
    throw new Error("application connectivity verifier_agent_duration_ms must be nonnegative")
  }
  if (!isDeepStrictEqual(deterministic_verification, compareApplicationGraphs({ plan, review }))) {
    throw new Error("application connectivity verification does not match its independent graphs")
  }
  const image_manifest = parseJson(
    input.files,
    applicationEvidenceFilePath("application-evidence-image-manifest.json"),
  )
  if (!isRecord(image_manifest) || image_manifest.source_pdf_sha256 !== sha256(input.source_pdf)) {
    throw new Error("Application evidence image manifest is not bound to datasheet.pdf")
  }
  if (!Array.isArray(image_manifest.pages) || !isRecord(image_manifest.aliases)) {
    throw new Error("Application evidence image manifest is invalid")
  }
  const declared_images = new Set<ApplicationEvidenceFilePath>()
  const source_page_by_image = new Map<ApplicationEvidenceFilePath, number>()
  for (const page of image_manifest.pages) {
    if (
      !isRecord(page) ||
      !Number.isInteger(page.page) ||
      typeof page.image !== "string" ||
      typeof page.sha256 !== "string"
    ) {
      throw new Error("Application evidence image manifest contains an invalid page")
    }
    const image_path = applicationEvidenceFilePath(page.image)
    const bytes = input.files.get(image_path)
    if (!bytes || sha256(bytes) !== page.sha256 || bytes.byteLength !== page.size_bytes) {
      throw new Error(`Application evidence image changed after rendering: ${page.image}`)
    }
    declared_images.add(image_path)
    source_page_by_image.set(image_path, page.page as number)
  }
  const alias = image_manifest.aliases.typical_application
  if (plan.availability === "documented") {
    if (!isRecord(alias) || alias.image !== "visual-reference/typical-application.png") {
      throw new Error("Documented application evidence is missing its trusted image alias")
    }
    const alias_path = applicationEvidenceFilePath(alias.image)
    const bytes = input.files.get(alias_path)
    if (!bytes || sha256(bytes) !== alias.sha256) {
      throw new Error("Typical-application image alias changed after rendering")
    }
    declared_images.add(alias_path)
    if (Number.isInteger(alias.page)) source_page_by_image.set(alias_path, alias.page as number)
  } else if (alias !== undefined) {
    throw new Error("Not-present application evidence must not contain an image alias")
  }
  const actual_images = [...input.files.keys()].filter((path) => path.startsWith("visual-reference/"))
  if ([...declared_images].sort().join("\0") !== actual_images.sort().join("\0")) {
    throw new Error("Application evidence image manifest does not enumerate every image")
  }
  const application_sources = [
    ...plan.source_references,
    ...plan.components.flatMap((component) => [
      ...(component.source_references ?? []),
      ...(component.footprint_source_references ?? []),
    ]),
  ]
  const design_evidence_path = applicationEvidenceFilePath("application-design-evidence.json")
  const raw_design_evidence = input.files.has(design_evidence_path)
    ? parseJson(input.files, design_evidence_path)
    : undefined
  const design_evidence =
    raw_design_evidence === undefined ? undefined : parseApplicationDesignEvidence(raw_design_evidence)
  if (design_evidence && !isDeepStrictEqual(raw_design_evidence, design_evidence)) {
    throw new Error("application-design-evidence.json is not canonical")
  }
  for (const source of application_sources) {
    if (!source.image) continue
    const source_image_path = applicationEvidenceFilePath(source.image)
    if (!declared_images.has(source_image_path)) {
      throw new Error(`Application evidence cites an image outside its manifest: ${source.image}`)
    }
    if (source_page_by_image.get(source_image_path) !== source.page) {
      throw new Error(
        `Application evidence page ${source.page} cites an image rendered from a different page`,
      )
    }
  }
  for (const source of design_evidence ? applicationDesignEvidenceSources(design_evidence) : []) {
    if (!source.image) continue
    const source_image_path = applicationEvidenceFilePath(source.image)
    if (!declared_images.has(source_image_path)) {
      throw new Error(`Application design evidence cites an image outside its manifest: ${source.image}`)
    }
    if (source_page_by_image.get(source_image_path) !== source.page) {
      throw new Error(
        `Application design evidence page ${source.page} cites an image rendered from a different page`,
      )
    }
  }
}

async function readCandidate(source_dir: string): Promise<{
  files: ApplicationEvidenceFiles
  source_pdf: Uint8Array<ArrayBuffer>
}> {
  const files = new Map<ApplicationEvidenceFilePath, Uint8Array<ArrayBuffer>>()
  let total_bytes = 0
  for (const relative_path of await candidatePaths(source_dir)) {
    const bytes = await boundedFile(safePath(source_dir, relative_path))
    total_bytes += bytes.byteLength
    if (total_bytes > MAX_TOTAL_BYTES) throw new Error("Application evidence exceeds its size limit")
    files.set(relative_path, bytes)
  }
  const source_pdf = await boundedFile(join(source_dir, "datasheet.pdf"))
  validateCandidate({ files, source_pdf })
  return { files, source_pdf }
}

export async function writeApplicationEvidenceCommit(input: {
  source_dir: string
  destination_root: string
  signal?: AbortSignal
}): Promise<ApplicationEvidenceCommitResult> {
  const candidate = await readCandidate(input.source_dir)
  input.signal?.throwIfAborted()
  const generation_id = randomUUID()
  const evidence_directory = `${REVISIONS_DIRECTORY}/${generation_id}`
  const evidence_dir = join(input.destination_root, evidence_directory)
  const temporary_path = join(input.destination_root, `.${COMMIT_FILE}.${randomUUID()}.tmp`)
  await mkdir(evidence_dir, { recursive: true })
  try {
    await Promise.all([
      Bun.write(join(evidence_dir, "datasheet.pdf"), candidate.source_pdf),
      ...[...candidate.files].map(async ([relative_path, bytes]) => {
        const destination = safePath(evidence_dir, relative_path)
        await mkdir(dirname(destination), { recursive: true })
        await Bun.write(destination, bytes)
      }),
    ])
    input.signal?.throwIfAborted()
    const manifest: ApplicationEvidenceManifest = {
      version: 1,
      schema_id: "application-evidence-commit/v1",
      generation_id,
      evidence_directory,
      committed_at: new Date().toISOString(),
      source_pdf: entry(candidate.source_pdf),
      files: Object.fromEntries([...candidate.files].map(([path, bytes]) => [path, entry(bytes)])),
    }
    await Bun.write(temporary_path, `${JSON.stringify(manifest, null, 2)}\n`)
    input.signal?.throwIfAborted()
    await rename(temporary_path, join(input.destination_root, COMMIT_FILE))
    return {
      status: "committed",
      commit_path: join(input.destination_root, COMMIT_FILE),
      evidence_dir,
      generation_id,
    }
  } catch (error) {
    await Promise.all([
      rm(evidence_dir, { recursive: true, force: true }).catch(() => undefined),
      rm(temporary_path, { force: true }).catch(() => undefined),
    ])
    throw error
  }
}

export async function readCommittedApplicationEvidenceSnapshot(
  job_dir: string,
): Promise<CommittedApplicationEvidenceSnapshot | undefined> {
  const marker_path = join(job_dir, COMMIT_FILE)
  if (!(await Bun.file(marker_path).exists())) return undefined
  const raw: unknown = JSON.parse(await readFile(marker_path, "utf8"))
  if (
    !isRecord(raw) ||
    raw.version !== 1 ||
    raw.schema_id !== "application-evidence-commit/v1" ||
    typeof raw.evidence_directory !== "string" ||
    !isRecord(raw.files) ||
    !isRecord(raw.source_pdf)
  ) {
    throw new Error("application-evidence-commit.json is invalid")
  }
  const evidence_dir = safePath(job_dir, raw.evidence_directory)
  const files = new Map<ApplicationEvidenceFilePath, Uint8Array<ArrayBuffer>>()
  for (const [path, raw_entry] of Object.entries(raw.files)) {
    if (
      !isRecord(raw_entry) ||
      typeof raw_entry.sha256 !== "string" ||
      typeof raw_entry.size_bytes !== "number"
    ) {
      throw new Error(`application-evidence-commit.json has an invalid entry for ${path}`)
    }
    const evidence_path = applicationEvidenceFilePath(path)
    const bytes = await boundedFile(safePath(evidence_dir, evidence_path))
    if (sha256(bytes) !== raw_entry.sha256 || bytes.byteLength !== raw_entry.size_bytes) {
      throw new Error(`Committed application evidence integrity check failed for ${path}`)
    }
    files.set(evidence_path, bytes)
  }
  const source_pdf = await boundedFile(join(evidence_dir, "datasheet.pdf"))
  if (sha256(source_pdf) !== raw.source_pdf.sha256 || source_pdf.byteLength !== raw.source_pdf.size_bytes) {
    throw new Error("Committed application evidence integrity check failed for datasheet.pdf")
  }
  validateCandidate({ files, source_pdf })
  return { version: 1, evidence_dir, files, source_pdf }
}

export async function hasCommittedApplicationEvidence(job_dir: string): Promise<boolean> {
  try {
    return (await readCommittedApplicationEvidenceSnapshot(job_dir)) !== undefined
  } catch {
    return false
  }
}
