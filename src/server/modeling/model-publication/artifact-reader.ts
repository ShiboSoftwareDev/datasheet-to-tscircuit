import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { resolveInside, sha256Bytes } from "./filesystem"
import type { ModelPublicationBundle, ResolvedModelPublication } from "./types"

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
