import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { atomicWriteTextSync } from "@/server/infrastructure/persistence/atomic-write"

const temporary_directories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

test("a directory-sync failure after rename is reported as visible, not as a failed write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atomic-write-post-rename-"))
  temporary_directories.push(directory)
  const path = join(directory, "checkpoint.json")

  const result = atomicWriteTextSync(path, "new checkpoint\n", {
    sync_directory() {
      throw new Error("injected directory fsync failure")
    },
  })

  expect(result).toMatchObject({
    durability: "rename_visible",
    durability_warning: expect.stringContaining("injected directory fsync failure"),
  })
  expect(await readFile(path, "utf8")).toBe("new checkpoint\n")
  expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([])
})
