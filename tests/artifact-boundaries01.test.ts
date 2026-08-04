import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import {
  promoteStageDirectory,
  promoteStageFile,
  validatePngArtifact,
  validateStageDirectory,
} from "@/server/infrastructure/artifacts"

const crc32_table = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return crc >>> 0
})

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc32_table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data = new Uint8Array()): Uint8Array {
  const type_bytes = Buffer.from(type, "ascii")
  const chunk = Buffer.alloc(12 + data.byteLength)
  chunk.writeUInt32BE(data.byteLength, 0)
  chunk.set(type_bytes, 4)
  chunk.set(data, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([type_bytes, Buffer.from(data)])), 8 + data.byteLength)
  return chunk
}

function minimalPng(width = 1, height = 1, encoded_width = width, encoded_height = height): Uint8Array {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const scanlines = Buffer.alloc((encoded_width * 4 + 1) * encoded_height)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND"),
  ])
}

test("artifact promotion refuses file and directory symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-symlinks-"))
  const workspace = join(root, "workspace")
  const destination_root = join(root, "published")
  await mkdir(workspace, { recursive: true })

  try {
    await Bun.write(join(workspace, "real.txt"), "candidate")
    await symlink("real.txt", join(workspace, "candidate.txt"))
    await expect(
      promoteStageFile({
        workspace,
        source: "candidate.txt",
        destination_root,
      }),
    ).rejects.toThrow("not a symlink")

    await mkdir(join(workspace, "real-images"))
    await Bun.write(join(workspace, "real-images", "plot.png"), minimalPng())
    await symlink("real-images", join(workspace, "images"))
    await expect(
      promoteStageDirectory({
        workspace,
        source: "images",
        destination_root,
        validate_file: validatePngArtifact,
      }),
    ).rejects.toThrow("Stage did not produce directory images")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("artifact promotion never replaces a destination with the wrong filesystem type", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-destination-types-"))
  const workspace = join(root, "workspace")
  const destination_root = join(root, "published")
  await Promise.all([
    mkdir(join(workspace, "images"), { recursive: true }),
    mkdir(join(destination_root, "candidate.txt"), { recursive: true }),
  ])
  await Promise.all([
    Bun.write(join(workspace, "candidate.txt"), "candidate"),
    Bun.write(join(workspace, "images", "plot.png"), minimalPng()),
    Bun.write(join(destination_root, "images"), "existing file"),
  ])

  try {
    await expect(promoteStageFile({ workspace, source: "candidate.txt", destination_root })).rejects.toThrow(
      "destination must be a regular file",
    )
    await expect(promoteStageDirectory({ workspace, source: "images", destination_root })).rejects.toThrow(
      "destination must be a real directory",
    )
    expect((await readdir(join(destination_root, "candidate.txt"))).length).toBe(0)
    expect(await readFile(join(destination_root, "images"), "utf8")).toBe("existing file")
    expect((await readdir(destination_root)).sort()).toEqual(["candidate.txt", "images"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("reference-image promotion rejects invalid PNGs before publishing", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-invalid-png-"))
  const workspace = join(root, "workspace")
  const destination_root = join(root, "published")
  await mkdir(join(workspace, "images"), { recursive: true })
  await Bun.write(join(workspace, "images", "plot.png"), "not a png")

  try {
    await expect(
      promoteStageDirectory({
        workspace,
        source: "images",
        destination_root,
        validate_file: validatePngArtifact,
      }),
    ).rejects.toThrow("not a valid PNG")
    expect(await Bun.file(join(destination_root, "images", "plot.png")).exists()).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("reference-image promotion accepts a valid PNG only within declared bounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-valid-png-"))
  const workspace = join(root, "workspace")
  const destination_root = join(root, "published")
  const png = minimalPng(640, 480)
  await mkdir(join(workspace, "images"), { recursive: true })
  await Bun.write(join(workspace, "images", "plot.png"), png)

  try {
    await expect(
      promoteStageDirectory({
        workspace,
        source: "images",
        destination_root,
        max_files: 1,
        max_total_bytes: png.byteLength - 1,
        validate_file: validatePngArtifact,
      }),
    ).rejects.toThrow("byte limit")

    await promoteStageDirectory({
      workspace,
      source: "images",
      destination_root,
      max_files: 1,
      max_total_bytes: png.byteLength,
      validate_file: validatePngArtifact,
    })
    expect([...(await readFile(join(destination_root, "images", "plot.png")))]).toEqual([...png])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("artifact directory traversal bounds empty entries and nesting depth", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-directory-bounds-"))
  const broad = join(root, "broad")
  const deep = join(root, "deep")
  try {
    await Promise.all([
      mkdir(join(broad, "one"), { recursive: true }),
      mkdir(join(broad, "two"), { recursive: true }),
      mkdir(join(broad, "three"), { recursive: true }),
      mkdir(join(deep, "one", "two", "three"), { recursive: true }),
    ])

    await expect(
      validateStageDirectory({
        root: broad,
        max_files: 1,
        max_total_bytes: 1,
        max_entries: 2,
        max_depth: 8,
      }),
    ).rejects.toThrow("entry limit")
    await expect(
      validateStageDirectory({
        root: deep,
        max_files: 1,
        max_total_bytes: 1,
        max_entries: 8,
        max_depth: 2,
      }),
    ).rejects.toThrow("depth limit")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("directory promotion restores the prior value across both pre- and post-publication sync failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-directory-rollback-"))
  try {
    for (const failed_root_read of [2, 3]) {
      const case_root = join(root, `case-${failed_root_read}`)
      const workspace = join(case_root, "workspace")
      const destination_root = join(case_root, "published")
      const wrong_root = join(case_root, "unrelated")
      await Promise.all([
        mkdir(join(workspace, "images"), { recursive: true }),
        mkdir(join(destination_root, "images"), { recursive: true }),
        mkdir(wrong_root, { recursive: true }),
      ])
      await Promise.all([
        Bun.write(join(workspace, "images", "new.txt"), "new candidate"),
        Bun.write(join(destination_root, "images", "old.txt"), "prior value"),
      ])
      let destination_root_reads = 0
      const promotion = promoteStageDirectory({
        workspace,
        source: "images",
        get destination_root() {
          destination_root_reads += 1
          return destination_root_reads === failed_root_read ? wrong_root : destination_root
        },
      })

      await expect(promotion).rejects.toThrow("outside")
      expect(await readFile(join(destination_root, "images", "old.txt"), "utf8")).toBe("prior value")
      expect(await Bun.file(join(destination_root, "images", "new.txt")).exists()).toBe(false)
      expect((await readdir(destination_root)).filter((name) => name !== "images")).toEqual([])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("directory promotion removes its temporary candidate when cancellation arrives before publish", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-directory-cancel-cleanup-"))
  const workspace = join(root, "workspace")
  const destination_root = join(root, "published")
  await mkdir(join(workspace, "images"), { recursive: true })
  await Bun.write(join(workspace, "images", "new.txt"), "new candidate")
  let cancellation_checks = 0
  const signal = {
    throwIfAborted() {
      cancellation_checks += 1
      if (cancellation_checks === 3) throw new Error("cancel before directory publish")
    },
  } as AbortSignal

  try {
    await expect(
      promoteStageDirectory({ workspace, source: "images", destination_root, signal }),
    ).rejects.toThrow("cancel before directory publish")
    expect(await readdir(destination_root)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("file promotion restores the prior value across both pre- and post-publication sync failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-file-rollback-"))
  try {
    for (const failed_root_read of [2, 3]) {
      const case_root = join(root, `case-${failed_root_read}`)
      const workspace = join(case_root, "workspace")
      const destination_root = join(case_root, "published")
      const wrong_root = join(case_root, "unrelated")
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(destination_root, { recursive: true }),
        mkdir(wrong_root, { recursive: true }),
      ])
      await Promise.all([
        Bun.write(join(workspace, "candidate.txt"), "new candidate"),
        Bun.write(join(destination_root, "candidate.txt"), "prior value"),
      ])
      let destination_root_reads = 0
      const promotion = promoteStageFile({
        workspace,
        source: "candidate.txt",
        get destination_root() {
          destination_root_reads += 1
          return destination_root_reads === failed_root_read ? wrong_root : destination_root
        },
      })

      await expect(promotion).rejects.toThrow("outside")
      expect(await readFile(join(destination_root, "candidate.txt"), "utf8")).toBe("prior value")
      expect((await readdir(destination_root)).filter((name) => name !== "candidate.txt")).toEqual([])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("PNG validation rejects corrupt chunk checksums and missing termination", () => {
  const valid = minimalPng()
  const corrupt_crc = Uint8Array.from(valid)
  corrupt_crc[29] = (corrupt_crc[29] ?? 0) ^ 1

  expect(() =>
    validatePngArtifact({
      relative_path: "corrupt.png",
      size_bytes: corrupt_crc.byteLength,
      bytes: corrupt_crc,
    }),
  ).toThrow("IHDR CRC mismatch")

  const missing_iend = valid.subarray(0, valid.byteLength - 12)
  expect(() =>
    validatePngArtifact({
      relative_path: "truncated.png",
      size_bytes: missing_iend.byteLength,
      bytes: missing_iend,
    }),
  ).toThrow("IHDR, IDAT, or IEND is missing")
})

test("PNG validation rejects dimensions that could exhaust decoded-memory limits", () => {
  const oversized = minimalPng(16_000, 16_000, 1, 1)
  expect(() =>
    validatePngArtifact({
      relative_path: "oversized.png",
      size_bytes: oversized.byteLength,
      bytes: oversized,
    }),
  ).toThrow("unsafe dimensions 16000x16000")
})
