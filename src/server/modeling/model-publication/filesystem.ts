import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isInside(root: string, candidate: string): boolean {
  const from_root = relative(root, candidate)
  return Boolean(
    from_root && from_root !== ".." && !from_root.startsWith(`..${sep}`) && !isAbsolute(from_root),
  )
}

export async function readBoundedRegularFile(
  path: string,
  max_bytes: number,
  label: string,
): Promise<Uint8Array> {
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

export async function readBoundedText(path: string, max_bytes: number, label: string): Promise<string> {
  return new TextDecoder().decode(await readBoundedRegularFile(path, max_bytes, label))
}

export function resolveInside(root: string, relative_path: string, label: string): string {
  const resolved = resolve(root, relative_path)
  const from_root = relative(root, resolved)
  if (!from_root || from_root === ".." || from_root.startsWith(`..${sep}`) || isAbsolute(from_root)) {
    throw new Error(`${label} escapes the job workspace`)
  }
  return resolved
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}
