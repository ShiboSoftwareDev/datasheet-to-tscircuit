import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, opendir, realpath, rename, rm } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { isDeepStrictEqual } from "node:util"
import {
  createFootprintPlanFromEvidence,
  getDefaultFootprint,
  getComponentEvidenceBlockingReasons,
  getFootprintEvidenceErrors,
  parseComponentFootprintCatalog,
  parseComponentEvidence,
  type ComponentEvidence,
  type ComponentFootprintCatalog,
  type EvidenceSource,
} from "../component-evidence"
import { createComponentSchematicPlan } from "../component-schematic-plan"
import { createStageWorkspace, promoteStageDirectory, validatePngArtifact } from "../infrastructure/artifacts"
import {
  compareApplicationGraphs,
  parseApplicationConnectivityReview,
} from "./application-connectivity-verification"
import {
  applicationTargetIdentityFromEvidence,
  parseTypicalApplicationPlan,
  type ApplicationSourceReference,
  type TypicalApplicationPlan,
} from "./application-plan"
import { parseEvidenceImageManifest } from "./evidence-image-materialization"
import { compareFootprintGeometry, parseFootprintGeometryReview } from "./footprint-geometry-verification"

const EVIDENCE_COMMIT_FILE = "evidence-commit.json"
const EVIDENCE_COMMIT_SCHEMA_ID = "evidence-commit/v2" as const
const EVIDENCE_PUBLICATION_SCHEMA_ID = "evidence-commit/v3" as const
const EVIDENCE_REVISIONS_DIRECTORY = "evidence-revisions"
const GENERATION_ID_PATTERN = /^[a-f0-9-]{16,80}$/
const LEGACY_EVIDENCE_JSON_FILES = [
  "component-evidence.json",
  "footprint-plan.json",
  "component-schematic-plan.json",
  "typical-application-plan.json",
] as const
const LEGACY_OPTIONAL_EVIDENCE_JSON_FILES = ["application-connectivity-verification.json"] as const
const COMPONENT_EVIDENCE_JSON_FILES = [
  "component-evidence.json",
  "footprint-plan.json",
  "component-schematic-plan.json",
  "footprint-geometry-review.json",
  "footprint-geometry-verification.json",
  "evidence-image-manifest.json",
] as const
const COMPONENT_OPTIONAL_EVIDENCE_JSON_FILES = ["component-footprint-catalog.json"] as const
const APPLICATION_EVIDENCE_JSON_FILES = [
  "typical-application-plan.json",
  "application-connectivity-review.json",
  "application-connectivity-verification.json",
] as const
const V2_EVIDENCE_JSON_FILES = [...COMPONENT_EVIDENCE_JSON_FILES, ...APPLICATION_EVIDENCE_JSON_FILES] as const
const LEGACY_REQUIRED_EVIDENCE_FILES = new Set<string>([
  ...LEGACY_EVIDENCE_JSON_FILES,
  "visual-reference/land-pattern.png",
])
const V2_REQUIRED_EVIDENCE_FILES = new Set<string>([
  ...COMPONENT_EVIDENCE_JSON_FILES,
  "visual-reference/land-pattern.png",
])
const MAX_COMMIT_BYTES = 2 * 1024 * 1024
const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_JSON_DEPTH = 48
const MAX_JSON_NODES = 100_000
const MAX_EVIDENCE_FILE_BYTES = 32 * 1024 * 1024
const MAX_EVIDENCE_TOTAL_BYTES = 64 * 1024 * 1024
const MAX_EVIDENCE_FILES = 128
const MAX_EVIDENCE_DIRECTORY_ENTRIES = 256
const MAX_EVIDENCE_DIRECTORY_DEPTH = 16

interface EvidenceCommitEntry {
  sha256: string
  size_bytes: number
}

interface LegacyEvidenceCommitManifest {
  version: 1
  committed_at: string
  files: Record<string, EvidenceCommitEntry>
}

interface EvidenceCommitManifestV2 {
  version: 2
  schema_id: typeof EVIDENCE_COMMIT_SCHEMA_ID
  committed_at: string
  files: Record<string, EvidenceCommitEntry>
}

interface EvidenceCommitManifestV3 {
  version: 3
  schema_id: typeof EVIDENCE_PUBLICATION_SCHEMA_ID
  generation_id: string
  evidence_directory: string
  committed_at: string
  source_pdf: EvidenceCommitEntry
  files: Record<string, EvidenceCommitEntry>
}

type EvidenceCommitManifest =
  | LegacyEvidenceCommitManifest
  | EvidenceCommitManifestV2
  | EvidenceCommitManifestV3

export interface PreparedEvidencePublication {
  readonly job_dir: string
  readonly revision_dir: string
  readonly manifest: EvidenceCommitManifestV3
}

export interface EvidenceCommitResult {
  status: "committed"
  version: 3
  commit_path: string
  evidence_dir: string
  generation_id: string
  committed_at: string
  file_count: number
  manifest_sha256: string
  durability: "directory_synced" | "rename_visible"
  durability_warning?: string
}

export type CommittedEvidenceSnapshot =
  | {
      version: 1
      files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>
    }
  | {
      version: 2
      files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>
      /** Datasheet bytes hashed by evidence-image-manifest.json in this generation. */
      source_pdf: Uint8Array<ArrayBuffer>
    }
  | {
      version: 3
      files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>
      /** Exact PDF bytes stored inside the immutable evidence revision. */
      source_pdf: Uint8Array<ArrayBuffer>
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
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

async function readCommittedFile(
  job_dir: string,
  relative_path: string,
  max_bytes = MAX_EVIDENCE_FILE_BYTES,
): Promise<Uint8Array<ArrayBuffer>> {
  const path = resolveEvidencePath(job_dir, relative_path)
  const [job_real_path, file_real_path] = await Promise.all([realpath(job_dir), realpath(path)])
  const real_relative_path = relative(job_real_path, file_real_path)
  if (
    !real_relative_path ||
    real_relative_path === ".." ||
    real_relative_path.startsWith(`..${sep}`) ||
    isAbsolute(real_relative_path)
  ) {
    throw new Error(`Committed evidence resolves outside the job directory: ${relative_path}`)
  }
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Committed evidence is not a regular file: ${relative_path}`)
  }
  if (metadata.size > max_bytes) {
    throw new Error(`Committed evidence exceeds the ${max_bytes}-byte limit: ${relative_path}`)
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new Error(`Committed evidence changed while opening: ${relative_path}`)
    }
    if (opened.size > max_bytes) {
      throw new Error(`Committed evidence exceeds the ${max_bytes}-byte limit: ${relative_path}`)
    }
    const buffer = Buffer.allocUnsafe(opened.size + 1)
    let bytes_read = 0
    while (bytes_read < buffer.byteLength) {
      const result = await handle.read(buffer, bytes_read, buffer.byteLength - bytes_read, bytes_read)
      if (result.bytesRead === 0) break
      bytes_read += result.bytesRead
    }
    if (bytes_read !== opened.size) {
      throw new Error(`Committed evidence changed while reading: ${relative_path}`)
    }
    return Uint8Array.from(buffer.subarray(0, bytes_read))
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
  let entries_seen = 0
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_EVIDENCE_DIRECTORY_DEPTH) {
      throw new Error(`Evidence directory exceeds the ${MAX_EVIDENCE_DIRECTORY_DEPTH}-level depth limit`)
    }
    const entries = []
    const handle = await opendir(directory)
    for await (const entry of handle) {
      entries_seen += 1
      if (entries_seen > MAX_EVIDENCE_DIRECTORY_ENTRIES) {
        throw new Error(`Evidence directory contains more than ${MAX_EVIDENCE_DIRECTORY_ENTRIES} entries`)
      }
      entries.push(entry)
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) throw new Error(`Evidence contains a symlink: ${path}`)
      if (metadata.isDirectory()) {
        await visit(path, depth + 1)
      } else if (metadata.isFile()) {
        files.push(relative(job_dir, path).replaceAll("\\", "/"))
      } else {
        throw new Error(`Evidence contains a special file: ${path}`)
      }
      if (files.length > MAX_EVIDENCE_FILES) {
        throw new Error(`Evidence contains more than ${MAX_EVIDENCE_FILES} files`)
      }
    }
  }
  await visit(root, 1)
  return files.sort()
}

async function evidenceFilePaths(
  job_dir: string,
  version: 1 | 2,
  committed_paths: readonly string[] = [],
): Promise<string[]> {
  const committed_legacy_optional = LEGACY_OPTIONAL_EVIDENCE_JSON_FILES.filter((path) =>
    committed_paths.includes(path),
  )
  let json_paths: string[]
  if (version === 1) {
    json_paths = [...LEGACY_EVIDENCE_JSON_FILES, ...committed_legacy_optional]
  } else {
    const application_presence = await Promise.all(
      APPLICATION_EVIDENCE_JSON_FILES.map(async (path) =>
        committed_paths.length > 0
          ? committed_paths.includes(path)
          : await lstat(join(job_dir, path)).then(
              (metadata) => metadata.isFile() && !metadata.isSymbolicLink(),
              () => false,
            ),
      ),
    )
    if (application_presence.some(Boolean) && !application_presence.every(Boolean)) {
      throw new Error("Application evidence files must be committed as one complete set")
    }
    const optional_component_paths = COMPONENT_OPTIONAL_EVIDENCE_JSON_FILES.filter((path) =>
      committed_paths.length > 0 ? committed_paths.includes(path) : false,
    )
    if (committed_paths.length === 0) {
      const optional_presence = await Promise.all(
        COMPONENT_OPTIONAL_EVIDENCE_JSON_FILES.map(async (path) =>
          lstat(join(job_dir, path)).then(
            (metadata) => metadata.isFile() && !metadata.isSymbolicLink(),
            () => false,
          ),
        ),
      )
      for (const [index, present] of optional_presence.entries()) {
        if (present) optional_component_paths.push(COMPONENT_OPTIONAL_EVIDENCE_JSON_FILES[index]!)
      }
    }
    json_paths = [
      ...COMPONENT_EVIDENCE_JSON_FILES,
      ...optional_component_paths,
      ...(application_presence.every(Boolean) ? APPLICATION_EVIDENCE_JSON_FILES : []),
    ]
  }
  const paths = [...json_paths, ...(await listVisualReferences(job_dir))].sort()
  if (paths.length > MAX_EVIDENCE_FILES) {
    throw new Error(`Evidence contains more than ${MAX_EVIDENCE_FILES} files`)
  }
  return paths
}

function hashEntry(bytes: Uint8Array): EvidenceCommitEntry {
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size_bytes: bytes.byteLength,
  }
}

function parseJsonBytes(files: ReadonlyMap<string, Uint8Array>, relative_path: string): unknown {
  const bytes = files.get(relative_path)
  if (!bytes) throw new Error(`Committed evidence is missing ${relative_path}`)
  if (bytes.byteLength > MAX_JSON_BYTES) {
    throw new Error(`${relative_path} exceeds the ${MAX_JSON_BYTES}-byte JSON limit`)
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
  } catch (error) {
    throw new Error(
      `${relative_path} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    nodes += 1
    if (nodes > MAX_JSON_NODES) {
      throw new Error(`${relative_path} exceeds the ${MAX_JSON_NODES}-node JSON limit`)
    }
    if (current.depth > MAX_JSON_DEPTH) {
      throw new Error(`${relative_path} exceeds the ${MAX_JSON_DEPTH}-level JSON depth limit`)
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) {
        pending.push({ value: child, depth: current.depth + 1 })
      }
    } else if (isRecord(current.value)) {
      for (const child of Object.values(current.value)) {
        pending.push({ value: child, depth: current.depth + 1 })
      }
    }
  }
  return value
}

function componentSources(evidence: ComponentEvidence): EvidenceSource[] {
  return [
    ...evidence.part_number.sources,
    ...(evidence.ordering_code?.sources ?? []),
    ...evidence.package.name.sources,
    ...(evidence.package.code?.sources ?? []),
    ...evidence.package.pin_count.sources,
    ...evidence.pinout.pins.flatMap(({ sources }) => sources),
    ...evidence.footprint.drawing_orientation.sources,
    ...evidence.footprint.pads.flatMap(({ sources }) => sources),
  ]
}

function applicationSources(plan: TypicalApplicationPlan): ApplicationSourceReference[] {
  return [
    ...plan.source_references,
    ...plan.components.flatMap((component) => [
      ...(component.source_references ?? []),
      ...(component.footprint_source_references ?? []),
    ]),
  ]
}

async function validateEvidenceImageManifest(input: {
  job_dir: string
  files: ReadonlyMap<string, Uint8Array>
  component_evidence: ComponentEvidence
  component_footprint_catalog?: ComponentFootprintCatalog
  application_plan?: TypicalApplicationPlan
  source_pdf?: Uint8Array<ArrayBuffer>
}): Promise<Uint8Array<ArrayBuffer>> {
  const raw_manifest = parseJsonBytes(input.files, "evidence-image-manifest.json")
  const manifest = parseEvidenceImageManifest(raw_manifest)
  if (!isDeepStrictEqual(raw_manifest, manifest)) {
    throw new Error("evidence-image-manifest.json is not in canonical version-1 form")
  }
  const expected_application_alias = input.application_plan?.availability === "documented"
  if (Boolean(manifest.aliases.typical_application) !== expected_application_alias) {
    throw new Error(
      expected_application_alias
        ? "Documented application evidence is missing its server-rendered image alias"
        : "Not-present application evidence must not contain a typical-application image alias",
    )
  }
  const source_pdf = input.source_pdf ?? (await readCommittedFile(input.job_dir, "datasheet.pdf"))
  if (hashEntry(source_pdf).sha256 !== manifest.source_pdf_sha256) {
    throw new Error("Evidence image manifest is bound to a different datasheet.pdf")
  }
  const declared_images = new Set<string>()
  const source_page_by_image = new Map<string, number>()
  for (const page of manifest.pages) {
    const bytes = input.files.get(page.image)
    if (!bytes) throw new Error(`evidence-image-manifest.json references a missing PNG: ${page.image}`)
    validatePngArtifact({ relative_path: page.image, size_bytes: bytes.byteLength, bytes })
    const actual = hashEntry(bytes)
    if (actual.sha256 !== page.sha256 || actual.size_bytes !== page.size_bytes) {
      throw new Error(`Server-rendered evidence page changed after rendering: ${page.image}`)
    }
    declared_images.add(page.image)
    source_page_by_image.set(page.image, page.page)
  }
  for (const alias of [manifest.aliases.land_pattern, manifest.aliases.typical_application]) {
    if (!alias) continue
    const bytes = input.files.get(alias.image)
    if (!bytes) throw new Error(`Evidence image alias is missing: ${alias.image}`)
    validatePngArtifact({ relative_path: alias.image, size_bytes: bytes.byteLength, bytes })
    if (hashEntry(bytes).sha256 !== alias.sha256) {
      throw new Error(`Evidence image alias does not match its rendered PDF page: ${alias.image}`)
    }
    declared_images.add(alias.image)
    source_page_by_image.set(alias.image, alias.page)
  }

  const committed_images = [...input.files.keys()]
    .filter((path) => path.startsWith("visual-reference/"))
    .sort()
  if ([...declared_images].sort().join("\0") !== committed_images.join("\0")) {
    throw new Error("evidence-image-manifest.json does not enumerate every committed evidence image")
  }
  const catalog_evidence = input.component_footprint_catalog?.footprints.map(
    (footprint) => footprint.component_evidence,
  ) ?? [input.component_evidence]
  for (const source of [
    ...catalog_evidence.flatMap(componentSources),
    ...(input.application_plan ? applicationSources(input.application_plan) : []),
  ]) {
    if (!source.image) continue
    if (!declared_images.has(source.image)) {
      throw new Error(`Evidence source cites an image outside the image manifest: ${source.image}`)
    }
    const rendered_page = source_page_by_image.get(source.image)
    if (rendered_page !== source.page) {
      throw new Error(
        `Evidence source page ${source.page} cites ${source.image}, which renders PDF page ${rendered_page ?? "unknown"}`,
      )
    }
  }
  return source_pdf
}

async function validateV2Evidence(
  job_dir: string,
  files: ReadonlyMap<string, Uint8Array>,
  source_pdf?: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const raw_component = parseJsonBytes(files, "component-evidence.json")
  const component_evidence = parseComponentEvidence(raw_component)
  if (!isDeepStrictEqual(raw_component, component_evidence)) {
    throw new Error("component-evidence.json is not in canonical version-1 form")
  }

  const derived_footprint_plan = createFootprintPlanFromEvidence(component_evidence)
  const blocking_reasons = [
    ...getComponentEvidenceBlockingReasons(component_evidence),
    ...getFootprintEvidenceErrors(component_evidence, derived_footprint_plan),
  ]
  if (blocking_reasons.length > 0) {
    throw new Error(`Committed component evidence is not publishable: ${blocking_reasons.join("; ")}`)
  }

  let component_footprint_catalog: ComponentFootprintCatalog | undefined
  if (files.has("component-footprint-catalog.json")) {
    const raw_catalog = parseJsonBytes(files, "component-footprint-catalog.json")
    component_footprint_catalog = parseComponentFootprintCatalog(raw_catalog)
    if (!isDeepStrictEqual(raw_catalog, component_footprint_catalog)) {
      throw new Error("component-footprint-catalog.json is not in canonical version-1 form")
    }
    if (
      !isDeepStrictEqual(
        getDefaultFootprint(component_footprint_catalog).component_evidence,
        component_evidence,
      )
    ) {
      throw new Error("component-evidence.json must be the default footprint catalog projection")
    }
    for (const footprint of component_footprint_catalog.footprints) {
      const plan = createFootprintPlanFromEvidence(footprint.component_evidence)
      const variant_blocking = [
        ...getComponentEvidenceBlockingReasons(footprint.component_evidence),
        ...getFootprintEvidenceErrors(footprint.component_evidence, plan),
      ]
      if (variant_blocking.length > 0) {
        throw new Error(
          `Committed footprint ${footprint.footprint_id} is not publishable: ${variant_blocking.join("; ")}`,
        )
      }
    }
  }

  const raw_footprint_plan = parseJsonBytes(files, "footprint-plan.json")
  if (!isDeepStrictEqual(raw_footprint_plan, derived_footprint_plan)) {
    throw new Error("footprint-plan.json does not derive from component-evidence.json")
  }
  const raw_schematic_plan = parseJsonBytes(files, "component-schematic-plan.json")
  if (!isDeepStrictEqual(raw_schematic_plan, createComponentSchematicPlan(component_evidence))) {
    throw new Error("component-schematic-plan.json does not derive from component-evidence.json")
  }

  const raw_footprint_review = parseJsonBytes(files, "footprint-geometry-review.json")
  const footprint_review = parseFootprintGeometryReview(raw_footprint_review, component_evidence)
  if (!isDeepStrictEqual(raw_footprint_review, footprint_review)) {
    throw new Error("footprint-geometry-review.json is not in canonical version-1 form")
  }
  const raw_footprint_agreement = parseJsonBytes(files, "footprint-geometry-verification.json")
  if (!isRecord(raw_footprint_agreement)) {
    throw new Error("footprint-geometry-verification.json must be an object")
  }
  const {
    verifier_attempts: footprint_verifier_attempts,
    verifier_agent_duration_ms: footprint_verifier_agent_duration_ms,
    ...deterministic_footprint_agreement
  } = raw_footprint_agreement
  if (
    footprint_verifier_attempts !== undefined &&
    (!Number.isInteger(footprint_verifier_attempts) || (footprint_verifier_attempts as number) < 1)
  ) {
    throw new Error("footprint-geometry-verification.json verifier_attempts must be positive")
  }
  if (
    footprint_verifier_agent_duration_ms !== undefined &&
    (typeof footprint_verifier_agent_duration_ms !== "number" ||
      !Number.isFinite(footprint_verifier_agent_duration_ms) ||
      footprint_verifier_agent_duration_ms < 0)
  ) {
    throw new Error("footprint-geometry-verification.json verifier_agent_duration_ms must be nonnegative")
  }
  const expected_footprint_agreement = compareFootprintGeometry({
    evidence: component_evidence,
    review: footprint_review,
  })
  if (!isDeepStrictEqual(deterministic_footprint_agreement, expected_footprint_agreement)) {
    throw new Error("footprint-geometry-verification.json does not match the committed independent geometry")
  }

  let application_plan: TypicalApplicationPlan | undefined
  if (files.has("typical-application-plan.json")) {
    const raw_application = parseJsonBytes(files, "typical-application-plan.json")
    application_plan = parseTypicalApplicationPlan(
      raw_application,
      applicationTargetIdentityFromEvidence(component_evidence),
    )
    if (!isDeepStrictEqual(raw_application, application_plan)) {
      throw new Error("typical-application-plan.json is not in canonical version-4 form")
    }
    const raw_review = parseJsonBytes(files, "application-connectivity-review.json")
    const raw_agreement = parseJsonBytes(files, "application-connectivity-verification.json")
    const review = parseApplicationConnectivityReview(raw_review, application_plan)
    if (!isDeepStrictEqual(raw_review, review)) {
      throw new Error("application-connectivity-review.json is not in canonical version-1 form")
    }
    const expected_agreement = compareApplicationGraphs({
      plan: application_plan,
      review,
      evidence: component_evidence,
    })
    if (!isRecord(raw_agreement)) {
      throw new Error("application-connectivity-verification.json must be an object")
    }
    const { verifier_attempts, verifier_agent_duration_ms, ...deterministic_agreement } = raw_agreement
    if (
      verifier_attempts !== undefined &&
      (!Number.isInteger(verifier_attempts) || (verifier_attempts as number) < 1)
    ) {
      throw new Error("application-connectivity-verification.json verifier_attempts must be positive")
    }
    if (
      verifier_agent_duration_ms !== undefined &&
      (typeof verifier_agent_duration_ms !== "number" ||
        !Number.isFinite(verifier_agent_duration_ms) ||
        verifier_agent_duration_ms < 0)
    ) {
      throw new Error(
        "application-connectivity-verification.json verifier_agent_duration_ms must be nonnegative",
      )
    }
    if (!isDeepStrictEqual(deterministic_agreement, expected_agreement)) {
      throw new Error(
        "application-connectivity-verification.json does not match the committed application graphs",
      )
    }
  }

  return validateEvidenceImageManifest({
    job_dir,
    files,
    component_evidence,
    ...(component_footprint_catalog ? { component_footprint_catalog } : {}),
    ...(application_plan ? { application_plan } : {}),
    source_pdf,
  })
}

function isCommitEntry(value: unknown): value is EvidenceCommitEntry {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join("\0") === "sha256\0size_bytes" &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.size_bytes) &&
    (value.size_bytes as number) >= 0 &&
    (value.size_bytes as number) <= MAX_EVIDENCE_FILE_BYTES
  )
}

function parseCommitManifest(value: unknown): EvidenceCommitManifest {
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
    typeof value.committed_at !== "string" ||
    !Number.isFinite(Date.parse(value.committed_at)) ||
    !isRecord(value.files)
  ) {
    throw new Error("evidence-commit.json has an invalid manifest envelope")
  }
  if (value.version === 2 && value.schema_id !== EVIDENCE_COMMIT_SCHEMA_ID) {
    throw new Error(`evidence-commit.json must use schema ${EVIDENCE_COMMIT_SCHEMA_ID}`)
  }
  if (value.version === 3) {
    const expected_keys = [
      "committed_at",
      "evidence_directory",
      "files",
      "generation_id",
      "schema_id",
      "source_pdf",
      "version",
    ].sort()
    if (Object.keys(value).sort().join("\0") !== expected_keys.join("\0")) {
      throw new Error("evidence-commit.json version 3 contains unexpected or missing fields")
    }
    if (value.schema_id !== EVIDENCE_PUBLICATION_SCHEMA_ID) {
      throw new Error(`evidence-commit.json must use schema ${EVIDENCE_PUBLICATION_SCHEMA_ID}`)
    }
    if (typeof value.generation_id !== "string" || !GENERATION_ID_PATTERN.test(value.generation_id)) {
      throw new Error("evidence-commit.json generation_id is invalid")
    }
    if (
      typeof value.evidence_directory !== "string" ||
      value.evidence_directory !== `${EVIDENCE_REVISIONS_DIRECTORY}/${value.generation_id}`
    ) {
      throw new Error("evidence-commit.json evidence_directory does not match its generation")
    }
    if (!isCommitEntry(value.source_pdf)) {
      throw new Error("evidence-commit.json source_pdf entry is invalid")
    }
  }
  return value as unknown as EvidenceCommitManifest
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

async function readCurrentCommitMarker(job_dir: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
  try {
    return await readCommittedFile(job_dir, EVIDENCE_COMMIT_FILE, MAX_COMMIT_BYTES)
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return undefined
    throw error
  }
}

async function resolveEvidenceRevisionDirectory(
  job_dir: string,
  manifest: EvidenceCommitManifestV3,
): Promise<string> {
  const revision_dir = resolveEvidencePath(job_dir, manifest.evidence_directory)
  const metadata = await lstat(revision_dir)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("evidence-commit.json references an unsafe evidence revision directory")
  }
  const [real_job_dir, real_revision_dir] = await Promise.all([realpath(job_dir), realpath(revision_dir)])
  const from_job = relative(real_job_dir, real_revision_dir)
  if (!from_job || from_job === ".." || from_job.startsWith(`..${sep}`) || isAbsolute(from_job)) {
    throw new Error("evidence-commit.json evidence revision resolves outside the job directory")
  }
  return revision_dir
}

async function validateManifestEvidence(
  job_dir: string,
  manifest: EvidenceCommitManifest,
): Promise<CommittedEvidenceSnapshot> {
  const evidence_root =
    manifest.version === 3 ? await resolveEvidenceRevisionDirectory(job_dir, manifest) : job_dir
  const committed_paths = Object.keys(manifest.files).sort()
  const actual_paths = await evidenceFilePaths(evidence_root, manifest.version === 1 ? 1 : 2, committed_paths)
  if (actual_paths.join("\0") !== committed_paths.join("\0")) {
    throw new Error("evidence-commit.json does not enumerate the complete evidence file set")
  }
  const required_files = manifest.version === 1 ? LEGACY_REQUIRED_EVIDENCE_FILES : V2_REQUIRED_EVIDENCE_FILES
  for (const required of required_files) {
    if (!committed_paths.includes(required)) {
      throw new Error(`evidence-commit.json is missing required file ${required}`)
    }
  }

  const files = new Map<string, Uint8Array<ArrayBuffer>>()
  let total_bytes = 0
  for (const relative_path of committed_paths) {
    resolveEvidencePath(evidence_root, relative_path)
    const entry = manifest.files[relative_path]
    if (!isCommitEntry(entry)) {
      throw new Error(`evidence-commit.json has an invalid entry for ${relative_path}`)
    }
    const bytes = await readCommittedFile(evidence_root, relative_path)
    const actual = hashEntry(bytes)
    if (actual.size_bytes !== entry.size_bytes || actual.sha256 !== entry.sha256) {
      throw new Error(`Committed evidence integrity check failed for ${relative_path}`)
    }
    total_bytes += bytes.byteLength
    if (total_bytes > MAX_EVIDENCE_TOTAL_BYTES) {
      throw new Error(`Committed evidence exceeds the ${MAX_EVIDENCE_TOTAL_BYTES}-byte total limit`)
    }
    files.set(relative_path, bytes)
  }

  if (manifest.version === 1) return { version: 1, files }
  if (manifest.version === 2) {
    return { version: 2, files, source_pdf: await validateV2Evidence(job_dir, files) }
  }

  let source_pdf = await readCommittedFile(evidence_root, "datasheet.pdf")
  const actual_source_pdf = hashEntry(source_pdf)
  if (
    actual_source_pdf.size_bytes !== manifest.source_pdf.size_bytes ||
    actual_source_pdf.sha256 !== manifest.source_pdf.sha256
  ) {
    throw new Error("Committed evidence integrity check failed for datasheet.pdf")
  }
  source_pdf = await validateV2Evidence(evidence_root, files, source_pdf)
  return { version: 3, files, source_pdf }
}

async function loadCommittedEvidence(
  job_dir: string,
  generation_retry = 0,
): Promise<CommittedEvidenceSnapshot | undefined> {
  let manifest_bytes: Uint8Array<ArrayBuffer>
  try {
    const current_marker = await readCurrentCommitMarker(job_dir)
    if (!current_marker) return undefined
    manifest_bytes = current_marker
  } catch (error) {
    throw error
  }
  try {
    let raw_manifest: unknown
    try {
      raw_manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest_bytes)) as unknown
    } catch (error) {
      throw new Error(
        `evidence-commit.json is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const snapshot = await validateManifestEvidence(job_dir, parseCommitManifest(raw_manifest))
    const final_marker = await readCurrentCommitMarker(job_dir)
    if (!final_marker) return undefined
    if (!bytesEqual(manifest_bytes, final_marker)) {
      if (generation_retry < 1) return loadCommittedEvidence(job_dir, generation_retry + 1)
      throw new Error("Committed evidence changed generations while being read")
    }
    return snapshot
  } catch (error) {
    const final_marker = await readCurrentCommitMarker(job_dir)
    if (!final_marker) return undefined
    if (!bytesEqual(manifest_bytes, final_marker)) {
      if (generation_retry < 1) return loadCommittedEvidence(job_dir, generation_retry + 1)
      throw new Error("Committed evidence changed generations while being read", { cause: error })
    }
    throw error
  }
}

export async function clearEvidenceCommit(job_dir: string): Promise<void> {
  await rm(join(job_dir, EVIDENCE_COMMIT_FILE), { force: true })
}

async function readEvidenceCandidate(
  source_dir: string,
  signal?: AbortSignal,
): Promise<{
  files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>
  source_pdf: Uint8Array<ArrayBuffer>
}> {
  signal?.throwIfAborted()
  const files = new Map<string, Uint8Array<ArrayBuffer>>()
  let total_bytes = 0
  for (const relative_path of await evidenceFilePaths(source_dir, 2)) {
    signal?.throwIfAborted()
    const bytes = await readCommittedFile(source_dir, relative_path)
    total_bytes += bytes.byteLength
    if (total_bytes > MAX_EVIDENCE_TOTAL_BYTES) {
      throw new Error(`Evidence exceeds the ${MAX_EVIDENCE_TOTAL_BYTES}-byte total limit`)
    }
    files.set(relative_path, bytes)
  }
  for (const required of V2_REQUIRED_EVIDENCE_FILES) {
    if (!files.has(required)) throw new Error(`Evidence commit is missing required file ${required}`)
  }
  return { files, source_pdf: await validateV2Evidence(source_dir, files) }
}

async function removeUncommittedRevision(prepared: PreparedEvidencePublication): Promise<void> {
  try {
    const marker_bytes = await readCurrentCommitMarker(prepared.job_dir)
    if (marker_bytes) {
      const current = parseCommitManifest(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(marker_bytes)) as unknown,
      )
      if (current.version === 3 && current.generation_id === prepared.manifest.generation_id) return
    }
  } catch {
    // If the current pointer cannot be classified, preserve the revision. A
    // leaked immutable candidate is safer than deleting a possibly selected one.
    return
  }
  await rm(prepared.revision_dir, { recursive: true, force: true }).catch(() => undefined)
}

export async function prepareEvidencePublication(input: {
  source_dir: string
  job_dir: string
  signal?: AbortSignal
}): Promise<PreparedEvidencePublication> {
  const candidate = await readEvidenceCandidate(input.source_dir, input.signal)
  input.signal?.throwIfAborted()
  const generation_id = randomUUID()
  const evidence_directory = `${EVIDENCE_REVISIONS_DIRECTORY}/${generation_id}`
  const revision_dir = join(input.job_dir, evidence_directory)
  const entries: Record<string, EvidenceCommitEntry> = {}
  for (const [relative_path, bytes] of candidate.files) {
    entries[relative_path] = hashEntry(bytes)
  }
  const committed_at = new Date().toISOString()
  const manifest: EvidenceCommitManifestV3 = {
    version: 3,
    schema_id: EVIDENCE_PUBLICATION_SCHEMA_ID,
    generation_id,
    evidence_directory,
    committed_at,
    source_pdf: hashEntry(candidate.source_pdf),
    files: entries,
  }

  const workspace = await createStageWorkspace({ prefix: "evidence-publication", files: [] })
  try {
    const staged_revision = join(workspace.path, "revision")
    await mkdir(staged_revision, { recursive: true })
    await Promise.all([
      Bun.write(join(staged_revision, "datasheet.pdf"), candidate.source_pdf),
      ...[...candidate.files].map(async ([relative_path, bytes]) => {
        const destination = resolveEvidencePath(staged_revision, relative_path)
        await mkdir(dirname(destination), { recursive: true })
        await Bun.write(destination, bytes)
      }),
    ])
    input.signal?.throwIfAborted()
    await promoteStageDirectory({
      workspace: workspace.path,
      source: "revision",
      destination_root: input.job_dir,
      destination: evidence_directory,
      max_files: MAX_EVIDENCE_FILES + 1,
      max_total_bytes: MAX_EVIDENCE_TOTAL_BYTES + MAX_EVIDENCE_FILE_BYTES,
      max_entries: MAX_EVIDENCE_DIRECTORY_ENTRIES + V2_EVIDENCE_JSON_FILES.length + 2,
      max_depth: MAX_EVIDENCE_DIRECTORY_DEPTH,
      signal: input.signal,
    })
    return { job_dir: input.job_dir, revision_dir, manifest }
  } catch (error) {
    await rm(revision_dir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  } finally {
    await workspace.dispose().catch(() => undefined)
  }
}

async function writeCommitMarker(input: {
  job_dir: string
  manifest_bytes: Uint8Array
  signal?: AbortSignal
}): Promise<Pick<EvidenceCommitResult, "durability" | "durability_warning">> {
  const commit_path = join(input.job_dir, EVIDENCE_COMMIT_FILE)
  const temporary_path = join(input.job_dir, `.${EVIDENCE_COMMIT_FILE}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let directory_handle: Awaited<ReturnType<typeof open>> | undefined
  let durability: EvidenceCommitResult["durability"] = "directory_synced"
  let durability_warning: string | undefined
  try {
    directory_handle = await open(input.job_dir, constants.O_RDONLY)
    handle = await open(
      temporary_path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    )
    await handle.writeFile(input.manifest_bytes)
    await handle.sync()
    await handle.close()
    handle = undefined
    input.signal?.throwIfAborted()
    await rename(temporary_path, commit_path)
    try {
      await directory_handle.sync()
    } catch (error) {
      durability = "rename_visible"
      durability_warning = `Evidence pointer was renamed, but its directory sync failed: ${error instanceof Error ? error.message : String(error)}`
    }
  } finally {
    await handle?.close().catch(() => undefined)
    await directory_handle?.close().catch(() => undefined)
    await rm(temporary_path, { force: true }).catch(() => undefined)
  }
  return { durability, ...(durability_warning ? { durability_warning } : {}) }
}

export async function commitPreparedEvidencePublication(
  prepared: PreparedEvidencePublication,
  options: { signal?: AbortSignal } = {},
): Promise<EvidenceCommitResult> {
  try {
    options.signal?.throwIfAborted()
    const manifest = parseCommitManifest(prepared.manifest)
    if (manifest.version !== 3) throw new Error("Prepared evidence publication must use version 3")
    const expected_revision_dir = await resolveEvidenceRevisionDirectory(prepared.job_dir, manifest)
    if (resolve(expected_revision_dir) !== resolve(prepared.revision_dir)) {
      throw new Error("Prepared evidence publication revision identity changed before commit")
    }
    await validateManifestEvidence(prepared.job_dir, manifest)
    options.signal?.throwIfAborted()
    const manifest_bytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)
    const durability = await writeCommitMarker({
      job_dir: prepared.job_dir,
      manifest_bytes,
      signal: options.signal,
    })
    return {
      status: "committed",
      version: 3,
      commit_path: join(prepared.job_dir, EVIDENCE_COMMIT_FILE),
      evidence_dir: prepared.revision_dir,
      generation_id: manifest.generation_id,
      committed_at: manifest.committed_at,
      file_count: Object.keys(manifest.files).length,
      manifest_sha256: hashEntry(manifest_bytes).sha256,
      ...durability,
    }
  } catch (error) {
    await removeUncommittedRevision(prepared)
    throw error
  }
}

export async function writeEvidenceCommit(
  source_dir: string,
  options: { signal?: AbortSignal; destination_root?: string } = {},
): Promise<EvidenceCommitResult> {
  const prepared = await prepareEvidencePublication({
    source_dir,
    job_dir: options.destination_root ?? source_dir,
    signal: options.signal,
  })
  return commitPreparedEvidencePublication(prepared, { signal: options.signal })
}

export async function readCommittedEvidenceSnapshot(
  job_dir: string,
): Promise<CommittedEvidenceSnapshot | undefined> {
  return loadCommittedEvidence(job_dir)
}

export async function hasCommittedEvidence(job_dir: string): Promise<boolean> {
  try {
    return (await loadCommittedEvidence(job_dir)) !== undefined
  } catch {
    return false
  }
}
