import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import {
  BunProcessRunner,
  type ProcessRunner,
  type ProcessRunRequest,
  type ProcessRunResult,
} from "../src/server/infrastructure/process"
import type { AgentClient } from "../src/server/infrastructure/agent"
import { JobStore } from "../src/server/job-store"
import { ModelRunStore } from "../src/server/model-run-store"
import { compileApplicationFixtureContract, ModelStrategyRegistry } from "../src/server/modeling"
import { parseModelReferenceElectricalBinding } from "../src/server/modeling/reference-electrical-binding"
import type {
  ModelCharacterization,
  ModelInterface,
  ModelReferenceCropRegion,
  ModelReferenceElectricalBinding,
} from "../src/server/modeling/types"
import {
  buildReferenceGraphObserverPrompt,
  eligibleObservedGraphs,
  parseReferenceGraphObservation,
  projectReferenceGraphObservationForCharacterizer,
  type ReferenceGraphObservation,
  verifyCharacterizationGraphEvidence,
  verifyReferenceGraphObservationPixels,
} from "../src/server/model-workflow/reference-graph-observation"
import { sourceProofRejectionDiagnostics } from "../src/server/model-workflow/characterization/source-inventory"
import { canonicalizeCharacterizationReferenceCrops } from "../src/server/model-workflow/reference-graph-crop-proof"
import {
  assertObserverFoundEligibleTimeDomainGraph,
  characterizeStage,
} from "../src/server/model-workflow/stages/characterize"
import {
  discoverTimeGraphHints,
  deriveTimeGraphPrintedExperiment,
  findLikelyTimeGraphCandidates,
  type TimeGraphDiscovery,
} from "../src/server/model-workflow/time-graph-hints"
import { parseAgentValidationPlan } from "../src/server/spice-validation"

const source_pdf_sha256 = "a".repeat(64)
const temporary_directories: string[] = []
const archived_run93_pdf = join(
  import.meta.dir,
  "../.runtime/jobs/ca181c1a-27ee-4013-beb9-683c7c985fc0/spice/datasheet.pdf",
)
const archived_run94_pdf = join(
  import.meta.dir,
  "../.runtime/jobs/43374555-7ee7-4a2d-b30d-658d9d5f1506/spice/datasheet.pdf",
)
const testWithArchivedRun93Pdf = Bun.which("pdftotext") && existsSync(archived_run93_pdf) ? test : test.skip
const testWithArchivedRun94Pdf = Bun.which("pdftotext") && existsSync(archived_run94_pdf) ? test : test.skip

const model_interface: ModelInterface = {
  version: 1,
  part_number: "TEST-CONVERTER",
  entry_name: "TEST_CONVERTER",
  pins: [
    { spice_node: "VIN", role: "power_input" },
    { spice_node: "VOUT", role: "power_output" },
    { spice_node: "MODE", role: "control" },
    { spice_node: "GND", role: "ground" },
  ].map(({ spice_node, role }, index) => ({
    physical_pin: String(index + 1),
    component_pin: `pin${index + 1}`,
    source_port_id: `source_port_${index + 1}`,
    spice_node,
    labels: [spice_node],
    role,
  })),
}

const electrical_binding: ModelReferenceElectricalBinding = {
  response: {
    type: "voltage" as const,
    positive: "dut.VOUT" as const,
    negative: "gnd" as const,
    nominal_volts: 3.3,
  },
  stimulus: {
    type: "current_step" as const,
    positive: "dut.VOUT" as const,
    negative: "gnd" as const,
    pulse: {
      low: 0.1,
      high: 1,
      delay: 0.0001,
      rise: 0.00001,
      fall: 0.00001,
      width: 0.0005,
      period: 0.003,
    },
  },
}

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

function coloredResponseGraphPng(
  width: number,
  height: number,
  trace_shape: "diagonal" | "flat" | "points_only" | "grid_only",
): Uint8Array {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row_bytes = width * 3
  const scanlines = Buffer.alloc((row_bytes + 1) * height, 255)
  for (let y = 0; y < height; y += 1) scanlines[y * (row_bytes + 1)] = 0

  const setPixel = (x: number, y: number, color: readonly [number, number, number]) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const offset = y * (row_bytes + 1) + 1 + x * 3
    scanlines[offset] = color[0]
    scanlines[offset + 1] = color[1]
    scanlines[offset + 2] = color[2]
  }
  const drawLine = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: readonly [number, number, number],
    thickness = 1,
  ) => {
    const dx = Math.abs(x1 - x0)
    const sx = x0 < x1 ? 1 : -1
    const dy = -Math.abs(y1 - y0)
    const sy = y0 < y1 ? 1 : -1
    let error = dx + dy
    while (true) {
      for (let offset = -Math.floor(thickness / 2); offset <= Math.floor(thickness / 2); offset += 1) {
        setPixel(x0, y0 + offset, color)
      }
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

  const black = [0, 0, 0] as const
  const blue = [20, 80, 180] as const
  drawLine(10, 10, 10, 90, black)
  drawLine(10, 90, 190, 90, black)
  for (let x = 10; x <= 190; x += 30) drawLine(x, 88, x, 92, black)
  for (let y = 10; y <= 90; y += 20) drawLine(8, y, 12, y, black)
  if (trace_shape === "diagonal") drawLine(10, 90, 190, 10, blue, 3)
  else if (trace_shape === "flat") drawLine(10, 50, 190, 50, blue, 3)
  else if (trace_shape === "points_only") {
    for (let index = 0; index < 16; index += 1) {
      const ratio = index / 15
      setPixel(Math.round(10 + ratio * 180), Math.round(90 - ratio * 80), blue)
    }
  } else {
    for (let index = 0; index < 16; index += 1) {
      const ratio = index / 15
      const x = Math.round(10 + ratio * 180)
      drawLine(x, 10, x, 90, black)
    }
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND"),
  ])
}

class ReferenceGraphCropRunner implements ProcessRunner {
  readonly calls: ProcessRunRequest[] = []

  constructor(private readonly trace_shape: "diagonal" | "flat" | "points_only" | "grid_only" = "diagonal") {}

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request)
    const output_prefix = request.command.at(-1)
    const width_index = request.command.indexOf("-W")
    const height_index = request.command.indexOf("-H")
    if (!output_prefix || width_index < 0 || height_index < 0) {
      throw new Error("Observer pixel-proof fixture requires an exact pdftoppm crop")
    }
    await Bun.write(
      `${output_prefix}.png`,
      coloredResponseGraphPng(
        Number(request.command[width_index + 1]),
        Number(request.command[height_index + 1]),
        this.trace_shape,
      ),
    )
    return { exit_code: 0, duration_ms: 1, output_tail: "" }
  }
}

afterEach(async () => {
  await Promise.all(temporary_directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const discovery: TimeGraphDiscovery = {
  version: 1,
  source_pdf_sha256,
  page_count: 12,
  hints: [
    {
      hint_id: "time_graph_001",
      page: 7,
      figure: "Figure 8-18",
      reason: "Figure 8-18. Load Transient Response",
      operating_condition_evidence:
        "Figure 8-18. Load Transient Response. VOUT = 3.3 V. IO from 100 mA to 1 A, tr = 10 us, tf = 10 us.",
      fixture_evidence_context: "Figure 8-18. VOUT = 3.3 V. IO from 100 mA to 1 A, tr = 10 us, tf = 10 us.",
      summary_fixture_evidence_context: null,
      condition_conflicts: [],
      unsupported_fixture_conditions: [],
      transient_fixture_evidence: {
        method: "printed_experiment_conditions_v2",
        source_excerpts: [
          {
            scope: "graph_caption",
            text: "Figure 8-18. VOUT = 3.3 V. IO from 100 mA to 1 A, tr = 10 us, tf = 10 us.",
          },
        ],
        response: { signal: "VO", quantity: "voltage", nominal_volts: 3.3 },
        stimulus: {
          signal: "IO",
          type: "current_step",
          low: 0.1,
          high: 1,
          rise: 0.00001,
          fall: 0.00001,
        },
        auxiliary_conditions: [],
      },
    },
    {
      hint_id: "time_graph_002",
      page: 8,
      figure: "Figure 8-19",
      reason: "printed TIME (200 us / div) axis",
      operating_condition_evidence: "Figure 8-19. TIME (200 us / div)",
      fixture_evidence_context: "Figure 8-19. TIME (200 us / div)",
      summary_fixture_evidence_context: null,
      condition_conflicts: [],
      unsupported_fixture_conditions: [],
      transient_fixture_evidence: null,
    },
  ],
}

const observer_crop: ModelReferenceCropRegion = {
  page: 7,
  render_dpi: 200,
  x_px: 100,
  y_px: 200,
  width_px: 200,
  height_px: 100,
}

function linearVoltagePoints(count: number, reverse = false) {
  return Array.from({ length: count }, (_, index) => {
    const ratio = index / (count - 1)
    return {
      x: ratio * 0.0015,
      y: 3 + (reverse ? 1 - ratio : ratio) * 0.6,
    }
  })
}

function digitizedVoltageCurve() {
  return {
    method: "manual_pixel_trace",
    x_quantity: "time",
    x_unit: "s",
    y_quantity: "voltage",
    y_unit: "V",
    x_range: { min: 0, max: 0.0015 },
    y_range: { min: 3, max: 3.6 },
    x_axis: {
      scale: "linear",
      first: { pixel: 10, value: 0 },
      second: { pixel: 190, value: 0.0015 },
    },
    y_axis: {
      scale: "linear",
      first: { pixel: 90, value: 3 },
      second: { pixel: 10, value: 3.6 },
    },
    trace_color: { r: 20, g: 80, b: 180, tolerance: 24 },
    points: Array.from({ length: 16 }, (_, index) => {
      const ratio = index / 15
      return {
        pixel_x: 10 + ratio * 180,
        pixel_y: 90 - ratio * 80,
        x: ratio * 0.0015,
        y: 3 + ratio * 0.6,
      }
    }),
  }
}

function validObservationValue() {
  return {
    version: 1,
    source_pdf_sha256,
    reviewed_hints: [
      {
        hint_id: "time_graph_001",
        disposition: "graph",
        graph_id: "load_transient",
        reason: "The figure has an elapsed-time horizontal axis and plots VOUT.",
      },
      {
        hint_id: "time_graph_002",
        disposition: "not_time_graph",
        reason: "The nearby TIME label belongs to an unrelated timing diagram.",
      },
    ],
    graphs: [
      {
        graph_id: "load_transient",
        page: 7,
        locator: "Figure 8-18, Load Transient Response",
        x_axis: "time",
        time_axis_evidence: "TIME (200 us/div)",
        response_quantity: "voltage",
        public_pin_observable: true,
        fixture_reproducible: true,
        reason: "VOUT is a public electrical pin and is plotted against elapsed time.",
        crop: observer_crop,
        electrical_binding: structuredClone(electrical_binding),
        digitized_curve: digitizedVoltageCurve(),
      },
    ],
  }
}

test("reference observer contract publishes exact graph keys and actionable unknown-field errors", () => {
  const prompt = buildReferenceGraphObserverPrompt()
  expect(prompt).toContain('"page": 25')
  expect(prompt).toContain('"locator": "Figure 10-21. Load Transient"')
  expect(prompt).toContain("Do not invent aliases such as pdf_page, figure")
  expect(prompt).toContain("Every reviewed_hints[] entry requires reason")

  const invalid = validObservationValue()
  const graph = invalid.graphs[0] as Record<string, unknown>
  graph.pdf_page = graph.page
  Reflect.deleteProperty(graph, "page")
  expect(() => parseReferenceGraphObservation(invalid, discovery, model_interface)).toThrow(
    /unsupported fields: pdf_page\. Allowed fields: graph_id, page, locator/,
  )
})

test("source-proof failures identify every agent-claimed eligible graph before characterization", () => {
  const observation = parseReferenceGraphObservation(validObservationValue(), discovery, model_interface)
  expect(
    sourceProofRejectionDiagnostics(observation, {
      version: 1,
      source_pdf_sha256,
      results: [
        {
          status: "ineligible",
          graph_id: "load_transient",
          code: "axis_calibration_unproven",
          reason: "The crop does not prove its printed time scale.",
          diagnostic: {
            recognized_measurements: [],
            missing_proofs: ["time division scale", "figure-local caption"],
          },
        },
      ],
    }),
  ).toEqual([
    "load_transient: The crop does not prove its printed time scale. Missing source proofs: time division scale, figure-local caption",
  ])
})

test("reference observer feedback aggregates electrical errors across every claimed graph", () => {
  const multi_discovery = structuredClone(discovery)
  multi_discovery.hints[1] = {
    ...structuredClone(multi_discovery.hints[0]!),
    hint_id: "time_graph_002",
    page: 8,
    figure: "Figure 8-19",
  }
  const invalid = validObservationValue()
  invalid.reviewed_hints[1] = {
    hint_id: "time_graph_002",
    disposition: "graph",
    graph_id: "second_load_transient",
    reason: "The second figure is also an elapsed-time voltage graph.",
  }
  invalid.graphs[0]!.electrical_binding.stimulus.pulse.delay = 0.002
  invalid.graphs.push({
    ...structuredClone(invalid.graphs[0]!),
    graph_id: "second_load_transient",
    page: 8,
    locator: "Figure 8-19",
    crop: { ...observer_crop, page: 8 },
  })

  let failure: unknown
  try {
    parseReferenceGraphObservation(invalid, multi_discovery, model_interface)
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  const message = failure instanceof Error ? failure.message : ""
  expect(message).toContain("load_transient: Eligible graph load_transient PULSE timing")
  expect(message).toContain("second_load_transient: Eligible graph second_load_transient PULSE timing")
})

async function createPixelProofDatasheet(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "model-reference-pixel-proof-test-"))
  temporary_directories.push(workspace)
  const datasheet_path = join(workspace, "datasheet.pdf")
  await Bun.write(datasheet_path, "%PDF canonical observer pixel-proof fixture")
  return datasheet_path
}

function characterization(input: {
  support: "modeled" | "documented_only"
  crop?: ModelReferenceCropRegion
  locator?: string
  points?: Array<{ x: number; y: number }>
}): ModelCharacterization {
  return {
    version: 1,
    family: "power_converter",
    strategy: "behavioral",
    requirements: [
      {
        requirement_id: "load_transient",
        title: "Load transient response",
        behavior: "Reproduce the output-voltage response to the documented load step.",
        analysis: "transient",
        support:
          input.support === "modeled"
            ? { status: "modeled" }
            : {
                status: "documented_only",
                reason: "The candidate declined to digitize this graph.",
              },
        conditions: { input_voltage: 3.6 },
        expected: { unit: "V", min: 3, max: 3.6 },
        ...(input.crop
          ? {
              reference_curve: {
                x_quantity: "time",
                x_unit: "s",
                y_quantity: "voltage",
                y_unit: "V",
                points: input.points ?? linearVoltagePoints(18),
                crop: input.crop,
                electrical_binding: structuredClone(electrical_binding),
              },
            }
          : {}),
        sources: [
          {
            page: 7,
            locator: input.locator ?? "Figure 8-18, Load Transient Response",
            statement: "The graph plots VOUT during a load transient.",
          },
        ],
      },
    ],
    assumptions: [],
    limitations: [],
  }
}

describe("deterministic time-graph hints", () => {
  test("finds run-93-shaped transient captions and nearby printed time axes", () => {
    const candidates = findLikelyTimeGraphCandidates(`Typical Characteristics
Figure 8-18. Load Transient Response
VOUT (100 mV/div)                 TIME (200 us/div)
\fTypical Characteristics
Figure 8-5. Efficiency vs Output Current
Figure 8-6. Output Voltage vs Input Voltage
\fTypical Characteristics
Figure 8-19. Output Voltage During Mode Change
VOUT (50 mV/div)                  Time(ms)
`)

    expect(candidates.map(({ page, figure }) => ({ page, figure }))).toEqual([
      { page: 1, figure: "Figure 8-18" },
      { page: 3, figure: "Figure 8-19" },
    ])
    expect(candidates[0]?.reason).toContain("Load Transient Response")
    expect(candidates[1]?.reason).toBe("printed Time (unit) axis")
  })

  test("inventories every time plot in the exact run-93 pdftotext layout", async () => {
    // Verbatim `pdftotext -layout` excerpts from pages 21 and 24-26 of the archived
    // TPS63802 PDF (SHA-256 be07deca...d80dca6), including its two-column ordering.
    const run93_text = (
      await readFile(
        join(import.meta.dir, "fixtures/model-run-replays/run93-tps63802-time-graphs.txt"),
        "utf8",
      )
    ).replaceAll("\\f", "\f")
    expect(
      createHash("sha256")
        .update(
          await readFile(join(import.meta.dir, "fixtures/model-run-replays/run93-tps63802-time-graphs.txt")),
        )
        .digest("hex"),
    ).toBe("106f842d1ac8df15fbff3decc63e11a1a466835c1ff45d1f426843bfe31a1a04")
    const candidates = findLikelyTimeGraphCandidates(run93_text)
    const table_candidates = findLikelyTimeGraphCandidates(run93_text.split("\f")[0] ?? "")
    const expected_figures = Array.from({ length: 17 }, (_, index) => `Figure 10-${index + 15}`)

    expect(table_candidates.map(({ figure }) => figure)).toEqual(expected_figures)
    expect(table_candidates.every(({ page }) => page === 1)).toBe(true)
    expect(candidates.map(({ figure }) => figure)).toEqual(expected_figures)
    expect(candidates.map(({ page, figure }) => ({ page, figure }))).toEqual([
      ...Array.from({ length: 5 }, (_, index) => ({ page: 2, figure: `Figure 10-${index + 15}` })),
      ...Array.from({ length: 6 }, (_, index) => ({ page: 3, figure: `Figure 10-${index + 20}` })),
      ...Array.from({ length: 6 }, (_, index) => ({ page: 4, figure: `Figure 10-${index + 26}` })),
    ])
    expect(candidates.find(({ figure }) => figure === "Figure 10-15")?.reason).toContain(
      "Switching Waveforms",
    )
    expect(candidates.find(({ figure }) => figure === "Figure 10-21")?.reason).toContain("Load Transient")
    expect(candidates.find(({ figure }) => figure === "Figure 10-30")?.reason).toContain("Start-up")
    expect(
      candidates.flatMap(({ figure, transient_fixture_evidence }) =>
        transient_fixture_evidence ? [figure] : [],
      ),
    ).toEqual(["Figure 10-21", "Figure 10-22", "Figure 10-24", "Figure 10-25"])
    expect(
      candidates.find(({ figure }) => figure === "Figure 10-21")?.transient_fixture_evidence,
    ).toMatchObject({
      method: "printed_experiment_conditions_v2",
      response: { signal: "VO", quantity: "voltage", nominal_volts: 3.3 },
      stimulus: {
        signal: "IO",
        type: "current_step",
        low: 0.1,
        high: 1,
        rise: 0.000001,
        fall: 0.000001,
      },
      auxiliary_conditions: [
        { kind: "dc_voltage", signal: "VI", value: 2.5 },
        { kind: "logic_state", signal: "MODE", state: "low" },
      ],
    })
    expect(
      candidates
        .find(({ figure }) => figure === "Figure 10-21")
        ?.transient_fixture_evidence?.source_excerpts.find(({ scope }) => scope === "graph_caption")?.text,
    ).toContain("IO from 100 mA")
    expect(
      candidates
        .filter(({ condition_conflicts }) => condition_conflicts.length > 0)
        .map(({ figure }) => figure),
    ).toEqual(["Figure 10-23", "Figure 10-26", "Figure 10-27", "Figure 10-28", "Figure 10-29"])
  })

  testWithArchivedRun93Pdf("inventories the archived run-93 PDF with real pdftotext", async () => {
    const discovery = await discoverTimeGraphHints({
      datasheet_path: archived_run93_pdf,
      process_runner: new BunProcessRunner(),
      signal: new AbortController().signal,
    })

    expect(discovery.page_count).toBe(38)
    expect(discovery.source_pdf_sha256).toBe(
      "be07deca1231c5493957bc64c2dc1cad5543bff330e49ae41caf3286fd80dca6",
    )
    expect(discovery.hints.map(({ figure }) => figure)).toEqual(
      Array.from({ length: 17 }, (_, index) => `Figure 10-${index + 15}`),
    )
    expect(
      discovery.hints.flatMap(({ figure, transient_fixture_evidence }) =>
        transient_fixture_evidence ? [figure] : [],
      ),
    ).toEqual(["Figure 10-21", "Figure 10-22", "Figure 10-24", "Figure 10-25"])
    expect(
      discovery.hints
        .filter(({ condition_conflicts }) => condition_conflicts.length > 0)
        .map(({ figure }) => figure),
    ).toEqual(["Figure 10-23", "Figure 10-26", "Figure 10-27", "Figure 10-28", "Figure 10-29"])
  })

  test("finds the alert response-time figures present in run 94", () => {
    const candidates = findLikelyTimeGraphCandidates(`Typical Characteristics
Figure 8-3. Alert Response Time (Sampled Values)
Figure 8-4. Alert Response Time (Sampled Values)
`)

    expect(candidates.map(({ page, figure }) => ({ page, figure }))).toEqual([
      { page: 1, figure: "Figure 8-3" },
      { page: 1, figure: "Figure 8-4" },
    ])
  })

  test("extracts unsupported internal configuration from the exact run-94 graph text", async () => {
    const run94_text = (
      await readFile(join(import.meta.dir, "fixtures/model-run-replays/run94-ina237-time-graphs.txt"), "utf8")
    ).replaceAll("\\f", "\f")
    expect(
      createHash("sha256")
        .update(
          await readFile(join(import.meta.dir, "fixtures/model-run-replays/run94-ina237-time-graphs.txt")),
        )
        .digest("hex"),
    ).toBe("7f37c6fea1eee36af53605f32fa29dc3701001cd6037dc6725ef4556b80e771a")
    const candidates = findLikelyTimeGraphCandidates(run94_text)

    expect(candidates.map(({ figure }) => figure)).toEqual(["Figure 8-3", "Figure 8-4"])
    for (const candidate of candidates) {
      expect(candidate.unsupported_fixture_conditions).toContain("internal_configuration")
      expect(candidate.operating_condition_evidence).toContain("SLOWALERT bit set to 0")
      expect(candidate.operating_condition_evidence).toContain("averaging set to 1")
    }
  })

  testWithArchivedRun94Pdf("disqualifies configured ALERT timing in the archived run-94 PDF", async () => {
    const discovery = await discoverTimeGraphHints({
      datasheet_path: archived_run94_pdf,
      process_runner: new BunProcessRunner(),
      signal: new AbortController().signal,
    })

    expect(discovery.page_count).toBe(45)
    expect(discovery.hints.map(({ figure }) => figure)).toEqual(["Figure 8-3", "Figure 8-4"])
    expect(
      discovery.hints.every(({ unsupported_fixture_conditions }) =>
        unsupported_fixture_conditions.includes("internal_configuration"),
      ),
    ).toBe(true)
  })

  test("ignores static graph captions without an elapsed-time marker", () => {
    expect(
      findLikelyTimeGraphCandidates(`Typical Characteristics
Figure 8-5. Efficiency vs Output Current
Figure 8-6. Output Voltage vs Input Voltage
Figure 8-7. Switching Frequency vs Output Current
`),
    ).toEqual([])
  })
})

describe("independent reference-graph observation", () => {
  test("accepts only the exact server-derived run-93 load-step binding", async () => {
    const run93_text = (
      await readFile(
        join(import.meta.dir, "fixtures/model-run-replays/run93-tps63802-time-graphs.txt"),
        "utf8",
      )
    ).replaceAll("\\f", "\f")
    const load_hint = findLikelyTimeGraphCandidates(run93_text).find(
      ({ figure }) => figure === "Figure 10-21",
    )!
    const load_discovery: TimeGraphDiscovery = {
      version: 1,
      source_pdf_sha256,
      page_count: 4,
      hints: [{ hint_id: "time_graph_001", ...load_hint }],
    }
    const observed = validObservationValue()
    observed.reviewed_hints = [
      {
        hint_id: "time_graph_001",
        disposition: "graph",
        graph_id: "load_transient",
        reason: "The printed IO step drives the plotted VO response.",
      },
    ]
    observed.graphs[0]!.page = load_hint.page
    observed.graphs[0]!.locator = `${load_hint.figure}. Load Transient`
    observed.graphs[0]!.crop = { ...observed.graphs[0]!.crop, page: load_hint.page }
    observed.graphs[0]!.electrical_binding.stimulus.pulse.rise = 0.000001
    observed.graphs[0]!.electrical_binding.stimulus.pulse.fall = 0.000001
    observed.graphs[0]!.electrical_binding.response.nominal_volts = 3.3
    observed.graphs[0]!.electrical_binding.auxiliary_fixtures = [
      { type: "dc_voltage", positive: "dut.VIN", negative: "gnd", dc_volts: 2.5 },
      { type: "logic_state", endpoint: "dut.MODE", reference: "gnd", state: "low" },
    ]

    expect(
      eligibleObservedGraphs(parseReferenceGraphObservation(observed, load_discovery, model_interface)),
    ).toHaveLength(1)
    observed.graphs[0]!.electrical_binding.stimulus.pulse.high = 0.9
    expect(() => parseReferenceGraphObservation(observed, load_discovery, model_interface)).toThrow(
      /must exactly match the server-extracted printed response nominal, stimulus, and every auxiliary fixture/,
    )
  })

  test("canonicalizes conflicting run-93 summary and graph conditions as fixture-ineligible", async () => {
    const run93_text = (
      await readFile(
        join(import.meta.dir, "fixtures/model-run-replays/run93-tps63802-time-graphs.txt"),
        "utf8",
      )
    ).replaceAll("\\f", "\f")
    const conflict_hint = findLikelyTimeGraphCandidates(run93_text).find(
      ({ figure }) => figure === "Figure 10-23",
    )!
    expect(conflict_hint.condition_conflicts).toEqual([
      {
        code: "condition_conflict",
        key: "dc_voltage:VI",
        summary_value: "dc_voltage:4.2",
        graph_value: "dc_voltage:5",
      },
    ])
    expect(conflict_hint.transient_fixture_evidence).toBeNull()
    const observed = validObservationValue()
    observed.reviewed_hints = [
      {
        hint_id: "time_graph_001",
        disposition: "graph",
        graph_id: "load_transient",
        reason: "The graph is visibly a transient.",
      },
    ]
    observed.graphs[0]!.page = conflict_hint.page
    observed.graphs[0]!.locator = `${conflict_hint.figure}. Load Transient`
    observed.graphs[0]!.crop = { ...observed.graphs[0]!.crop, page: conflict_hint.page }
    const parsed = parseReferenceGraphObservation(
      observed,
      {
        version: 1,
        source_pdf_sha256,
        page_count: 4,
        hints: [{ hint_id: "time_graph_001", ...conflict_hint }],
      },
      model_interface,
    )
    expect(parsed.graphs[0]).toMatchObject({
      fixture_reproducible: false,
      reason: expect.stringContaining("condition"),
    })
    expect(parsed.graphs[0]?.electrical_binding).toBeUndefined()
  })

  test("requires the exact run-93 VIN and MODE fixtures one-to-one and rejects response clamps", () => {
    const run93_binding: ModelReferenceElectricalBinding = {
      response: {
        type: "voltage",
        positive: "dut.VOUT",
        negative: "gnd",
        nominal_volts: 3.3,
      },
      stimulus: {
        type: "current_step",
        positive: "dut.VOUT",
        negative: "gnd",
        pulse: {
          low: 0.1,
          high: 1,
          delay: 0.0001,
          rise: 0.000001,
          fall: 0.000001,
          width: 0.0005,
          period: 0.003,
        },
      },
      auxiliary_fixtures: [
        { type: "dc_voltage", positive: "dut.VIN", negative: "gnd", dc_volts: 2.5 },
        { type: "logic_state", endpoint: "dut.MODE", reference: "gnd", state: "low" },
      ],
    }
    const requirement: ModelCharacterization["requirements"][number] = {
      requirement_id: "figure_10_21",
      title: "Figure 10-21 load transient",
      behavior: "VO response to the printed IO step at fixed VI and MODE",
      analysis: "transient",
      support: { status: "modeled" },
      conditions: { VI: 2.5, VO: 3.3, MODE: "Low" },
      expected: { unit: "V" },
      reference_curve: {
        x_quantity: "time",
        x_unit: "s",
        y_quantity: "voltage",
        y_unit: "V",
        points: [
          { x: 0, y: 3.3 },
          { x: 0.001, y: 3.3 },
        ],
        electrical_binding: run93_binding,
      },
      sources: [{ page: 24, locator: "Figure 10-21", statement: "Printed load transient" }],
    }
    const proposal = () => ({
      version: 1,
      model: { entry_name: "TEST_CONVERTER", pins: ["VIN", "VOUT", "MODE", "GND"] },
      cases: [
        {
          id: "figure-10-21",
          requirement_ids: ["figure_10_21"],
          nets: [],
          fixtures: [
            {
              id: "load_step",
              type: "current_source",
              positive: "dut.VOUT",
              negative: "gnd",
              dc_amps: 0.1,
              pulse: structuredClone(run93_binding.stimulus.pulse),
            },
            {
              id: "vin_bias",
              type: "voltage_source",
              positive: "dut.VIN",
              negative: "gnd",
              dc_volts: 2.5,
            },
            {
              id: "mode_low",
              type: "voltage_source",
              positive: "dut.MODE",
              negative: "gnd",
              dc_volts: 0,
            },
            {
              id: "dut_ground",
              type: "voltage_source",
              positive: "dut.GND",
              negative: "gnd",
              dc_volts: 0,
            },
          ],
          analysis: { type: "transient", step: 0.00001, stop: 0.001 },
          observations: [
            {
              id: "vo_response",
              requirement_id: "figure_10_21",
              type: "voltage",
              positive: "dut.VOUT",
              negative: "gnd",
              unit: "V",
              scale: "linear",
            },
          ],
        },
      ],
    })
    const parse = (value: unknown) =>
      parseAgentValidationPlan(value, {
        model_interface,
        model_source: `.SUBCKT TEST_CONVERTER VIN VOUT MODE GND\nR_OUT VOUT GND 1k\n.ENDS TEST_CONVERTER\n`,
        model_requirements: [requirement],
        model_family: "power_converter",
      })

    expect(parse(proposal()).cases[0]?.fixtures).toHaveLength(4)
    for (const mutate of [
      (fixtures: Array<Record<string, unknown>>) => fixtures.splice(1, 1),
      (fixtures: Array<Record<string, unknown>>) => (fixtures[1]!.dc_volts = 2.4),
      (fixtures: Array<Record<string, unknown>>) => fixtures.push({ ...fixtures[1], id: "vin_duplicate" }),
      (fixtures: Array<Record<string, unknown>>) => (fixtures[2]!.negative = "dut.VIN"),
    ]) {
      const invalid = proposal()
      mutate(invalid.cases[0]!.fixtures)
      expect(() => parse(invalid)).toThrow(/requirement_auxiliary_fixture_mismatch/)
    }

    const response_clamp = proposal()
    response_clamp.cases[0]!.fixtures.push({
      id: "fake_vout",
      type: "voltage_source",
      positive: "dut.VOUT",
      negative: "gnd",
      dc_volts: 3.3,
    })
    expect(() => parse(response_clamp)).toThrow(/bound_response_clamp/)

    const extra_vin_source = proposal()
    ;(extra_vin_source.cases[0]!.fixtures as Array<Record<string, unknown>>).push({
      id: "extra_vin",
      type: "current_source",
      positive: "dut.VIN",
      negative: "gnd",
      dc_amps: 0.001,
    })
    expect(() => parse(extra_vin_source)).toThrow(/unbound_bound_condition_source/)

    const extra_load = proposal()
    ;(extra_load.cases[0]!.fixtures as Array<Record<string, unknown>>).push({
      id: "extra_load",
      type: "current_source",
      positive: "dut.VOUT",
      negative: "gnd",
      dc_amps: 0.01,
    })
    expect(() => parse(extra_load)).toThrow(/unbound_bound_condition_source/)
  })

  test("binds a consistent line-transient load current and high MODE rail tie exactly", () => {
    const printed = deriveTimeGraphPrintedExperiment({
      fixture_evidence_context:
        "IO = 0.5 A, VI from 2.2 V to 4.2 V, tr = 1 us, tf = 1 us, MODE = High. Figure 10-27.",
      summary_fixture_evidence_context:
        "VI = 2.2 V to 4.2 V, VO = 3.3 V, Load = 0.5 A, MODE = High. Figure 10-27.",
    })
    expect(printed.condition_conflicts).toEqual([])
    expect(printed.evidence?.auxiliary_conditions).toEqual([
      { kind: "dc_current", signal: "IO", value: 0.5 },
      { kind: "logic_state", signal: "MODE", state: "high" },
    ])

    const line_binding: ModelReferenceElectricalBinding = {
      response: {
        type: "voltage",
        positive: "dut.VOUT",
        negative: "gnd",
        nominal_volts: 3.3,
      },
      stimulus: {
        type: "voltage_step",
        positive: "dut.VIN",
        negative: "gnd",
        pulse: {
          low: 2.2,
          high: 4.2,
          delay: 0.0001,
          rise: 0.000001,
          fall: 0.000001,
          width: 0.0005,
          period: 0.003,
        },
      },
      auxiliary_fixtures: [
        { type: "dc_current", positive: "dut.VOUT", negative: "gnd", dc_amps: 0.5 },
        { type: "logic_state", endpoint: "dut.MODE", reference: "dut.VIN", state: "high" },
      ],
    }
    expect(parseModelReferenceElectricalBinding(line_binding)).toEqual(line_binding)
    const requirement: ModelCharacterization["requirements"][number] = {
      requirement_id: "consistent_line_transient",
      title: "Consistent line transient",
      behavior: "VO response to VI step with fixed load and high MODE",
      analysis: "transient",
      support: { status: "modeled" },
      conditions: { IO: 0.5, VO: 3.3, MODE: "High" },
      expected: { unit: "V" },
      reference_curve: {
        x_quantity: "time",
        x_unit: "s",
        y_quantity: "voltage",
        y_unit: "V",
        points: [
          { x: 0, y: 3.3 },
          { x: 0.001, y: 3.3 },
        ],
        electrical_binding: line_binding,
      },
      sources: [{ page: 24, locator: "Figure 10-27", statement: "Consistent fixture" }],
    }
    const proposal = () => ({
      version: 1,
      model: { entry_name: "TEST_CONVERTER", pins: ["VIN", "VOUT", "MODE", "GND"] },
      cases: [
        {
          id: "consistent-line-transient",
          requirement_ids: ["consistent_line_transient"],
          nets: [],
          fixtures: [
            {
              id: "line_step",
              type: "voltage_source",
              positive: "dut.VIN",
              negative: "gnd",
              dc_volts: 2.2,
              pulse: structuredClone(line_binding.stimulus.pulse),
            },
            {
              id: "static_load",
              type: "current_source",
              positive: "dut.VOUT",
              negative: "gnd",
              dc_amps: 0.5,
            },
            {
              id: "mode_high",
              type: "voltage_source",
              positive: "dut.MODE",
              negative: "dut.VIN",
              dc_volts: 0,
            },
            {
              id: "dut_ground",
              type: "voltage_source",
              positive: "dut.GND",
              negative: "gnd",
              dc_volts: 0,
            },
          ],
          analysis: { type: "transient", step: 0.00001, stop: 0.001 },
          observations: [
            {
              id: "vo_response",
              requirement_id: "consistent_line_transient",
              type: "voltage",
              positive: "dut.VOUT",
              negative: "gnd",
              unit: "V",
              scale: "linear",
            },
          ],
        },
      ],
    })
    const parse = (value: unknown) =>
      parseAgentValidationPlan(value, {
        model_interface,
        model_source: `.SUBCKT TEST_CONVERTER VIN VOUT MODE GND\nR_OUT VOUT GND 1k\n.ENDS TEST_CONVERTER\n`,
        model_requirements: [requirement],
        model_family: "power_converter",
      })
    expect(parse(proposal()).cases[0]?.fixtures).toHaveLength(4)
    for (const mutate of [
      (fixture: Record<string, unknown>) => (fixture.dc_amps = 0.4),
      (fixture: Record<string, unknown>) => {
        fixture.positive = "gnd"
        fixture.negative = "dut.VOUT"
      },
    ]) {
      const invalid = proposal()
      mutate(invalid.cases[0]!.fixtures[1]!)
      expect(() => parse(invalid)).toThrow(/requirement_auxiliary_fixture_mismatch/)
    }
    const omitted_load = proposal()
    omitted_load.cases[0]!.fixtures.splice(1, 1)
    expect(() => parse(omitted_load)).toThrow(/requirement_auxiliary_fixture_mismatch/)
    const duplicated_load = proposal()
    duplicated_load.cases[0]!.fixtures.push({
      ...duplicated_load.cases[0]!.fixtures[1]!,
      id: "duplicate_static_load",
    })
    expect(() => parse(duplicated_load)).toThrow(/requirement_auxiliary_fixture_mismatch/)
  })

  test("rejects an invented pulse for a run-93 switching waveform with no printed step", async () => {
    const run93_text = (
      await readFile(
        join(import.meta.dir, "fixtures/model-run-replays/run93-tps63802-time-graphs.txt"),
        "utf8",
      )
    ).replaceAll("\\f", "\f")
    const switching_hint = findLikelyTimeGraphCandidates(run93_text).find(
      ({ figure }) => figure === "Figure 10-15",
    )!
    expect(switching_hint.transient_fixture_evidence).toBeNull()
    const switching_discovery: TimeGraphDiscovery = {
      version: 1,
      source_pdf_sha256,
      page_count: 4,
      hints: [{ hint_id: "time_graph_001", ...switching_hint }],
    }
    const malicious = validObservationValue()
    malicious.reviewed_hints = [
      {
        hint_id: "time_graph_001",
        disposition: "graph",
        graph_id: "switching_waveform",
        reason: "Invent a convenient public pulse.",
      },
    ]
    malicious.graphs[0]!.graph_id = "switching_waveform"
    malicious.graphs[0]!.page = switching_hint.page
    malicious.graphs[0]!.locator = `${switching_hint.figure}. Switching Waveforms`
    malicious.graphs[0]!.crop = { ...malicious.graphs[0]!.crop, page: switching_hint.page }

    const canonical = parseReferenceGraphObservation(malicious, switching_discovery, model_interface)
    expect(eligibleObservedGraphs(canonical)).toEqual([])
    expect(canonical.graphs[0]).toMatchObject({
      fixture_reproducible: false,
      reason: expect.stringContaining("electrical fixture cannot be invented"),
    })
    expect(canonical.graphs[0]?.electrical_binding).toBeUndefined()
  })

  test("an observer cannot dismiss a server-detected transient caption", () => {
    const caption_discovery: TimeGraphDiscovery = {
      version: 1,
      source_pdf_sha256,
      page_count: 1,
      hints: [
        {
          hint_id: "time_graph_001",
          page: 1,
          figure: "Figure 10-21",
          reason: "Figure 10-21. Load Transient, PFM/PWM Boost",
          operating_condition_evidence: "Figure 10-21. Load Transient, PFM/PWM Boost",
          fixture_evidence_context: "Figure 10-21. Load Transient, PFM/PWM Boost",
          summary_fixture_evidence_context: null,
          condition_conflicts: [],
          unsupported_fixture_conditions: [],
          transient_fixture_evidence: null,
        },
      ],
    }

    expect(() =>
      parseReferenceGraphObservation(
        {
          version: 1,
          source_pdf_sha256,
          reviewed_hints: [
            {
              hint_id: "time_graph_001",
              disposition: "not_time_graph",
              reason: "Ignore this plot.",
            },
          ],
          graphs: [],
        },
        caption_discovery,
        model_interface,
      ),
    ).toThrow(/cannot dismiss the server-detected time-graph caption Figure 10-21/)
  })

  test("canonicalizes a stubborn run-94 observer and reaches the typed characterization stop", async () => {
    const run94_text = (
      await readFile(join(import.meta.dir, "fixtures/model-run-replays/run94-ina237-time-graphs.txt"), "utf8")
    ).replaceAll("\\f", "\f")
    const candidates = findLikelyTimeGraphCandidates(run94_text)
    const run94_discovery: TimeGraphDiscovery = {
      version: 1,
      source_pdf_sha256,
      page_count: 2,
      hints: candidates.map((candidate, index) => ({
        hint_id: `time_graph_${String(index + 1).padStart(3, "0")}`,
        ...candidate,
      })),
    }
    const malicious = validObservationValue()
    malicious.reviewed_hints = run94_discovery.hints.map((hint, index) => ({
      hint_id: hint.hint_id,
      disposition: "graph",
      graph_id: index === 0 ? "alert_response_fast" : "alert_response_slow",
      reason: "The ALERT pin is public, so a plain VBUS pulse should be enough.",
    }))
    malicious.graphs = run94_discovery.hints.map((hint, index) => ({
      ...structuredClone(validObservationValue().graphs[0]!),
      graph_id: index === 0 ? "alert_response_fast" : "alert_response_slow",
      page: hint.page,
      locator: `${hint.figure}. Alert Response Time`,
      crop: { ...observer_crop, page: hint.page, y_px: observer_crop.y_px + index * 120 },
      reason: "ALERT and VBUS are public pins, so the response is reproducible.",
    }))

    const observation = parseReferenceGraphObservation(malicious, run94_discovery, model_interface)
    expect(eligibleObservedGraphs(observation)).toEqual([])
    expect(observation.graphs).toHaveLength(2)
    for (const graph of observation.graphs) {
      expect(graph.fixture_reproducible).toBe(false)
      expect(graph.electrical_binding).toBeUndefined()
      expect(graph.reason).toContain(
        "Server-owned datasheet conditions require unsupported internal_configuration",
      )
    }
    expect(
      parseReferenceGraphObservation(
        JSON.parse(JSON.stringify(observation)),
        run94_discovery,
        model_interface,
      ),
    ).toEqual(observation)

    try {
      assertObserverFoundEligibleTimeDomainGraph(observation)
      throw new Error("Expected stubborn run-94 output to stop before model characterization")
    } catch (error) {
      expect(error).toMatchObject({
        diagnostic: {
          code: "no_eligible_time_domain_graph",
          stage_id: "characterize",
          message: expect.stringContaining("PDF page 2 Figure 8-3. Alert Response Time"),
          retryable: false,
        },
      })
    }
  })

  test("characterize stage stops a stubborn run-94 observer after one canonicalized attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "run94-characterize-boundary-"))
    temporary_directories.push(root)
    const job_dir = join(root, "job")
    const model_dir = join(job_dir, "spice")
    const attempt_dir = join(model_dir, "attempts", "invocation_run94")
    await Promise.all([mkdir(job_dir, { recursive: true }), mkdir(attempt_dir, { recursive: true })])
    const test_pdf = "%PDF-1.4\n% run94 deterministic fixture\n"
    const application_fixture = compileApplicationFixtureContract({
      plan: {
        version: 4,
        availability: "not_present",
        title: "No documented application",
        description: "The complete datasheet search found no typical application.",
        source_references: [{ page: 1 }],
        searched_sections: ["application information"],
        components: [],
        connections: [],
      },
      model_interface,
      source_plan_sha256: "1".repeat(64),
      source_pdf_sha256: createHash("sha256").update(test_pdf).digest("hex"),
    })
    await Promise.all([
      Bun.write(join(model_dir, "AGENTS.md"), "# Test instructions\n"),
      Bun.write(join(model_dir, "datasheet.pdf"), test_pdf),
      Bun.write(join(model_dir, "model-interface.json"), `${JSON.stringify(model_interface, null, 2)}\n`),
      Bun.write(
        join(model_dir, "application-fixture-contract.json"),
        `${JSON.stringify(application_fixture, null, 2)}\n`,
      ),
    ])
    const run94_text = (
      await readFile(join(import.meta.dir, "fixtures/model-run-replays/run94-ina237-time-graphs.txt"), "utf8")
    ).replaceAll("\\f", "\f")
    const process_runner: ProcessRunner = {
      async run(request) {
        if (request.command[0] !== "pdftotext") {
          throw new Error(`Run-94 boundary unexpectedly invoked ${request.command.join(" ")}`)
        }
        const output_path = request.command.at(-1)
        if (!output_path) throw new Error("Run-94 pdftotext fixture omitted its output path")
        await Bun.write(output_path, run94_text)
        return { exit_code: 0, duration_ms: 1, output_tail: "" }
      },
    }
    let agent_calls = 0
    const stubborn_agent: AgentClient = {
      async run(input) {
        agent_calls += 1
        expect(input.phase_label).toBe("Independent datasheet graph inventory")
        const discovered = JSON.parse(
          await readFile(join(input.workspace, "time-graph-hints.json"), "utf8"),
        ) as TimeGraphDiscovery
        const graph_seed = validObservationValue().graphs[0]!
        await Bun.write(
          join(input.workspace, "model-reference-observation.json"),
          `${JSON.stringify(
            {
              version: 1,
              source_pdf_sha256: discovered.source_pdf_sha256,
              reviewed_hints: discovered.hints.map((hint, index) => ({
                hint_id: hint.hint_id,
                disposition: "graph",
                graph_id: `configured_alert_${index + 1}`,
                reason: "The ALERT pin is public, so this should be reproducible.",
              })),
              graphs: discovered.hints.map((hint, index) => ({
                ...structuredClone(graph_seed),
                graph_id: `configured_alert_${index + 1}`,
                page: hint.page,
                locator: `${hint.figure}. Alert Response Time`,
                crop: { ...observer_crop, page: hint.page, y_px: observer_crop.y_px + index * 120 },
                reason: "A plain public VBUS pulse should reproduce the ALERT response.",
              })),
            },
            null,
            2,
          )}\n`,
        )
        return { attempts: 1, duration_ms: 1, output_tail: "" }
      },
    }
    const model_run_store = new ModelRunStore()
    model_run_store.createModelRun({
      model_run_id: "model_run94_boundary",
      job_id: "job_run94_boundary",
      model_dir,
      effort_multiplier: 1,
    })

    let caught: unknown
    try {
      await characterizeStage.execute({
        run_id: "model_run94_boundary",
        pipeline_id: "datasheet_model",
        stage_id: "characterize",
        debug_dir: join(model_dir, "debug"),
        context: {
          model_run_id: "model_run94_boundary",
          job_id: "job_run94_boundary",
          job_dir,
          model_dir,
          use_openai: false,
          max_repair_attempts: 1,
          invocation_id: "invocation_run94",
        },
        services: {
          job_store: new JobStore(),
          model_run_store,
          agent_client: stubborn_agent,
          process_runner,
          strategy_registry: new ModelStrategyRegistry(),
          tsci_bin: "unused-tsci",
          ngspice_bin: "unused-ngspice",
          ngspice_executor: async () => {
            throw new Error("Run-94 characterization stop must not invoke ngspice")
          },
        },
        dependency_outputs: {
          prepare_workspace: {
            part_number: model_interface.part_number,
            entry_name: model_interface.entry_name,
            pin_count: model_interface.pins.length,
            interface_path: join(model_dir, "model-interface.json"),
            attempt_dir,
            application_fixture_path: join(model_dir, "application-fixture-contract.json"),
            application_fixture_sha256: application_fixture.contract_sha256,
          },
        },
        signal: new AbortController().signal,
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toMatchObject({
      diagnostic: {
        code: "no_eligible_time_domain_graph",
        stage_id: "characterize",
        retryable: false,
      },
    })
    expect(agent_calls).toBe(1)
    const retained = JSON.parse(
      await readFile(join(attempt_dir, "model-reference-observation.json"), "utf8"),
    ) as ReferenceGraphObservation
    expect(retained.graphs.every((graph) => graph.fixture_reproducible === false)).toBe(true)
    expect(retained.graphs.every((graph) => graph.electrical_binding === undefined)).toBe(true)
  })

  test("stops run 94 at characterization with a typed no-eligible-graph error", async () => {
    const run94_text = (
      await readFile(join(import.meta.dir, "fixtures/model-run-replays/run94-ina237-time-graphs.txt"), "utf8")
    ).replaceAll("\\f", "\f")
    const run94_discovery: TimeGraphDiscovery = {
      version: 1,
      source_pdf_sha256,
      page_count: 2,
      hints: findLikelyTimeGraphCandidates(run94_text).map((candidate, index) => ({
        hint_id: `time_graph_${String(index + 1).padStart(3, "0")}`,
        ...candidate,
      })),
    }
    const value = {
      version: 1,
      source_pdf_sha256,
      reviewed_hints: run94_discovery.hints.map((hint, index) => ({
        hint_id: hint.hint_id,
        disposition: "graph",
        graph_id: `alert_response_${index + 1}`,
        reason: "This is an elapsed-time plot, but its configured conversion state is unsupported.",
      })),
      graphs: run94_discovery.hints.map((hint, index) => ({
        graph_id: `alert_response_${index + 1}`,
        page: hint.page,
        locator: `${hint.figure}. Alert Response Time`,
        x_axis: "time",
        time_axis_evidence: "Time (50 us/div)",
        response_quantity: "voltage",
        public_pin_observable: true,
        fixture_reproducible: false,
        reason:
          "The ALERT response requires conversion time, averaging, SLOWALERT, and bus-only conversion configuration.",
        crop: { ...observer_crop, page: hint.page, y_px: observer_crop.y_px + index * 120 },
      })),
    }
    const observation = parseReferenceGraphObservation(value, run94_discovery, model_interface)

    try {
      assertObserverFoundEligibleTimeDomainGraph(observation)
      throw new Error("Expected run 94 to stop before model characterization")
    } catch (error) {
      expect(error).toMatchObject({
        diagnostic: {
          code: "no_eligible_time_domain_graph",
          stage_id: "characterize",
          retryable: false,
        },
      })
    }
  })

  test("accepts calibrated points on a realistic colored graph trace", async () => {
    const observation = parseReferenceGraphObservation(validObservationValue(), discovery, model_interface)
    const runner = new ReferenceGraphCropRunner()

    await verifyReferenceGraphObservationPixels({
      observation,
      datasheet_path: await createPixelProofDatasheet(),
      process_runner: runner,
      signal: new AbortController().signal,
    })

    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]?.command.slice(0, 17)).toEqual([
      "pdftoppm",
      "-f",
      "7",
      "-l",
      "7",
      "-r",
      "200",
      "-x",
      "100",
      "-y",
      "200",
      "-W",
      "200",
      "-H",
      "100",
      "-png",
      "-singlefile",
    ])
  })

  test("rejects calibrated points that miss the rendered response trace", async () => {
    const observation = parseReferenceGraphObservation(validObservationValue(), discovery, model_interface)

    await expect(
      verifyReferenceGraphObservationPixels({
        observation,
        datasheet_path: await createPixelProofDatasheet(),
        process_runner: new ReferenceGraphCropRunner("flat"),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/does not follow the rendered datasheet waveform/)
  })

  test("rejects disconnected matching pixels that do not form the claimed waveform", async () => {
    const observation = parseReferenceGraphObservation(validObservationValue(), discovery, model_interface)

    await expect(
      verifyReferenceGraphObservationPixels({
        observation,
        datasheet_path: await createPixelProofDatasheet(),
        process_runner: new ReferenceGraphCropRunner("points_only"),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/disconnected point samples instead of a continuous rendered waveform/)
  })

  test("rejects connected monochrome axes and grid lines impersonating the response trace", async () => {
    const value = validObservationValue()
    value.graphs[0]!.digitized_curve.trace_color = { r: 0, g: 0, b: 0, tolerance: 8 }
    const observation = parseReferenceGraphObservation(value, discovery, model_interface)

    await expect(
      verifyReferenceGraphObservationPixels({
        observation,
        datasheet_path: await createPixelProofDatasheet(),
        process_runner: new ReferenceGraphCropRunner("grid_only"),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/does not follow|disconnected point samples/)
  })

  test("rejects a declared trace color that is the crop background", async () => {
    const value = validObservationValue()
    value.graphs[0]!.digitized_curve.trace_color = { r: 255, g: 255, b: 255, tolerance: 24 }
    const observation = parseReferenceGraphObservation(value, discovery, model_interface)

    await expect(
      verifyReferenceGraphObservationPixels({
        observation,
        datasheet_path: await createPixelProofDatasheet(),
        process_runner: new ReferenceGraphCropRunner(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/cannot distinguish the declared waveform color from absence or background/)
  })

  test("requires every deterministic hint to receive exactly one valid disposition", () => {
    expect(
      parseReferenceGraphObservation(validObservationValue(), discovery, model_interface).reviewed_hints,
    ).toHaveLength(2)

    const missing = validObservationValue()
    missing.reviewed_hints = missing.reviewed_hints.slice(0, 1)
    expect(() => parseReferenceGraphObservation(missing, discovery, model_interface)).toThrow(
      /review every deterministic hint exactly once/,
    )

    const duplicate = validObservationValue()
    duplicate.reviewed_hints = [duplicate.reviewed_hints[0]!, duplicate.reviewed_hints[0]!]
    expect(() => parseReferenceGraphObservation(duplicate, discovery, model_interface)).toThrow(
      /review every deterministic hint exactly once/,
    )

    const missing_graph = validObservationValue()
    missing_graph.reviewed_hints[0] = {
      hint_id: "time_graph_001",
      disposition: "graph",
      reason: "Classified as a graph but failed to identify it.",
    }
    expect(() => parseReferenceGraphObservation(missing_graph, discovery, model_interface)).toThrow(
      /graph_id must name an observed graph/,
    )

    const contradictory = validObservationValue()
    contradictory.reviewed_hints[1] = {
      hint_id: "time_graph_002",
      disposition: "not_time_graph",
      graph_id: "load_transient",
      reason: "Contradictory disposition.",
    }
    expect(() => parseReferenceGraphObservation(contradictory, discovery, model_interface)).toThrow(
      /graph_id is incompatible with not_time_graph/,
    )

    const static_axis = validObservationValue()
    static_axis.graphs[0]!.x_axis = "input_voltage"
    expect(() => parseReferenceGraphObservation(static_axis, discovery, model_interface)).toThrow(
      /x_axis must be time/,
    )

    const uncalibrated_point = validObservationValue()
    uncalibrated_point.graphs[0]!.digitized_curve.points[6]!.y += 0.2
    expect(() => parseReferenceGraphObservation(uncalibrated_point, discovery, model_interface)).toThrow(
      /points\[6\]\.y is inconsistent with its pixel-axis calibration/,
    )

    const sparse_trace = validObservationValue()
    sparse_trace.graphs[0]!.digitized_curve.points = sparse_trace.graphs[0]!.digitized_curve.points.slice(
      0,
      8,
    )
    expect(() => parseReferenceGraphObservation(sparse_trace, discovery, model_interface)).toThrow(
      /points must contain 15 through 48/,
    )

    const missing_binding = validObservationValue()
    delete (missing_binding.graphs[0] as Partial<(typeof missing_binding.graphs)[number]>).electrical_binding
    expect(() => parseReferenceGraphObservation(missing_binding, discovery, model_interface)).toThrow(
      /electrical_binding is required for every eligible voltage graph/,
    )

    const unknown_response_pin = validObservationValue()
    const mutable_binding = unknown_response_pin.graphs[0]!.electrical_binding as unknown as {
      response: { positive: string }
    }
    mutable_binding.response.positive = "dut.NOT_A_PIN"
    expect(() => parseReferenceGraphObservation(unknown_response_pin, discovery, model_interface)).toThrow(
      /response\.positive does not name a public SPICE node/,
    )

    const flat_stimulus = validObservationValue()
    flat_stimulus.graphs[0]!.electrical_binding.stimulus.pulse.high = 0.1
    expect(() => parseReferenceGraphObservation(flat_stimulus, discovery, model_interface)).toThrow(
      /pulse\.low and .*pulse\.high must differ/,
    )
  })

  test("withholds independent numeric provenance from the characterization agent", () => {
    const observation = parseReferenceGraphObservation(validObservationValue(), discovery, model_interface)
    const projected = projectReferenceGraphObservationForCharacterizer(observation)
    const serialized = JSON.stringify(projected)

    expect(projected.graphs[0]).toMatchObject({
      graph_id: "load_transient",
      crop: observer_crop,
      electrical_binding,
      numeric_curve_withheld: true,
    })
    expect(serialized).not.toContain("digitized_curve")
    expect(serialized).not.toContain("trace_color")
    expect(serialized).not.toContain("x_range")
    expect(serialized).not.toContain("pixel_x")
  })

  test("forces an all-documented characterization to retry when an eligible graph was found", () => {
    const observation = parseReferenceGraphObservation(validObservationValue(), discovery, model_interface)

    expect(() =>
      verifyCharacterizationGraphEvidence({
        characterization: characterization({ support: "documented_only" }),
        observation,
      }),
    ).toThrow(/Create a modeled requirement for every eligible graph/)
  })

  test("canonicalizes an untrusted candidate rectangle and accepts only the exact observer crop", () => {
    const observation = parseReferenceGraphObservation(validObservationValue(), discovery, model_interface)
    const slightly_larger_crop: ModelReferenceCropRegion = {
      page: 7,
      render_dpi: 200,
      x_px: 95,
      y_px: 195,
      width_px: 210,
      height_px: 110,
    }

    const untrusted = characterization({ support: "modeled", crop: slightly_larger_crop })
    expect(() => verifyCharacterizationGraphEvidence({ characterization: untrusted, observation })).toThrow(
      /must use the exact canonical observer crop/,
    )

    const canonicalized = canonicalizeCharacterizationReferenceCrops({
      characterization: untrusted,
      observation,
    })
    expect(canonicalized.requirements[0]!.reference_curve!.crop).toEqual(observer_crop)
    const matches = verifyCharacterizationGraphEvidence({
      characterization: canonicalized,
      observation,
    }).matches
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      requirement_id: "load_transient",
      graph_id: "load_transient",
      crop_proof: {
        algorithm: "exact_observer_crop_v1",
        canonical_crop: observer_crop,
        canonical_crop_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      axis_calibration_receipt_sha256: "legacy-unretained-axis-proof",
      curve_fidelity: {
        algorithm: "linear_interpolation_axis_normalized_v1",
        compared_sample_count: expect.any(Number),
        x_coverage_ratio: 1,
        normalized_rmse: expect.closeTo(0, 10),
        max_normalized_error: expect.closeTo(0, 10),
        observer_curve_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        candidate_curve_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })

    const shifted_crop: ModelReferenceCropRegion = {
      ...observer_crop,
      x_px: 220,
    }
    expect(() =>
      verifyCharacterizationGraphEvidence({
        characterization: characterization({ support: "modeled", crop: shifted_crop }),
        observation,
      }),
    ).toThrow(/must use the exact canonical observer crop/)
  })

  test("rejects arbitrary numeric points even when the genuine graph crop overlaps exactly", () => {
    const observation = parseReferenceGraphObservation(validObservationValue(), discovery, model_interface)

    expect(() =>
      verifyCharacterizationGraphEvidence({
        characterization: characterization({
          support: "modeled",
          crop: observer_crop,
          points: linearVoltagePoints(18, true),
        }),
        observation,
      }),
    ).toThrow(/fails independent numeric curve fidelity/)
  })

  test("rejects a candidate that reassigns the graph to another response or stimulus endpoint", () => {
    const observation = parseReferenceGraphObservation(validObservationValue(), discovery, model_interface)
    const candidate = characterization({ support: "modeled", crop: observer_crop })
    candidate.requirements[0]!.reference_curve!.electrical_binding = {
      ...electrical_binding,
      response: { type: "voltage", positive: "dut.VIN", negative: "gnd" },
    }

    expect(() => verifyCharacterizationGraphEvidence({ characterization: candidate, observation })).toThrow(
      /must match exactly one independently observed public-pin elapsed-time voltage graph; found 0/,
    )
  })

  test("requires modeled coverage for every independently eligible graph", () => {
    const observation = parseReferenceGraphObservation(validObservationValue(), discovery, model_interface)
    observation.graphs.push({
      ...structuredClone(observation.graphs[0]!),
      graph_id: "second_load_transient",
      page: 8,
      locator: "Figure 8-19, Second Load Transient Response",
      crop: { ...observer_crop, page: 8 },
    })

    expect(() =>
      verifyCharacterizationGraphEvidence({
        characterization: characterization({ support: "modeled", crop: observer_crop }),
        observation,
      }),
    ).toThrow(/Every independently eligible graph must become a modeled requirement/)
  })

  test("cannot satisfy one eligible graph with duplicate modeled requirements", () => {
    const observation = parseReferenceGraphObservation(validObservationValue(), discovery, model_interface)
    const candidate = characterization({ support: "modeled", crop: observer_crop })
    candidate.requirements.push({
      ...structuredClone(candidate.requirements[0]!),
      requirement_id: "duplicate_load_transient",
    })

    expect(() => verifyCharacterizationGraphEvidence({ characterization: candidate, observation })).toThrow(
      /one-to-one with a different independently eligible graph/,
    )
  })

  test("does not treat current plots or inaccessible internal-node plots as eligible", () => {
    const observation: ReferenceGraphObservation = {
      version: 1,
      source_pdf_sha256,
      reviewed_hints: [],
      graphs: [
        {
          graph_id: "inductor_current",
          page: 7,
          locator: "Figure 8-20, Inductor Current",
          x_axis: "time",
          time_axis_evidence: "TIME (20 us/div)",
          response_quantity: "current",
          public_pin_observable: true,
          fixture_reproducible: true,
          reason: "The response is current rather than voltage.",
          crop: observer_crop,
        },
        {
          graph_id: "internal_voltage",
          page: 7,
          locator: "Figure 8-21, Internal Control Voltage",
          x_axis: "time",
          time_axis_evidence: "Time (ms)",
          response_quantity: "voltage",
          public_pin_observable: false,
          fixture_reproducible: true,
          reason: "The plotted internal node is not exposed on a public pin.",
          crop: observer_crop,
        },
        {
          graph_id: "configured_alert_voltage",
          page: 8,
          locator: "Figure 8-22, Configured Alert Response",
          x_axis: "time",
          time_axis_evidence: "Time (us)",
          response_quantity: "voltage",
          public_pin_observable: true,
          fixture_reproducible: false,
          reason: "The plot requires an I2C register transaction that the fixture language cannot express.",
          crop: { ...observer_crop, page: 8 },
        },
      ],
    }

    expect(eligibleObservedGraphs(observation)).toEqual([])
    expect(
      verifyCharacterizationGraphEvidence({
        characterization: characterization({ support: "documented_only" }),
        observation,
      }),
    ).toEqual({ version: 2, source_pdf_sha256, matches: [] })
  })
})
