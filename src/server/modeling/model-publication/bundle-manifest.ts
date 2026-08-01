import type { Dirent } from "node:fs"
import { lstat, opendir } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { stableStringify } from "../../spice-validation/hashing"
import {
  BUNDLE_BYTE_LIMIT,
  BUNDLE_DEPTH_LIMIT,
  BUNDLE_DIRECTORY_LIMIT,
  BUNDLE_FILE_LIMIT,
  BUNDLE_MANIFEST_BYTE_LIMIT,
  SHA256_PATTERN,
} from "./constants"
import { isRecord, readBoundedRegularFile, readBoundedText, sha256, sha256Bytes } from "./filesystem"
import type { PublicationBundleManifest } from "./types"

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

export async function validatePublicationBundle(
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
