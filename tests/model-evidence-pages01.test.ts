import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BunProcessRunner,
  type ProcessRunner,
  type ProcessRunRequest,
  type ProcessRunResult,
} from "@/server/infrastructure/process"
import { materializeModelEvidencePages } from "@/server/model-workflow/model-evidence-pages"
import type { ModelCharacterization } from "@/server/modeling"

const temporary_directories: string[] = []
const png_bytes = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
  (character) => character.charCodeAt(0),
)

afterEach(async () => {
  await Promise.all(temporary_directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class PdfPageRunner implements ProcessRunner {
  readonly pages: number[] = []
  readonly datasheet_contents: string[] = []

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    expect(request.command[0]).toBe("pdftoppm")
    const page = Number(request.command[2])
    const output_prefix = request.command.at(-1)
    const datasheet_path = request.command.at(-2)
    if (!output_prefix || !datasheet_path) throw new Error("Missing pdftoppm input/output path")
    this.pages.push(page)
    this.datasheet_contents.push(await Bun.file(datasheet_path).text())
    await Bun.write(`${output_prefix}.png`, png_bytes)
    return { exit_code: 0, duration_ms: 1, output_tail: "" }
  }
}

test("modeled requirement citations become deterministic server-rendered reference pages", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "model-evidence-pages-"))
  const canonical_workspace = await mkdtemp(join(tmpdir(), "model-evidence-canonical-"))
  temporary_directories.push(workspace, canonical_workspace)
  await Promise.all([
    Bun.write(join(workspace, "datasheet.pdf"), "%PDF agent-mutated fixture"),
    Bun.write(join(canonical_workspace, "datasheet.pdf"), "%PDF canonical fixture"),
  ])
  const characterization: ModelCharacterization = {
    version: 1,
    family: "sensor",
    strategy: "behavioral",
    requirements: [
      {
        requirement_id: "curve",
        title: "Curve",
        behavior: "Observable curve",
        analysis: "dc_sweep",
        support: { status: "modeled" },
        conditions: {},
        expected: { unit: "V", min: 0, max: 1 },
        reference_curve: {
          x_quantity: "input voltage",
          x_unit: "V",
          y_quantity: "output voltage",
          y_unit: "V",
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
          image: "evidence/agent-crop.png",
        },
        sources: [
          { page: 6, locator: "Figure 1", statement: "Curve" },
          { page: 5, locator: "Table 1", statement: "Limit" },
        ],
      },
      {
        requirement_id: "digital",
        title: "Digital",
        behavior: "Register output",
        analysis: "operating_point",
        support: { status: "documented_only", reason: "No analog output" },
        conditions: {},
        expected: { unit: "code", target: 1 },
        sources: [{ page: 99, locator: "Register map", statement: "Digital only" }],
      },
    ],
    assumptions: [],
    limitations: [],
  }
  const runner = new PdfPageRunner()
  const materialized = await materializeModelEvidencePages({
    workspace,
    datasheet_path: join(canonical_workspace, "datasheet.pdf"),
    characterization,
    process_runner: runner,
    signal: new AbortController().signal,
  })

  expect(runner.pages).toEqual([5, 6])
  expect(runner.datasheet_contents).toEqual(["%PDF canonical fixture", "%PDF canonical fixture"])
  expect(materialized.requirements[0]?.sources.map(({ image }) => image)).toEqual([
    "evidence/source-page-6.png",
    "evidence/source-page-5.png",
  ])
  expect(materialized.requirements[0]?.reference_curve?.image).toBe("evidence/source-page-6.png")
  expect(materialized.requirements[1]?.sources[0]?.image).toBeUndefined()
  expect(await Bun.file(join(workspace, "evidence", "source-page-5.png")).exists()).toBe(true)
  expect(characterization.requirements[0]?.reference_curve?.image).toBe("evidence/agent-crop.png")
})

test("server evidence rendering rejects an agent-owned evidence-directory symlink", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "model-evidence-symlink-"))
  const canonical_workspace = await mkdtemp(join(tmpdir(), "model-evidence-symlink-source-"))
  const outside = await mkdtemp(join(tmpdir(), "model-evidence-symlink-target-"))
  temporary_directories.push(workspace, canonical_workspace, outside)
  await Promise.all([
    Bun.write(join(canonical_workspace, "datasheet.pdf"), "%PDF canonical fixture"),
    symlink(outside, join(workspace, "evidence")),
  ])
  const characterization: ModelCharacterization = {
    version: 1,
    family: "sensor",
    strategy: "behavioral",
    requirements: [
      {
        requirement_id: "output",
        title: "Output",
        behavior: "Output voltage",
        analysis: "operating_point",
        support: { status: "modeled" },
        conditions: {},
        expected: { unit: "V", target: 1 },
        sources: [{ page: 1, locator: "Table 1", statement: "Output is one volt" }],
      },
    ],
    assumptions: [],
    limitations: [],
  }

  await expect(
    materializeModelEvidencePages({
      workspace,
      datasheet_path: join(canonical_workspace, "datasheet.pdf"),
      characterization,
      process_runner: new PdfPageRunner(),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/real directory, not a symlink/)
  expect(await Bun.file(join(outside, "source-page-1.png")).exists()).toBe(false)
})

const pdftoppm_path = Bun.which("pdftoppm")
const testWithPdftoppm = pdftoppm_path ? test : test.skip
testWithPdftoppm("renders canonical evidence with the real production PDF tool", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "model-evidence-real-pdftoppm-"))
  temporary_directories.push(workspace)
  const characterization: ModelCharacterization = {
    version: 1,
    family: "sensor",
    strategy: "behavioral",
    requirements: [
      {
        requirement_id: "real_pdf_page",
        title: "Real PDF page",
        behavior: "Retain the cited page",
        analysis: "operating_point",
        support: { status: "modeled" },
        conditions: {},
        expected: { unit: "V", target: 1 },
        sources: [{ page: 1, locator: "Fixture page", statement: "Rendered by pdftoppm" }],
      },
    ],
    assumptions: [],
    limitations: [],
  }

  const materialized = await materializeModelEvidencePages({
    workspace,
    datasheet_path: join(import.meta.dir, "fixtures", "sample-datasheet.pdf"),
    characterization,
    process_runner: new BunProcessRunner(),
    signal: new AbortController().signal,
  })

  const rendered_path = join(workspace, "evidence", "source-page-1.png")
  expect(materialized.requirements[0]?.sources[0]?.image).toBe("evidence/source-page-1.png")
  expect(await Bun.file(rendered_path).exists()).toBe(true)
  expect(Bun.file(rendered_path).size).toBeGreaterThan(1_000)
})
