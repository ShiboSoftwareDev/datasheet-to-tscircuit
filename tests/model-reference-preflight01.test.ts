import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { afterEach, expect, test } from "bun:test"
import type { AgentClient } from "@/server/infrastructure/agent"
import { runAgentArtifactStage } from "@/server/infrastructure/agent"
import { createStageWorkspace } from "@/server/infrastructure/artifacts"
import type { ProcessRunner } from "@/server/infrastructure/process"
import {
  assertComparisonGraphPreservesDiscovery,
  assertReferenceGraphObservationVerified,
  referenceGraphDiscoveryPreflightErrors,
} from "@/server/model-workflow/characterization/source-inventory"
import { runReferenceGraphWorkerPool } from "@/server/model-workflow/characterization/reference-graph-worker-pool"
import {
  analyzeReferenceGraphPreflight,
  buildReferenceGraphPreflight,
  buildReferenceGraphSourceProof,
} from "@/server/model-workflow/reference-graph-axis-proof"
import {
  hasRightEdgeScopeControlStrip,
  preferredTimeDivisionScale,
} from "@/server/model-workflow/reference-graph-axis-proof/scope-divisions"
import type { ReferenceDivisionScaleSource } from "@/server/model-workflow/reference-graph-axis-proof/types"
import { buildSingleComparisonReferenceGraphObserverPrompt } from "@/server/model-workflow/reference-graph-observation"
import type {
  ObservedReferenceGraph,
  ReferenceGraphObservation,
} from "@/server/model-workflow/reference-graph-observation"

const temporary_directories: string[] = []

afterEach(async () => {
  await Promise.all(temporary_directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function calibratedGraphPdf(): Uint8Array {
  const x_labels = [
    [62, "0 s"],
    [98, "1 s"],
    [134, "2 s"],
    [170, "3 s"],
    [206, "4 s"],
  ]
  const y_labels = [
    [68, "0.0 V"],
    [91.4, "0.5 V"],
    [114.8, "1.0 V"],
    [138.2, "1.5 V"],
    [161.6, "2.0 V"],
  ]
  const commands = [
    "0.82 G",
    "0.35 w",
    ...Array.from({ length: 5 }, (_, index) => {
      const x = 72 + index * 36
      return `${x} 72 m ${x} 165.6 l S`
    }),
    ...Array.from({ length: 5 }, (_, index) => {
      const y = 72 + index * 23.4
      return `72 ${y} m 216 ${y} l S`
    }),
    "0 0 0 RG",
    "0.8 w",
    "72 72 m 216 72 l S",
    "72 72 m 72 165.6 l S",
    "0.078431 0.313725 0.705882 RG",
    "1.2 w",
    "72 72 m 108 95.4 l 144 118.8 l 180 142.2 l 216 165.6 l S",
    "0 0 0 rg",
    ...x_labels.map(([x, label]) => `BT /F1 7 Tf ${x} 45 Td (${label}) Tj ET`),
    ...y_labels.map(([y, label]) => `BT /F1 10 Tf 8 ${y} Td (${label}) Tj ET`),
    "BT /F1 10 Tf 121 15 Td (Figure 1.) Tj ET",
  ].join("\n")
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 288 216] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
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

const crc32_table = Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
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

function setDeterministicGridPixel({
  scanlines,
  rowBytes,
  x,
  y,
}: {
  scanlines: Buffer
  rowBytes: number
  x: number
  y: number
}): void {
  const offset = y * (rowBytes + 1) + 1 + x * 3
  scanlines[offset] = 180
  scanlines[offset + 1] = 180
  scanlines[offset + 2] = 180
}

function appendDeterministicTesseractWord({
  rows,
  block,
  line,
  index,
  left,
  top,
  text,
}: {
  rows: string[]
  block: number
  line: number
  index: number
  left: number
  top: number
  text: string
}): void {
  rows.push(`5\t1\t${block}\t1\t${line}\t${index}\t${left}\t${top}\t30\t30\t95\t${text}`)
}

function deterministicGridPng(width: number, height: number): Uint8Array {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const rowBytes = width * 3
  const scanlines = Buffer.alloc((rowBytes + 1) * height, 255)
  for (let y = 0; y < height; y += 1) scanlines[y * (rowBytes + 1)] = 0
  for (const x of [150, 300, 450, 600, 750, 810, 830, 842, 855, 870]) {
    for (let y = 0; y < height; y += 1) {
      setDeterministicGridPixel({ scanlines, rowBytes, x, y })
    }
  }
  for (const y of [120, 240, 360, 480, 600]) {
    for (let x = 0; x < width; x += 1) {
      setDeterministicGridPixel({ scanlines, rowBytes, x, y })
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND"),
  ])
}

function deterministicTesseractTsv(): string {
  const rows = [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
  ]
  ;[0, 1, 2, 3, 4].forEach((seconds, index) =>
    appendDeterministicTesseractWord({
      rows,
      block: 1,
      line: 1,
      index: index + 1,
      left: 135 + index * 150,
      top: 615,
      text: `${seconds}s`,
    }),
  )
  ;[0, 1, 2, 3, 4].forEach((volts, index) =>
    appendDeterministicTesseractWord({
      rows,
      block: 2,
      line: index + 1,
      index: 1,
      left: 15,
      top: 585 - index * 120,
      text: `${volts}V`,
    }),
  )
  return `${rows.join("\n")}\n`
}

function deterministicScopeTsv(): string {
  return [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    "5\t1\t1\t1\t1\t1\t30\t30\t70\t24\t95\t2V/div",
    "",
  ].join("\n")
}

class DeterministicPreflightRunner implements ProcessRunner {
  readonly command_labels: string[] = []

  async run(request: Parameters<ProcessRunner["run"]>[0]) {
    this.command_labels.push(request.command_label)
    if (request.command[0] === "tesseract" && request.command[1] === "--version") {
      return { exit_code: 0, duration_ms: 1, output_tail: "tesseract 5.4.0\n" }
    }
    if (request.command[0] === "pdftoppm") {
      await Bun.write(`${request.command.at(-1)}.png`, deterministicGridPng(900, 660))
      return { exit_code: 0, duration_ms: 1, output_tail: "" }
    }
    if (request.command[0] === "tesseract") {
      await Bun.write(
        `${request.command[2]}.tsv`,
        request.command_label.startsWith("OCR channel-panel")
          ? deterministicScopeTsv()
          : deterministicTesseractTsv(),
      )
      return { exit_code: 0, duration_ms: 1, output_tail: "" }
    }
    if (request.command[0] === "pdftotext") {
      await Bun.write(
        request.command.at(-1)!,
        '<word xMin="40" yMin="70" xMax="62" yMax="75">Figure</word><word xMin="64" yMin="70" xMax="70" yMax="75">1.</word>',
      )
      return { exit_code: 0, duration_ms: 1, output_tail: "" }
    }
    throw new Error(`Unexpected deterministic preflight command: ${request.command.join(" ")}`)
  }
}

function foundGraph(): ObservedReferenceGraph & {
  response_quantity: "voltage"
  public_pin_observable: true
  fixture_reproducible: true
} {
  return {
    graph_id: "explicit_tick_graph",
    page: 1,
    locator: "Figure 1. Explicit voltage transient",
    x_axis: "time",
    time_axis_evidence: "0 s through 4 s",
    response_quantity: "voltage",
    public_pin_observable: true,
    fixture_reproducible: true,
    reason: "Generated deterministic preflight fixture",
    crop: {
      page: 1,
      render_dpi: 200,
      x_px: 0,
      y_px: 0,
      width_px: 300,
      height_px: 220,
    },
  }
}

function eligibleObservation(source_pdf_sha256: string): ReferenceGraphObservation {
  return {
    version: 1,
    source_pdf_sha256,
    reviewed_hints: [],
    graphs: [
      {
        ...foundGraph(),
        electrical_binding: {
          response: {
            type: "voltage",
            positive: "dut.OUT",
            negative: "gnd",
            nominal_volts: 2,
          },
          stimulus: {
            type: "voltage_step",
            positive: "dut.IN",
            negative: "gnd",
            pulse: {
              low: 0,
              high: 1,
              delay: 0,
              rise: 0.1,
              fall: 0.1,
              width: 2,
              period: 5,
            },
          },
        },
        channels: [
          {
            channel_id: "output_voltage",
            label: "OUT",
            role: "response",
            measurement: {
              type: "voltage",
              positive: "dut.OUT",
              negative: "gnd",
            },
            digitized_curve: {
              method: "manual_pixel_trace",
              x_quantity: "time",
              x_unit: "s",
              y_quantity: "voltage",
              y_unit: "V",
              x_range: { min: 0, max: 4 },
              y_range: { min: 0, max: 2 },
              x_axis: {
                scale: "linear",
                first: { pixel: 50, value: 0 },
                second: { pixel: 250, value: 4 },
              },
              y_axis: {
                scale: "linear",
                first: { pixel: 200, value: 0 },
                second: { pixel: 40, value: 4 },
              },
              trace_color: { r: 20, g: 80, b: 180, tolerance: 24 },
              points: Array.from({ length: 8 }, (_, index) => ({
                pixel_x: 50 + (index / 7) * 200,
                pixel_y: 200 - (index / 7) * 160,
                x: (index / 7) * 4,
                y: (index / 7) * 2,
              })),
            },
          },
        ],
      },
    ],
  }
}

test("Find-stage preflight owns immutable crop calibration viability", () => {
  const complete = {
    version: 1,
    graph_id: "graph",
    source_pdf_sha256: "a".repeat(64),
    page: 1,
    canonical_crop: foundGraph().crop,
    canonical_crop_sha256: "b".repeat(64),
    figure_identity: {
      algorithm: "pdftotext_bbox_adjacent_figure_v1",
      normalized_figure: "figure 1",
      source_text: "Figure 1",
      bbox_pdf_points: { x_min: 1, y_min: 1, x_max: 2, y_max: 2 },
      crop_edge_gap_pdf_points: 0,
      bbox_output_sha256: "c".repeat(64),
    },
    x_axis: {
      quantity: "time",
      unit: "s",
      elapsed_time_origin: 0,
      grid_line_candidates_px: [],
      division_scale_candidates: [],
      source_seconds_per_pixel_candidates: [0.001],
      required_anchor_value_span_candidates: [],
    },
    y_axis: {
      quantity: "voltage",
      unit: "V",
      grid_line_candidates_px: [],
      division_scale_candidates: [],
      source_volts_per_pixel_candidates: [0.01],
      required_anchor_value_span_candidates: [],
    },
    recognized_measurements: [],
  } satisfies import("@/server/model-workflow/reference-graph-axis-proof").ReferenceGraphPreflight

  expect(referenceGraphDiscoveryPreflightErrors(complete)).toEqual([])
  expect(
    referenceGraphDiscoveryPreflightErrors({
      ...complete,
      x_axis: {
        ...complete.x_axis,
        source_seconds_per_pixel_candidates: [],
        division_scale_candidates: [
          { raw_text: "100 us/div", value_per_division_si: 100e-6, observer_center_px: { x: 20, y: 10 } },
        ],
      },
      y_axis: {
        ...complete.y_axis,
        source_volts_per_pixel_candidates: [],
        division_scale_candidates: [
          { raw_text: "100 mV/div", value_per_division_si: 0.1, observer_center_px: { x: 20, y: 40 } },
        ],
      },
    }),
  ).toEqual([])
  expect(
    referenceGraphDiscoveryPreflightErrors({
      ...complete,
      figure_identity: undefined,
      y_axis: { ...complete.y_axis, source_volts_per_pixel_candidates: [] },
    }),
  ).toEqual([
    "the immutable crop does not include or immediately adjoin its own printed figure identity",
    "the immutable crop has no unambiguous printed voltage calibration",
  ])
})

test("preflight prefers a printed time-per-division label over a compact cursor readout", () => {
  const candidate = (raw_text: string, value_per_division_si: number): ReferenceDivisionScaleSource => ({
    raw_text,
    normalized_unit: "s",
    value_per_division_si,
    confidence: 95,
    ocr_bbox_px: { left: 0, top: 0, width: 30, height: 20 },
  })
  const printed_timebase = candidate("500 us/div", 500e-6)
  const cursor_readout = candidate("500 ps", 500e-12)

  expect(
    preferredTimeDivisionScale({
      full_candidates: [printed_timebase, cursor_readout],
      horizontal_candidates: [],
      channel_candidates: [],
      scope_control_candidates: [cursor_readout],
    }),
  ).toEqual(printed_timebase)
})

test("preflight keeps scope OCR in a physical control strip beside the plot", () => {
  expect(hasRightEdgeScopeControlStrip({ render_width: 693 * 3, plot_right_px: 572 })).toBe(true)
  expect(hasRightEdgeScopeControlStrip({ render_width: 693 * 3, plot_right_px: 650 })).toBe(false)
})

test("reference graph preflight deterministically extracts immutable source calibration", async () => {
  const root = await mkdtemp(join(tmpdir(), "reference-preflight-"))
  temporary_directories.push(root)
  const datasheet_path = join(root, "datasheet.pdf")
  const pdf = calibratedGraphPdf()
  await Bun.write(datasheet_path, pdf)
  const source_pdf_sha256 = createHash("sha256").update(pdf).digest("hex")
  const analyze = () =>
    analyzeReferenceGraphPreflight({
      graph: foundGraph(),
      source_pdf_sha256,
      datasheet_path,
      process_runner: new DeterministicPreflightRunner(),
      signal: new AbortController().signal,
    })

  const first_analysis = await analyze()
  const second_analysis = await analyze()
  const first = first_analysis.preflight
  const second = second_analysis.preflight

  expect(second).toEqual(first)
  expect(first).toMatchObject({
    version: 1,
    graph_id: "explicit_tick_graph",
    source_pdf_sha256,
    figure_identity: { normalized_figure: "figure1" },
    x_axis: {
      elapsed_time_origin: 0,
    },
  })
  expect(first.x_axis.explicit_tick_calibration?.supporting_tick_count).toBeGreaterThanOrEqual(3)
  expect(first.x_axis.grid_line_candidates_px.length).toBeGreaterThanOrEqual(4)
  expect(first.y_axis.grid_line_candidates_px.length).toBeGreaterThanOrEqual(4)
  expect(first.x_axis.recommended_anchor_pixels?.maximum_value_pixel).toBeCloseTo(250, 6)
  expect(first.y_axis.division_scale_candidates).toEqual([
    expect.objectContaining({ raw_text: "2V/div", value_per_division_si: 2 }),
  ])
  expect(first.x_axis.source_seconds_per_pixel_candidates).toHaveLength(1)
  expect(first_analysis.source_analysis.selected_time_scale).toBeUndefined()

  const verification_runner = new DeterministicPreflightRunner()
  await buildReferenceGraphSourceProof({
    observation: eligibleObservation(source_pdf_sha256),
    datasheet_path,
    process_runner: verification_runner,
    signal: new AbortController().signal,
    immutable_source_analysis_by_graph_id: {
      explicit_tick_graph: first_analysis.source_analysis,
    },
  })
  expect(verification_runner.command_labels).not.toContain("Read reference-axis OCR engine version")
  expect(
    verification_runner.command_labels.some((label) => label.startsWith("Render canonical axis crop")),
  ).toBe(false)
  expect(
    verification_runner.command_labels.some((label) => label.startsWith("OCR canonical axis crop")),
  ).toBe(false)
  expect(
    verification_runner.command_labels.some((label) => label.startsWith("Extract canonical figure geometry")),
  ).toBe(false)
})

test("attempt one receives preflight and a bad first attempt still uses cumulative correction", async () => {
  const root = await mkdtemp(join(tmpdir(), "reference-preflight-agent-"))
  temporary_directories.push(root)
  const inputs = join(root, "inputs")
  const debug_dir = join(root, "debug")
  await mkdir(inputs, { recursive: true })
  const preflight = {
    version: 1,
    graph_id: "graph_1",
    x_axis: {
      grid_line_candidates_px: [10, 110],
      required_anchor_value_span_candidates: [0.001],
    },
  }
  await Promise.all([
    Bun.write(join(inputs, "seed.json"), `${JSON.stringify({ graph_id: "graph_1" })}\n`),
    Bun.write(join(inputs, "preflight.json"), `${JSON.stringify(preflight)}\n`),
  ])
  const prompts: string[] = []
  const received_preflights: unknown[] = []
  const received_seeds: unknown[] = []
  const agent_client: AgentClient = {
    async run(input) {
      prompts.push(input.prompt)
      received_preflights.push(await Bun.file(join(input.workspace, "reference-graph-preflight.json")).json())
      received_seeds.push(await Bun.file(join(input.workspace, "model-reference-graph.json")).json())
      await Bun.write(
        join(input.workspace, "model-reference-graph.json"),
        `${JSON.stringify({ graph_id: "graph_1", accepted: prompts.length === 2 })}\n`,
      )
      return { attempts: 1, duration_ms: 5, output_tail: "" }
    },
  }

  const result = await runAgentArtifactStage({
    stage_id: "preflight_retry_test",
    phase_label: "Preflight retry test",
    max_artifact_attempts: 2,
    signal: new AbortController().signal,
    use_openai: false,
    agent_client,
    create_workspace: () =>
      createStageWorkspace({
        prefix: "preflight-retry",
        files: [
          {
            source: join(inputs, "seed.json"),
            destination: "model-reference-graph.json",
          },
          {
            source: join(inputs, "preflight.json"),
            destination: "reference-graph-preflight.json",
          },
        ],
      }),
    build_prompt: (feedback) => buildSingleComparisonReferenceGraphObserverPrompt("graph_1", feedback),
    validate: async (workspace, attempt) => {
      const candidate = await Bun.file(join(workspace, "model-reference-graph.json")).json()
      if (attempt === 1) throw new Error("trace pixel mismatch")
      return candidate
    },
    promote: async () => undefined,
    rejection_debug: { debug_dir, files: ["model-reference-graph.json"] },
    on_output: () => undefined,
  })

  expect(result.attempts).toBe(2)
  expect(received_preflights).toEqual([preflight, preflight])
  expect(received_seeds[0]).toEqual({ graph_id: "graph_1" })
  expect(received_seeds[1]).toEqual({ graph_id: "graph_1", accepted: false })
  expect(prompts[0]).toContain("reference-graph-preflight.json")
  expect(prompts[0]).not.toContain("trace pixel mismatch")
  expect(prompts[1]).toContain("Rejected attempt 1")
  expect(prompts[1]).toContain("trace pixel mismatch")
})

test("preflight guidance cannot authorize bad pixels or discovery-field edits", () => {
  const source_graph = foundGraph()
  const moved_graph = structuredClone(source_graph)
  moved_graph.crop.x_px += 1
  expect(() =>
    assertComparisonGraphPreservesDiscovery({
      source_pdf_sha256: "a".repeat(64),
      found_graph: source_graph,
      candidate_graph: moved_graph,
    }),
  ).toThrow(/preserve every discovery field/)

  const eligible_graph: ObservedReferenceGraph = {
    ...source_graph,
    electrical_binding: {
      response: {
        type: "voltage" as const,
        positive: "dut.OUT",
        negative: "gnd",
        nominal_volts: 1,
      },
      stimulus: {
        type: "voltage_step" as const,
        positive: "dut.IN",
        negative: "gnd",
        pulse: {
          low: 0,
          high: 1,
          delay: 0,
          rise: 1e-6,
          fall: 1e-6,
          width: 1e-3,
          period: 2e-3,
        },
      },
    },
    channels: [],
  }
  const observation: ReferenceGraphObservation = {
    version: 1,
    source_pdf_sha256: "a".repeat(64),
    reviewed_hints: [],
    graphs: [eligible_graph],
  }
  expect(() =>
    assertReferenceGraphObservationVerified({
      observation,
      source_proof: {
        version: 1,
        source_pdf_sha256: observation.source_pdf_sha256,
        results: [],
      },
      pixel_rejection: new Error("candidate trace points do not match pixels"),
    }),
  ).toThrow(/candidate trace points do not match pixels/)
})

test("parallel completion order cannot reorder graph preflights", async () => {
  const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const run = runReferenceGraphWorkerPool({
    graphs: ["graph_1", "graph_2"],
    concurrency: 2,
    signal: new AbortController().signal,
    async digitize(graph, index) {
      started[index]!.resolve()
      await releases[index]!.promise
      return { graph_id: graph, preflight: { graph_id: graph, version: 1 } }
    },
  })
  await Promise.all(started.map(({ promise }) => promise))
  releases[1]!.resolve()
  releases[0]!.resolve()
  expect(await run).toEqual([
    { graph_id: "graph_1", preflight: { graph_id: "graph_1", version: 1 } },
    { graph_id: "graph_2", preflight: { graph_id: "graph_2", version: 1 } },
  ])
})

test("cancellation during preflight propagates without becoming an artifact rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "reference-preflight-cancel-"))
  temporary_directories.push(root)
  const datasheet_path = join(root, "datasheet.pdf")
  const pdf = calibratedGraphPdf()
  await Bun.write(datasheet_path, pdf)
  const source_pdf_sha256 = createHash("sha256").update(pdf).digest("hex")
  const controller = new AbortController()
  const cancellation = new Error("operator cancelled during preflight")
  const process_runner: ProcessRunner = {
    async run() {
      controller.abort(cancellation)
      throw cancellation
    },
  }

  const caught = await buildReferenceGraphPreflight({
    graph: foundGraph(),
    source_pdf_sha256,
    datasheet_path,
    process_runner,
    signal: controller.signal,
  }).catch((error) => error)

  expect(caught).toBe(cancellation)
  expect(await Bun.file(join(root, "attempt-history.json")).exists()).toBe(false)
})
