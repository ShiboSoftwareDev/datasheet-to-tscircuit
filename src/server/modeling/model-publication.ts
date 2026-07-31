import { createHash } from "node:crypto"
import { constants, type Dirent } from "node:fs"
import { lstat, open, opendir, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { atomicWriteJsonSync } from "../infrastructure/persistence/atomic-write"
import { stableStringify } from "../spice-validation/hashing"
import { assertCircuitEmbedsModel, createIntegratedComponentSource } from "./component-integration"
import { createModelManifest } from "./model-artifacts"
import { parseModelContract } from "./parse-model-contract"

const PUBLICATION_ID_PATTERN = /^[a-f0-9-]{16,80}$/
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const REVISION_PATTERN = /^[a-f0-9]{16}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const INVOCATION_ID_PATTERN = /^[a-f0-9-]{16,80}$/
const ACCEPTED_MODEL_DIRECTORY_PATTERN = /^spice\/accepted-revisions\/[a-f0-9-]{16,100}$/
const PUBLISHED_COMPONENT_DIRECTORY_PATTERN = /^published-models\/[a-f0-9-]{16,100}$/
const POINTER_BYTE_LIMIT = 64 * 1024
const BUNDLE_MANIFEST_BYTE_LIMIT = 2 * 1024 * 1024
const BUNDLE_FILE_LIMIT = 512
const BUNDLE_DIRECTORY_LIMIT = 256
const BUNDLE_DEPTH_LIMIT = 16
const BUNDLE_BYTE_LIMIT = 128 * 1024 * 1024

export const MODEL_PUBLICATION_FILE = "published-model.json"

export interface ModelPublicationCommit {
  version: 2
  publication_id: string
  job_id: string
  model_run_id: string
  invocation_id: string
  revision: string
  accepted_bundle_manifest_sha256: string
  published_component_bundle_manifest_sha256: string
  accepted_model_directory: string
  published_component_directory: string
  published_at: string
}

export type ModelPublicationRecord = Omit<
  ModelPublicationCommit,
  "accepted_bundle_manifest_sha256" | "published_component_bundle_manifest_sha256"
>

export interface PublicationBundleManifest {
  version: 1
  files: Readonly<Record<string, Readonly<{ size_bytes: number; sha256: string }>>>
}

export interface ResolvedModelPublication {
  commit: ModelPublicationCommit
  accepted_model_dir: string
  published_component_dir: string
  accepted_bundle_manifest: PublicationBundleManifest
  published_component_bundle_manifest: PublicationBundleManifest
}

export type ModelPublicationBundle = "accepted_model" | "published_component"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function publicationRecord(commit: ModelPublicationCommit): ModelPublicationRecord {
  return {
    version: 2,
    publication_id: commit.publication_id,
    job_id: commit.job_id,
    model_run_id: commit.model_run_id,
    invocation_id: commit.invocation_id,
    revision: commit.revision,
    accepted_model_directory: commit.accepted_model_directory,
    published_component_directory: commit.published_component_directory,
    published_at: commit.published_at,
  }
}

function isInside(root: string, candidate: string): boolean {
  const from_root = relative(root, candidate)
  return Boolean(
    from_root && from_root !== ".." && !from_root.startsWith(`..${sep}`) && !isAbsolute(from_root),
  )
}

async function readBoundedRegularFile(path: string, max_bytes: number, label: string): Promise<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(
    (error) => {
      throw new Error(`${label} must be a regular file and not a symlink`, { cause: error })
    },
  )
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error(`${label} must be a regular file`)
    if (metadata.size > max_bytes) {
      throw new Error(`${label} exceeds its ${max_bytes}-byte limit`)
    }
    const chunks: Uint8Array[] = []
    let total_bytes = 0
    while (true) {
      const remaining_bytes = max_bytes - total_bytes
      const chunk = new Uint8Array(Math.min(64 * 1024, remaining_bytes + 1))
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null)
      if (bytesRead === 0) break
      total_bytes += bytesRead
      if (total_bytes > max_bytes) throw new Error(`${label} exceeds its ${max_bytes}-byte limit`)
      chunks.push(chunk.slice(0, bytesRead))
    }
    const bytes = new Uint8Array(total_bytes)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  } finally {
    await handle.close()
  }
}

async function readBoundedText(path: string, max_bytes: number, label: string): Promise<string> {
  return new TextDecoder().decode(await readBoundedRegularFile(path, max_bytes, label))
}

function resolveInside(root: string, relative_path: string, label: string): string {
  const resolved = resolve(root, relative_path)
  const from_root = relative(root, resolved)
  if (!from_root || from_root === ".." || from_root.startsWith(`..${sep}`) || isAbsolute(from_root)) {
    throw new Error(`${label} escapes the job workspace`)
  }
  return resolved
}

function parseModelPublication(value: unknown): ModelPublicationCommit {
  if (!isRecord(value) || value.version !== 2) {
    throw new Error(`${MODEL_PUBLICATION_FILE} has an unsupported version; expected version 2`)
  }
  const expected_keys = [
    "accepted_model_directory",
    "accepted_bundle_manifest_sha256",
    "invocation_id",
    "job_id",
    "model_run_id",
    "publication_id",
    "published_at",
    "published_component_bundle_manifest_sha256",
    "published_component_directory",
    "revision",
    "version",
  ].sort()
  const actual_keys = Object.keys(value).sort()
  if (JSON.stringify(actual_keys) !== JSON.stringify(expected_keys)) {
    throw new Error(`${MODEL_PUBLICATION_FILE} contains unexpected or missing fields`)
  }
  if (typeof value.publication_id !== "string" || !PUBLICATION_ID_PATTERN.test(value.publication_id)) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.publication_id is invalid`)
  }
  if (typeof value.revision !== "string" || !REVISION_PATTERN.test(value.revision)) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.revision is invalid`)
  }
  if (typeof value.job_id !== "string" || !JOB_ID_PATTERN.test(value.job_id)) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.job_id is invalid`)
  }
  if (
    typeof value.model_run_id !== "string" ||
    !value.model_run_id.trim() ||
    value.model_run_id.length > 200
  ) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.model_run_id is invalid`)
  }
  if (typeof value.invocation_id !== "string" || !INVOCATION_ID_PATTERN.test(value.invocation_id)) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.invocation_id is invalid`)
  }
  if (
    typeof value.accepted_bundle_manifest_sha256 !== "string" ||
    !SHA256_PATTERN.test(value.accepted_bundle_manifest_sha256)
  ) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.accepted_bundle_manifest_sha256 is invalid`)
  }
  if (
    typeof value.published_component_bundle_manifest_sha256 !== "string" ||
    !SHA256_PATTERN.test(value.published_component_bundle_manifest_sha256)
  ) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.published_component_bundle_manifest_sha256 is invalid`)
  }
  if (
    typeof value.accepted_model_directory !== "string" ||
    !ACCEPTED_MODEL_DIRECTORY_PATTERN.test(value.accepted_model_directory)
  ) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.accepted_model_directory is invalid`)
  }
  if (
    typeof value.published_component_directory !== "string" ||
    !PUBLISHED_COMPONENT_DIRECTORY_PATTERN.test(value.published_component_directory)
  ) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.published_component_directory is invalid`)
  }
  if (typeof value.published_at !== "string" || !Number.isFinite(Date.parse(value.published_at))) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.published_at must be an ISO timestamp`)
  }
  const snapshot_id = `${value.revision}-${value.publication_id}`
  if (value.accepted_model_directory !== `spice/accepted-revisions/${snapshot_id}`) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.accepted_model_directory does not match its revision`)
  }
  if (value.published_component_directory !== `published-models/${snapshot_id}`) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.published_component_directory does not match its revision`)
  }
  return {
    version: 2,
    publication_id: value.publication_id,
    job_id: value.job_id,
    model_run_id: value.model_run_id,
    invocation_id: value.invocation_id,
    revision: value.revision,
    accepted_bundle_manifest_sha256: value.accepted_bundle_manifest_sha256,
    published_component_bundle_manifest_sha256: value.published_component_bundle_manifest_sha256,
    accepted_model_directory: value.accepted_model_directory,
    published_component_directory: value.published_component_directory,
    published_at: value.published_at,
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

async function collectBundleFiles(directory: string): Promise<PublicationBundleManifest["files"]> {
  const files: Record<string, { size_bytes: number; sha256: string }> = Object.create(null)
  let file_count = 0
  let directory_count = 0
  let total_bytes = 0
  let entry_count = 0
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > BUNDLE_DEPTH_LIMIT) throw new Error("Published bundle exceeds its directory depth limit")
    directory_count += 1
    if (directory_count > BUNDLE_DIRECTORY_LIMIT) {
      throw new Error("Published bundle exceeds its directory-count limit")
    }
    const entries: Dirent[] = []
    const directory_handle = await opendir(current)
    for await (const entry of directory_handle) {
      entry_count += 1
      if (entry_count > BUNDLE_FILE_LIMIT + BUNDLE_DIRECTORY_LIMIT) {
        throw new Error("Published bundle exceeds its entry-count limit")
      }
      entries.push(entry)
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) throw new Error(`Published bundle contains a symlink: ${path}`)
      if (metadata.isDirectory()) {
        await visit(path, depth + 1)
        continue
      }
      if (!metadata.isFile()) throw new Error(`Published bundle contains a special file: ${path}`)
      const relative_path = relative(directory, path).split(sep).join("/")
      if (relative_path === "bundle-manifest.json") continue
      file_count += 1
      if (file_count > BUNDLE_FILE_LIMIT) {
        throw new Error("Published bundle exceeds its validation limits")
      }
      const remaining_bytes = BUNDLE_BYTE_LIMIT - total_bytes
      const bytes = await readBoundedRegularFile(
        path,
        remaining_bytes,
        `Published bundle file ${relative_path}`,
      )
      total_bytes += bytes.byteLength
      files[relative_path] = { size_bytes: bytes.byteLength, sha256: sha256Bytes(bytes) }
    }
  }
  await visit(directory, 0)
  const sorted: Record<string, { size_bytes: number; sha256: string }> = Object.create(null)
  for (const [path, metadata] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    sorted[path] = metadata
  }
  return sorted
}

function parseBundleManifest(value: unknown): PublicationBundleManifest {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.files)) {
    throw new Error("bundle-manifest.json must be a version 1 object with files")
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["files", "version"])) {
    throw new Error("bundle-manifest.json contains unexpected fields")
  }
  const files: Record<string, Readonly<{ size_bytes: number; sha256: string }>> = Object.create(null)
  for (const [path, entry] of Object.entries(value.files).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      !path ||
      path.startsWith("/") ||
      path === "bundle-manifest.json" ||
      path.split("/").includes("..") ||
      !isRecord(entry) ||
      JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["sha256", "size_bytes"]) ||
      typeof entry.size_bytes !== "number" ||
      !Number.isSafeInteger(entry.size_bytes) ||
      entry.size_bytes < 0 ||
      typeof entry.sha256 !== "string" ||
      !SHA256_PATTERN.test(entry.sha256)
    ) {
      throw new Error(`bundle-manifest.json contains an invalid entry for ${JSON.stringify(path)}`)
    }
    files[path] = Object.freeze({ size_bytes: entry.size_bytes, sha256: entry.sha256 })
  }
  if (Object.keys(files).length === 0) throw new Error("bundle-manifest.json must bind at least one file")
  return Object.freeze({ version: 1, files: Object.freeze(files) })
}

export async function writePublicationBundleManifest(directory: string): Promise<string> {
  const manifest: PublicationBundleManifest = { version: 1, files: await collectBundleFiles(directory) }
  await Bun.write(join(directory, "bundle-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  return sha256(stableStringify(manifest))
}

async function validatePublicationBundle(
  directory: string,
  expected_sha256: string,
): Promise<PublicationBundleManifest> {
  const manifest_value: unknown = JSON.parse(
    await readBoundedText(
      join(directory, "bundle-manifest.json"),
      BUNDLE_MANIFEST_BYTE_LIMIT,
      "bundle-manifest.json",
    ),
  )
  const manifest = parseBundleManifest(manifest_value)
  if (sha256(stableStringify(manifest)) !== expected_sha256) {
    throw new Error("Published bundle manifest hash does not match the atomic commit")
  }
  const actual_files = await collectBundleFiles(directory)
  if (JSON.stringify(actual_files) !== JSON.stringify(manifest.files)) {
    throw new Error("Published bundle contents do not match bundle-manifest.json")
  }
  return manifest
}

function assertPublicationOwnership(commit: ModelPublicationCommit, expected_job_id: string): void {
  if (commit.job_id !== expected_job_id) {
    throw new Error(
      `${MODEL_PUBLICATION_FILE} belongs to job ${commit.job_id}, not expected job ${expected_job_id}`,
    )
  }
}

function assertSafeBundleRelativePath(relative_path: string): void {
  const segments = relative_path.split("/")
  if (
    !relative_path ||
    relative_path.length > 1_024 ||
    relative_path.startsWith("/") ||
    relative_path.includes("\\") ||
    relative_path.includes("\0") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Published artifact path is invalid: ${JSON.stringify(relative_path)}`)
  }
}

async function readExactRegularFile(input: {
  path: string
  expected_size: number
  max_bytes: number
  label: string
}): Promise<Uint8Array<ArrayBuffer>> {
  if (input.expected_size > input.max_bytes) {
    throw new Error(`${input.label} exceeds its ${input.max_bytes}-byte read limit`)
  }
  const handle = await open(
    input.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error) => {
    throw new Error(`${input.label} must remain a regular file and not a symlink`, { cause: error })
  })
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error(`${input.label} must remain a regular file`)
    if (metadata.size !== input.expected_size) {
      throw new Error(`${input.label} size changed after publication validation`)
    }
    const bytes = new Uint8Array(input.expected_size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead === 0) throw new Error(`${input.label} was truncated while being read`)
      offset += bytesRead
    }
    const trailing_byte = new Uint8Array(1)
    const { bytesRead: trailing_bytes_read } = await handle.read(
      trailing_byte,
      0,
      trailing_byte.byteLength,
      input.expected_size,
    )
    if (trailing_bytes_read !== 0) throw new Error(`${input.label} grew while being read`)
    return bytes
  } finally {
    await handle.close()
  }
}

/**
 * Re-opens one selected artifact and verifies the bytes against the manifest
 * captured by readModelPublication. Returning bytes instead of a path prevents
 * a later rename/symlink swap from changing what an API or restorer consumes.
 */
export async function readVerifiedPublicationArtifact(input: {
  publication: ResolvedModelPublication
  bundle: ModelPublicationBundle
  relative_path: string
  max_bytes: number
}): Promise<Uint8Array<ArrayBuffer>> {
  assertSafeBundleRelativePath(input.relative_path)
  const directory =
    input.bundle === "accepted_model"
      ? input.publication.accepted_model_dir
      : input.publication.published_component_dir
  const manifest =
    input.bundle === "accepted_model"
      ? input.publication.accepted_bundle_manifest
      : input.publication.published_component_bundle_manifest
  const entry = manifest.files[input.relative_path]
  if (!entry) throw new Error(`Published bundle does not contain ${input.relative_path}`)
  const bytes = await readExactRegularFile({
    path: resolveInside(directory, input.relative_path, `published artifact ${input.relative_path}`),
    expected_size: entry.size_bytes,
    max_bytes: input.max_bytes,
    label: `Published artifact ${input.relative_path}`,
  })
  if (sha256Bytes(bytes) !== entry.sha256) {
    throw new Error(`Published artifact ${input.relative_path} changed after publication validation`)
  }
  return bytes
}

async function requireRealDirectory(input: {
  path: string
  label: string
  real_job_root: string
}): Promise<void> {
  const { path, label, real_job_root } = input
  const metadata = await lstat(path).catch(() => undefined)
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${MODEL_PUBLICATION_FILE} references a missing or unsafe ${label}`)
  }
  const real_directory = await realpath(path)
  if (!isInside(real_job_root, real_directory)) {
    throw new Error(`${MODEL_PUBLICATION_FILE} ${label} resolves outside the job workspace`)
  }
}

/** Reads the single commit point that binds a model snapshot to its owning job and wrapper. */
export async function readModelPublication(
  job_dir: string,
  expected_job_id: string,
): Promise<ResolvedModelPublication | undefined> {
  const pointer_path = join(job_dir, MODEL_PUBLICATION_FILE)
  const pointer_metadata = await lstat(pointer_path).catch((error) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return undefined
    }
    throw error
  })
  if (!pointer_metadata) return undefined
  if (!pointer_metadata.isFile() || pointer_metadata.isSymbolicLink()) {
    throw new Error(`${MODEL_PUBLICATION_FILE} must be a regular file and not a symlink`)
  }
  const value: unknown = JSON.parse(
    await readBoundedText(pointer_path, POINTER_BYTE_LIMIT, MODEL_PUBLICATION_FILE),
  )
  const commit = parseModelPublication(value)
  assertPublicationOwnership(commit, expected_job_id)
  const real_job_root = await realpath(job_dir)
  const accepted_model_dir = resolveInside(
    job_dir,
    commit.accepted_model_directory,
    "accepted model directory",
  )
  const published_component_dir = resolveInside(
    job_dir,
    commit.published_component_directory,
    "published component directory",
  )
  await Promise.all([
    requireRealDirectory({
      path: accepted_model_dir,
      label: "accepted model directory",
      real_job_root,
    }),
    requireRealDirectory({
      path: published_component_dir,
      label: "published component directory",
      real_job_root,
    }),
  ])
  return validateResolvedModelPublication(
    { commit, accepted_model_dir, published_component_dir },
    expected_job_id,
  )
}

export async function validateResolvedModelPublication(
  publication: Pick<ResolvedModelPublication, "commit" | "accepted_model_dir" | "published_component_dir">,
  expected_job_id: string,
): Promise<ResolvedModelPublication> {
  assertPublicationOwnership(publication.commit, expected_job_id)
  const [accepted_bundle_manifest, published_component_bundle_manifest] = await Promise.all([
    validatePublicationBundle(
      publication.accepted_model_dir,
      publication.commit.accepted_bundle_manifest_sha256,
    ),
    validatePublicationBundle(
      publication.published_component_dir,
      publication.commit.published_component_bundle_manifest_sha256,
    ),
  ])
  const resolved: ResolvedModelPublication = {
    ...publication,
    accepted_bundle_manifest,
    published_component_bundle_manifest,
  }
  const [
    accepted_source,
    published_source,
    accepted_wrapper_source,
    wrapper_source,
    accepted_circuit_text,
    circuit_text,
    contract_text,
    accepted_record_text,
    component_record_text,
  ] = await Promise.all([
    readVerifiedPublicationArtifact({
      publication: resolved,
      bundle: "accepted_model",
      relative_path: "model.lib",
      max_bytes: 2 * 1024 * 1024,
    }).then((bytes) => new TextDecoder().decode(bytes)),
    readVerifiedPublicationArtifact({
      publication: resolved,
      bundle: "published_component",
      relative_path: "model.lib",
      max_bytes: 2 * 1024 * 1024,
    }).then((bytes) => new TextDecoder().decode(bytes)),
    readVerifiedPublicationArtifact({
      publication: resolved,
      bundle: "accepted_model",
      relative_path: "component-with-model.circuit.tsx",
      max_bytes: 2 * 1024 * 1024,
    }).then((bytes) => new TextDecoder().decode(bytes)),
    readVerifiedPublicationArtifact({
      publication: resolved,
      bundle: "published_component",
      relative_path: "index.circuit.tsx",
      max_bytes: 2 * 1024 * 1024,
    }).then((bytes) => new TextDecoder().decode(bytes)),
    readVerifiedPublicationArtifact({
      publication: resolved,
      bundle: "accepted_model",
      relative_path: "component-with-model.circuit.json",
      max_bytes: 16 * 1024 * 1024,
    }).then((bytes) => new TextDecoder().decode(bytes)),
    readVerifiedPublicationArtifact({
      publication: resolved,
      bundle: "published_component",
      relative_path: "component.circuit.json",
      max_bytes: 16 * 1024 * 1024,
    }).then((bytes) => new TextDecoder().decode(bytes)),
    readVerifiedPublicationArtifact({
      publication: resolved,
      bundle: "accepted_model",
      relative_path: "model-contract.json",
      max_bytes: 4 * 1024 * 1024,
    }).then((bytes) => new TextDecoder().decode(bytes)),
    readVerifiedPublicationArtifact({
      publication: resolved,
      bundle: "accepted_model",
      relative_path: "publication-record.json",
      max_bytes: POINTER_BYTE_LIMIT,
    }).then((bytes) => new TextDecoder().decode(bytes)),
    readVerifiedPublicationArtifact({
      publication: resolved,
      bundle: "published_component",
      relative_path: "publication-record.json",
      max_bytes: POINTER_BYTE_LIMIT,
    }).then((bytes) => new TextDecoder().decode(bytes)),
  ])
  if (accepted_source !== published_source) {
    throw new Error(`${MODEL_PUBLICATION_FILE} model snapshots disagree`)
  }
  if (accepted_wrapper_source !== wrapper_source || accepted_circuit_text !== circuit_text) {
    throw new Error(`${MODEL_PUBLICATION_FILE} component snapshots disagree`)
  }
  const expected_record = publicationRecord(publication.commit)
  const accepted_record: unknown = JSON.parse(accepted_record_text)
  const component_record: unknown = JSON.parse(component_record_text)
  if (
    stableStringify(accepted_record) !== stableStringify(expected_record) ||
    stableStringify(component_record) !== stableStringify(expected_record)
  ) {
    throw new Error(`${MODEL_PUBLICATION_FILE} metadata does not match both published bundles`)
  }
  const circuit_value: unknown = JSON.parse(circuit_text)
  const contract = parseModelContract(JSON.parse(contract_text))
  const manifest = createModelManifest({
    model_interface: contract.interface,
    model_source: accepted_source,
    simulator: "ngspice",
  })
  if (manifest.revision !== publication.commit.revision) {
    throw new Error(`${MODEL_PUBLICATION_FILE} revision does not match the accepted model`)
  }
  if (wrapper_source !== createIntegratedComponentSource(manifest, accepted_source)) {
    throw new Error("Published wrapper is not the deterministic server-owned model integration")
  }
  assertCircuitEmbedsModel(circuit_value, accepted_source, contract.interface)
  return resolved
}

export async function resolveAcceptedModelPublication(
  model_dir: string,
  expected_job_id: string,
): Promise<ResolvedModelPublication | undefined> {
  const publication = await readModelPublication(resolve(model_dir, ".."), expected_job_id)
  if (!publication) return undefined
  const expected_root = resolve(model_dir, "accepted-revisions")
  const from_root = relative(expected_root, publication.accepted_model_dir)
  if (!from_root || from_root === ".." || from_root.startsWith(`..${sep}`) || isAbsolute(from_root)) {
    throw new Error(`${MODEL_PUBLICATION_FILE} does not select a snapshot in this model workspace`)
  }
  return publication
}

export function commitModelPublication(
  job_dir: string,
  expected_job_id: string,
  commit: ModelPublicationCommit,
): void {
  // Validate the exact pointer shape before the atomic rename makes it public.
  assertPublicationOwnership(parseModelPublication(commit), expected_job_id)
  atomicWriteJsonSync(join(job_dir, MODEL_PUBLICATION_FILE), commit)
}
