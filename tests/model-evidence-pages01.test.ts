import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import {
  BunProcessRunner,
  type ProcessRunner,
  type ProcessRunRequest,
  type ProcessRunResult,
} from "@/server/infrastructure/process"
import { materializeModelEvidencePages } from "@/server/model-workflow/model-evidence-pages"
import type { ModelCharacterization, ModelReferenceCropRegion } from "@/server/modeling"

const temporary_directories: string[] = []

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

type CropPixels = "graph" | "blank" | "near-uniform" | "transparent-graph"

function minimalPng(width: number, height: number, pixels: CropPixels = "graph"): Uint8Array {
  const has_alpha = pixels === "transparent-graph"
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, has_alpha ? 6 : 2, 0, 0, 0], 8)
  const channels = has_alpha ? 4 : 3
  const row_bytes = width * channels
  const scanlines = Buffer.alloc((row_bytes + 1) * height, 255)
  for (let y = 0; y < height; y += 1) scanlines[y * (row_bytes + 1)] = 0
  const setPixel = (x: number, y: number, value = 0) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const offset = y * (row_bytes + 1) + 1 + x * channels
    scanlines.fill(value, offset, offset + channels)
  }
  const drawLine = (x0: number, y0: number, x1: number, y1: number) => {
    const dx = Math.abs(x1 - x0)
    const sx = x0 < x1 ? 1 : -1
    const dy = -Math.abs(y1 - y0)
    const sy = y0 < y1 ? 1 : -1
    let error = dx + dy
    while (true) {
      setPixel(x0, y0)
      setPixel(x0 + 1, y0)
      if (x0 === x1 && y0 === y1) break
      const doubled = error * 2
      if (doubled >= dy) {
        error += dy
        x0 += sx
      }
      if (doubled <= dx) {
        error += dx
        y0 += sy
      }
    }
  }
  if (pixels === "graph" || pixels === "transparent-graph") {
    const left = Math.max(2, Math.floor(width * 0.15))
    const right = Math.max(left + 1, width - Math.max(3, Math.floor(width * 0.08)))
    const top = Math.max(2, Math.floor(height * 0.1))
    const bottom = Math.max(top + 1, height - Math.max(3, Math.floor(height * 0.15)))
    drawLine(left, top, left, bottom)
    drawLine(left, bottom, right, bottom)
    drawLine(left, bottom - 2, Math.floor((left + right) / 2), Math.floor((top + bottom) / 2))
    drawLine(Math.floor((left + right) / 2), Math.floor((top + bottom) / 2), right, top + 2)
  } else if (pixels === "near-uniform") {
    let remaining = 127
    for (let y = 2; y < height - 2 && remaining > 0; y += 1) {
      for (let x = 2; x < width - 2 && remaining > 0; x += 1) {
        setPixel(x, y)
        remaining -= 1
      }
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND"),
  ])
}

function graphPdf(): Uint8Array {
  const graph_commands = [
    "3 w",
    "50 600 m 250 600 l S",
    "50 600 m 50 700 l S",
    "50 605 m 95 620 l 140 650 l 190 680 l 240 690 l S",
  ].join("\n")
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(graph_commands)} >>\nstream\n${graph_commands}\nendstream`,
  ]
  let pdf = "%PDF-1.4\n"
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref_offset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")
  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref_offset}\n%%EOF\n`
  return Buffer.from(pdf, "ascii")
}

afterEach(async () => {
  await Promise.all(temporary_directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class PdfPageRunner implements ProcessRunner {
  readonly pages: number[] = []
  readonly datasheet_contents: string[] = []
  readonly commands: string[][] = []

  constructor(
    private readonly crop_dimension_delta = 0,
    private readonly crop_pixels: CropPixels = "graph",
  ) {}

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    expect(request.command[0]).toBe("pdftoppm")
    const page = Number(request.command[2])
    const output_prefix = request.command.at(-1)
    const datasheet_path = request.command.at(-2)
    if (!output_prefix || !datasheet_path) throw new Error("Missing pdftoppm input/output path")
    this.pages.push(page)
    this.commands.push([...request.command])
    this.datasheet_contents.push(await Bun.file(datasheet_path).text())
    const width_index = request.command.indexOf("-W")
    const height_index = request.command.indexOf("-H")
    const width = width_index === -1 ? 200 : Number(request.command[width_index + 1])
    const height = height_index === -1 ? 160 : Number(request.command[height_index + 1])
    await Bun.write(
      `${output_prefix}.png`,
      minimalPng(
        width + (width_index === -1 ? 0 : this.crop_dimension_delta),
        height,
        width_index === -1 ? "graph" : this.crop_pixels,
      ),
    )
    return { exit_code: 0, duration_ms: 1, output_tail: "" }
  }
}

function characterizationWithCrop(crop: ModelReferenceCropRegion): ModelCharacterization {
  return {
    version: 1,
    family: "sensor",
    strategy: "behavioral",
    requirements: [
      {
        requirement_id: "step_response",
        title: "Step response",
        behavior: "Follow the printed response",
        analysis: "transient",
        support: { status: "modeled" },
        conditions: {},
        expected: { unit: "V", min: 0, max: 1 },
        reference_curve: {
          x_quantity: "time",
          x_unit: "s",
          y_quantity: "voltage",
          y_unit: "V",
          points: [
            { x: 0, y: 0 },
            { x: 0.0005, y: 0.125 },
            { x: 0.001, y: 0.25 },
            { x: 0.0015, y: 0.375 },
            { x: 0.002, y: 0.5 },
            { x: 0.0025, y: 0.625 },
            { x: 0.003, y: 0.75 },
            { x: 0.004, y: 1 },
          ],
          crop,
        },
        sources: [{ page: 1, locator: "Figure 1", statement: "Step response" }],
      },
    ],
    assumptions: [],
    limitations: [],
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
        analysis: "transient",
        support: { status: "modeled" },
        conditions: {},
        expected: { unit: "V", min: 0, max: 1 },
        reference_curve: {
          x_quantity: "time",
          x_unit: "s",
          y_quantity: "voltage",
          y_unit: "V",
          points: [
            { x: 0, y: 0 },
            { x: 0.0005, y: 0.125 },
            { x: 0.001, y: 0.25 },
            { x: 0.0015, y: 0.375 },
            { x: 0.002, y: 0.5 },
            { x: 0.0025, y: 0.625 },
            { x: 0.003, y: 0.75 },
            { x: 0.004, y: 1 },
          ],
          crop: {
            page: 6,
            render_dpi: 200,
            x_px: 10,
            y_px: 20,
            width_px: 96,
            height_px: 64,
          },
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

  expect(runner.pages).toEqual([5, 6, 6])
  expect(runner.datasheet_contents).toEqual([
    "%PDF canonical fixture",
    "%PDF canonical fixture",
    "%PDF canonical fixture",
  ])
  expect(runner.commands[2]?.slice(5, 15)).toEqual([
    "-r",
    "200",
    "-x",
    "10",
    "-y",
    "20",
    "-W",
    "96",
    "-H",
    "64",
  ])
  expect(materialized.requirements[0]?.sources.map(({ image }) => image)).toEqual([
    "evidence/source-page-6.png",
    "evidence/source-page-5.png",
  ])
  expect(materialized.requirements[0]?.reference_curve?.image).toBe("evidence/figures/curve.png")
  expect(materialized.requirements[1]?.sources[0]?.image).toBeUndefined()
  expect(await Bun.file(join(workspace, "evidence", "source-page-5.png")).exists()).toBe(true)
  expect(await Bun.file(join(workspace, "evidence", "figures", "curve.png")).exists()).toBe(true)
  expect(characterization.requirements[0]?.reference_curve?.image).toBe("evidence/agent-crop.png")
})

test("channels from one source graph share one canonical reference crop", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "model-evidence-shared-graph-"))
  temporary_directories.push(workspace)
  await Bun.write(join(workspace, "datasheet.pdf"), "%PDF canonical fixture")
  const crop: ModelReferenceCropRegion = {
    page: 1,
    render_dpi: 200,
    x_px: 10,
    y_px: 20,
    width_px: 96,
    height_px: 64,
  }
  const characterization = characterizationWithCrop(crop)
  const response = characterization.requirements[0]!
  response.requirement_id = "figure_1__output_voltage"
  response.conditions = { graph_id: "figure_1", channel_id: "output_voltage" }
  const stimulus = structuredClone(response)
  stimulus.requirement_id = "figure_1__load_current"
  stimulus.conditions = { graph_id: "figure_1", channel_id: "load_current" }
  characterization.requirements.push(stimulus)
  const runner = new PdfPageRunner()

  const materialized = await materializeModelEvidencePages({
    workspace,
    datasheet_path: join(workspace, "datasheet.pdf"),
    characterization,
    process_runner: runner,
    signal: new AbortController().signal,
  })

  expect(runner.pages).toEqual([1, 1])
  expect(materialized.requirements.map((requirement) => requirement.reference_curve?.image)).toEqual([
    "evidence/figures/figure_1.png",
    "evidence/figures/figure_1.png",
  ])
  expect(await Bun.file(join(workspace, "evidence", "figures", "figure_1.png")).exists()).toBe(true)
  expect(await Bun.file(join(workspace, "evidence", "figures", "figure_1__load_current.png")).exists()).toBe(
    false,
  )
})

test("server evidence rendering rejects out-of-bounds, full-page, and clamped graph crops", async () => {
  const cases: Array<{
    label: string
    crop: ModelReferenceCropRegion
    runner: PdfPageRunner
    expected_error: RegExp
  }> = [
    {
      label: "out-of-bounds",
      crop: {
        page: 1,
        render_dpi: 200,
        x_px: 190,
        y_px: 20,
        width_px: 20,
        height_px: 64,
      },
      runner: new PdfPageRunner(),
      expected_error: /out of bounds on PDF page 1.*200x160 pixels at 200 DPI/,
    },
    {
      label: "full-page",
      crop: {
        page: 1,
        render_dpi: 200,
        x_px: 0,
        y_px: 0,
        width_px: 200,
        height_px: 160,
      },
      runner: new PdfPageRunner(),
      expected_error: /is the full PDF page/,
    },
    {
      label: "wrong-render-size",
      crop: {
        page: 1,
        render_dpi: 200,
        x_px: 10,
        y_px: 20,
        width_px: 96,
        height_px: 64,
      },
      runner: new PdfPageRunner(-1),
      expected_error: /rendered as 95x64 pixels; expected exactly 96x64/,
    },
  ]

  for (const item of cases) {
    const workspace = await mkdtemp(join(tmpdir(), `model-evidence-${item.label}-`))
    const canonical_workspace = await mkdtemp(join(tmpdir(), `model-evidence-source-${item.label}-`))
    temporary_directories.push(workspace, canonical_workspace)
    await Bun.write(join(canonical_workspace, "datasheet.pdf"), "%PDF canonical fixture")
    await expect(
      materializeModelEvidencePages({
        workspace,
        datasheet_path: join(canonical_workspace, "datasheet.pdf"),
        characterization: characterizationWithCrop(item.crop),
        process_runner: item.runner,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(item.expected_error)
    expect(await Bun.file(join(workspace, "evidence", "figures", "step_response.png")).exists()).toBe(false)
  }
})

test("server evidence rendering rejects blank, transparent, and near-uniform graph crops", async () => {
  for (const item of [
    { label: "blank", pixels: "blank" as const, expected_contrast: 0 },
    { label: "transparent", pixels: "transparent-graph" as const, expected_contrast: 0 },
    { label: "near-uniform", pixels: "near-uniform" as const, expected_contrast: 127 },
  ]) {
    const workspace = await mkdtemp(join(tmpdir(), `model-evidence-${item.label}-`))
    const canonical_workspace = await mkdtemp(join(tmpdir(), `model-evidence-source-${item.label}-`))
    temporary_directories.push(workspace, canonical_workspace)
    await Bun.write(join(canonical_workspace, "datasheet.pdf"), "%PDF canonical fixture")

    await expect(
      materializeModelEvidencePages({
        workspace,
        datasheet_path: join(canonical_workspace, "datasheet.pdf"),
        characterization: characterizationWithCrop({
          page: 1,
          render_dpi: 200,
          x_px: 10,
          y_px: 20,
          width_px: 96,
          height_px: 64,
        }),
        process_runner: new PdfPageRunner(0, item.pixels),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      new RegExp(
        `blank or near-uniform \\(${item.expected_contrast} contrasting pixels; 128 required\\).*printed axes and trace`,
      ),
    )
    expect(await Bun.file(join(workspace, "evidence", "figures", "step_response.png")).exists()).toBe(false)
  }
})

test("server evidence rendering rejects an agent-owned figures symlink before rendering", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "model-evidence-figures-symlink-"))
  const canonical_workspace = await mkdtemp(join(tmpdir(), "model-evidence-figures-source-"))
  const outside = await mkdtemp(join(tmpdir(), "model-evidence-figures-target-"))
  temporary_directories.push(workspace, canonical_workspace, outside)
  await Promise.all([
    Bun.write(join(canonical_workspace, "datasheet.pdf"), "%PDF canonical fixture"),
    Bun.write(join(workspace, "evidence", ".keep"), "fixture"),
  ])
  await symlink(outside, join(workspace, "evidence", "figures"))
  const runner = new PdfPageRunner()

  await expect(
    materializeModelEvidencePages({
      workspace,
      datasheet_path: join(canonical_workspace, "datasheet.pdf"),
      characterization: characterizationWithCrop({
        page: 1,
        render_dpi: 200,
        x_px: 10,
        y_px: 20,
        width_px: 96,
        height_px: 64,
      }),
      process_runner: runner,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/figures output must be a real directory, not a symlink/)
  expect(runner.commands).toHaveLength(0)
  expect(await Bun.file(join(outside, "step_response.png")).exists()).toBe(false)
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
  const datasheet_path = join(workspace, "graph-datasheet.pdf")
  await Bun.write(datasheet_path, graphPdf())
  const characterization: ModelCharacterization = {
    version: 1,
    family: "sensor",
    strategy: "behavioral",
    requirements: [
      {
        requirement_id: "real_pdf_page",
        title: "Real PDF page",
        behavior: "Retain a cited response graph",
        analysis: "transient",
        support: { status: "modeled" },
        conditions: {},
        expected: { unit: "V", target: 1 },
        reference_curve: {
          x_quantity: "time",
          x_unit: "s",
          y_quantity: "voltage",
          y_unit: "V",
          points: [
            { x: 0, y: 0 },
            { x: 0.0005, y: 0.125 },
            { x: 0.001, y: 0.25 },
            { x: 0.0015, y: 0.375 },
            { x: 0.002, y: 0.5 },
            { x: 0.0025, y: 0.625 },
            { x: 0.003, y: 0.75 },
            { x: 0.004, y: 1 },
          ],
          crop: {
            page: 1,
            render_dpi: 200,
            x_px: 100,
            y_px: 220,
            width_px: 650,
            height_px: 360,
          },
        },
        sources: [{ page: 1, locator: "Fixture graph", statement: "Rendered by pdftoppm" }],
      },
    ],
    assumptions: [],
    limitations: [],
  }

  const materialized = await materializeModelEvidencePages({
    workspace,
    datasheet_path,
    characterization,
    process_runner: new BunProcessRunner(),
    signal: new AbortController().signal,
  })

  const rendered_path = join(workspace, "evidence", "source-page-1.png")
  expect(materialized.requirements[0]?.sources[0]?.image).toBe("evidence/source-page-1.png")
  expect(materialized.requirements[0]?.reference_curve?.image).toBe("evidence/figures/real_pdf_page.png")
  expect(await Bun.file(rendered_path).exists()).toBe(true)
  expect(await Bun.file(join(workspace, "evidence", "figures", "real_pdf_page.png")).exists()).toBe(true)
  expect(Bun.file(rendered_path).size).toBeGreaterThan(1_000)
})
