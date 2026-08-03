import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import type { AnyCircuitElement } from "circuit-json"
import type { AgentClient } from "@/server/infrastructure/agent"
import { atomicWriteJsonSync } from "@/server/infrastructure/persistence/atomic-write"
import {
  BunProcessRunner,
  type ProcessRunner,
  type ProcessRunRequest,
  type ProcessRunResult,
} from "@/server/infrastructure/process"
import { restorePersistedJobs } from "@/server/job-restorer"
import { ensureJobTscircuitRuntimeConfig } from "@/server/job-scaffold"
import { JobStore } from "@/server/job-store"
import { ModelRunStore } from "@/server/model-run-store"
import { parseModelInterface, readGeneratedModel } from "@/server/modeling"
import { resolveBenchmarkReferenceImage } from "@/server/modeling/reference-image"
import type { ValidationPlan } from "@/server/spice-validation"
import { runModel } from "@/server/model-workflow"
import {
  createModelTrainingCheckReceipt,
  MODEL_TRAINING_CHECK_RECEIPT_FILE,
} from "@/server/model-workflow/model-training-check"
import { publishCommittedEvidenceFixture } from "./fixtures/committed-evidence"

const ngspice_path = Bun.which("ngspice")
const tsci_path = Bun.which("tsci")
const testWithProductionSimulation = ngspice_path && tsci_path ? test : test.skip
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

function minimalPng(width: number, height: number): Uint8Array {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const scanlines = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row_offset = y * (width * 4 + 1)
    for (let x = 0; x < width; x += 1) {
      const pixel_offset = row_offset + 1 + x * 4
      const plot_left = 8
      const plot_right = width - 8
      const plot_top = 8
      const plot_bottom = height - 8
      const is_axis = x === plot_left || y === plot_bottom
      const time_ratio = (x - plot_left) / (plot_right - plot_left)
      const trace_y = Math.round(
        plot_bottom - Math.min(1, Math.max(0, time_ratio) * 3) * (plot_bottom - plot_top),
      )
      const is_trace = x >= plot_left && x <= plot_right && y === trace_y
      const value = is_axis || is_trace ? 0 : 255
      scanlines[pixel_offset] = value
      scanlines[pixel_offset + 1] = value
      scanlines[pixel_offset + 2] = value
      scanlines[pixel_offset + 3] = 255
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND"),
  ])
}

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

const model_source = `.SUBCKT TEST_GAIN IN OUT GND
E_GAIN OUT GND IN GND 2
.ENDS TEST_GAIN
`

const characterization = {
  version: 1,
  family: "other",
  strategy: "behavioral",
  requirements: [
    {
      requirement_id: "transient_gain",
      title: "Transient voltage gain",
      behavior: "The output follows twice the printed input ramp relative to ground.",
      analysis: "transient",
      support: { status: "modeled" },
      conditions: { load_resistance_ohms: 10_000 },
      expected: { unit: "V", min: 0, max: 2 },
      reference_curve: {
        x_quantity: "time",
        x_unit: "s",
        y_quantity: "voltage",
        y_unit: "V",
        tolerance: 0.02,
        points: [
          { x: 0, y: 0 },
          { x: 0.00025, y: 0.5 },
          { x: 0.0005, y: 1 },
          { x: 0.00075, y: 1.5 },
          { x: 0.001, y: 2 },
          { x: 0.0015, y: 2 },
          { x: 0.002, y: 2 },
          { x: 0.003, y: 2 },
        ],
        crop: {
          page: 1,
          render_dpi: 200,
          x_px: 10,
          y_px: 20,
          width_px: 96,
          height_px: 64,
        },
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
              rise: 0.001,
              fall: 0.001,
              width: 0.003,
              period: 0.006,
            },
          },
        },
      },
      sources: [
        {
          page: 1,
          locator: "Figure 1, transient voltage gain",
          statement: "The output follows twice the input ramp over elapsed time.",
        },
      ],
    },
  ],
  assumptions: ["The test fixture uses an ideal ground reference."],
  limitations: ["This fixture exercises only the documented transient gain."],
}

const validation_plan = {
  version: 1,
  model: { entry_name: "TEST_GAIN", pins: ["IN", "OUT", "GND"] },
  cases: [
    {
      id: "transient_gain",
      title: "Transient gain response",
      requirement_ids: ["transient_gain"],
      nets: [],
      fixtures: [
        {
          type: "voltage_source",
          id: "vin",
          positive: "dut.IN",
          negative: "gnd",
          dc_volts: 0,
          pulse: {
            low: 0,
            high: 1,
            delay: 0,
            rise: 0.001,
            fall: 0.001,
            width: 0.003,
            period: 0.006,
          },
        },
        {
          type: "resistor",
          id: "load",
          positive: "dut.OUT",
          negative: "gnd",
          resistance_ohms: 10_000,
        },
        {
          type: "voltage_source",
          id: "ground_ref",
          positive: "dut.GND",
          negative: "gnd",
          dc_volts: 0,
        },
      ],
      analysis: { type: "transient", step: 0.00025, stop: 0.003 },
      observations: [
        {
          type: "voltage",
          id: "output_voltage",
          requirement_id: "transient_gain",
          positive: "dut.OUT",
          negative: "gnd",
          unit: "V",
          scale: "linear",
          // Production runs 91/92 emitted agent-authored evidence even though
          // evidence is server-owned. The workflow must replace this shape,
          // including its extra fields, instead of spending retries asking the
          // agent to reproduce a private canonical object exactly.
          evidence: {
            page: 999,
            image: "evidence/source-page-999.png",
            locator: "agent-authored production locator",
            statement: "agent-authored production statement",
          },
          reference: { type: "target", target: 999, tolerance: 999 },
        },
      ],
    },
  ],
}

function deterministicAgent(calls: string[]): AgentClient {
  return {
    async run(input) {
      calls.push(input.phase_label)
      if (input.phase_label === "Independent datasheet graph inventory") {
        const discovery = JSON.parse(
          await Bun.file(join(input.workspace, "time-graph-hints.json")).text(),
        ) as { source_pdf_sha256: string }
        await Bun.write(
          join(input.workspace, "model-reference-observation.json"),
          `${JSON.stringify(
            {
              version: 1,
              source_pdf_sha256: discovery.source_pdf_sha256,
              reviewed_hints: [
                {
                  hint_id: "time_graph_001",
                  disposition: "graph",
                  graph_id: "transient_gain",
                  reason: "The printed transient voltage graph has an elapsed-time horizontal axis.",
                },
              ],
              graphs: [
                {
                  graph_id: "transient_gain",
                  page: 1,
                  locator: "Figure 1, transient voltage gain",
                  x_axis: "time",
                  time_axis_evidence: "Time (ms)",
                  response_quantity: "voltage",
                  public_pin_observable: true,
                  fixture_reproducible: true,
                  reason: "The printed graph shows output voltage against elapsed time.",
                  crop: {
                    page: 1,
                    render_dpi: 200,
                    x_px: 10,
                    y_px: 20,
                    width_px: 96,
                    height_px: 64,
                  },
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
                        rise: 0.001,
                        fall: 0.001,
                        width: 0.003,
                        period: 0.006,
                      },
                    },
                  },
                  digitized_curve: {
                    method: "manual_pixel_trace",
                    x_quantity: "time",
                    x_unit: "s",
                    y_quantity: "voltage",
                    y_unit: "V",
                    x_range: { min: 0, max: 0.003 },
                    y_range: { min: 0, max: 2 },
                    x_axis: {
                      scale: "linear",
                      first: { pixel: 8, value: 0 },
                      second: { pixel: 88, value: 0.003 },
                    },
                    y_axis: {
                      scale: "linear",
                      first: { pixel: 56, value: 0 },
                      second: { pixel: 8, value: 2 },
                    },
                    trace_color: { r: 0, g: 0, b: 0, tolerance: 24 },
                    points: Array.from({ length: 13 }, (_, index) => {
                      const x = (index / 12) * 0.003
                      const y = Math.min(2, x * 2_000)
                      return {
                        pixel_x: 8 + (x / 0.003) * 80,
                        pixel_y: 56 - (y / 2) * 48,
                      }
                    }),
                  },
                },
              ],
            },
            null,
            2,
          )}\n`,
        )
        await input.on_output("stdout", `fixture completed ${input.phase_label}\n`)
        return { attempts: 1, duration_ms: 1, output_tail: "" }
      }
      if (input.phase_label === "SPICE model generation") {
        const generated_validation_plan = JSON.parse(
          await Bun.file(join(input.workspace, "model-training-plan.json")).text(),
        ) as typeof validation_plan
        await Promise.all([
          Bun.write(join(input.workspace, "model.lib"), model_source),
          Bun.write(
            join(input.workspace, "model-card.md"),
            "# TEST-GAIN\n\nA deterministic two-times transient gain model.\n",
          ),
        ])
        const model_interface = parseModelInterface(
          JSON.parse(await Bun.file(join(input.workspace, "model-interface.json")).text()),
        )
        const generated = await readGeneratedModel({
          model_dir: input.workspace,
          model_interface,
        })
        const candidate_receipt = {
          version: 1 as const,
          status: "passed" as const,
          checks: ["model_contract", "model_card", "ngspice_smoke"] as const,
          revision: generated.manifest.revision,
          entry_name: generated.manifest.entry_name,
          pin_count: generated.manifest.pins.length,
          model_card_sha256: createHash("sha256").update(generated.card).digest("hex"),
        }
        const training_receipt = await createModelTrainingCheckReceipt({
          workspace: input.workspace,
          candidate: candidate_receipt,
          training_validation: {
            version: 1,
            status: "passed",
            cases: generated_validation_plan.cases.map((validation_case) => {
              const series = validation_case.observations.map((observation) => ({
                observation_id: observation.id,
                status: "passed" as const,
                metrics: {
                  sample_count: 2,
                  normalized_max_error: 0,
                  normalized_rmse: 0,
                },
                samples: [
                  { x: 0, reference_y: 0, simulated_y: 0, error: 0 },
                  { x: 0.001, reference_y: 2, simulated_y: 2, error: 0 },
                ],
                error_codes: [],
              }))
              return {
                case_id: validation_case.id,
                status: "passed" as const,
                server_series: series,
                viewer_series: series,
                error_codes: [],
              }
            }),
            error_codes: [],
          },
        })
        await Promise.all([
          Bun.write(join(input.workspace, ".candidate-check.json"), `${JSON.stringify(candidate_receipt)}\n`),
          Bun.write(
            join(input.workspace, MODEL_TRAINING_CHECK_RECEIPT_FILE),
            `${JSON.stringify(training_receipt)}\n`,
          ),
        ])
      } else {
        throw new Error(`Unexpected agent phase: ${input.phase_label}`)
      }
      await input.on_output("stdout", `fixture completed ${input.phase_label}\n`)
      return { attempts: 1, duration_ms: 1, output_tail: "" }
    },
  }
}

/** Deterministic PDF/component boundaries with the installed tsci runtime for validation previews. */
class ModelWorkflowBoundaryRunner implements ProcessRunner {
  readonly calls: ProcessRunRequest[] = []
  private readonly production_runner = new BunProcessRunner()

  constructor(private readonly production_tsci_bin: string) {}

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request)
    if (request.command[0] === "pdftotext") {
      const output_path = request.command.at(-1)
      if (!output_path) throw new Error("Fixture pdftotext command omitted its output path")
      await Bun.write(
        output_path,
        request.command.includes("-bbox-layout")
          ? `<?xml version="1.0"?><doc><page width="100" height="100"><flow><block><line><word xMin="5" yMin="34" xMax="15" yMax="38">Figure</word><word xMin="16" yMin="34" xMax="20" yMax="38">1.</word></line></block></flow></page></doc>`
          : "VOUT = 2 V. IN from 0 V to 1 V, tr = 1 ms, tf = 1 ms.\nTIME (0.5 ms / div)\nFigure 1. Transient Voltage Gain\f",
      )
      return { exit_code: 0, duration_ms: 1, output_tail: "" }
    }
    if (request.command[0] === "tesseract" && request.command[1] === "--version") {
      return { exit_code: 0, duration_ms: 1, output_tail: "tesseract 5.5.1\n" }
    }
    if (request.command[0] === "tesseract") {
      const output_base = request.command[2]
      if (!output_base) throw new Error("Fixture tesseract command omitted its output base")
      const rows = [
        [1, 1, 1, 1, 20, 166, 8, 6, 95, "0s"],
        [2, 1, 1, 1, 252, 166, 24, 6, 95, "3ms"],
        [3, 1, 1, 1, 2, 165, 16, 6, 95, "0V"],
        [4, 1, 1, 1, 2, 21, 16, 6, 95, "2V"],
      ]
      const tsv = [
        "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
        ...rows.map(([block, paragraph, line, word, left, top, width, height, confidence, text]) =>
          [5, 1, block, paragraph, line, word, left, top, width, height, confidence, text].join("\t"),
        ),
      ].join("\n")
      await Bun.write(`${output_base}.tsv`, `${tsv}\n`)
      return { exit_code: 0, duration_ms: 1, output_tail: "" }
    }
    if (request.command[0] === "pdftoppm") {
      const output_prefix = request.command.at(-1)
      if (!output_prefix) throw new Error("Fixture pdftoppm command omitted its output prefix")
      const width_index = request.command.indexOf("-W")
      const height_index = request.command.indexOf("-H")
      const width = width_index === -1 ? 240 : Number(request.command[width_index + 1])
      const height = height_index === -1 ? 160 : Number(request.command[height_index + 1])
      await Bun.write(`${output_prefix}.png`, minimalPng(width, height))
      return { exit_code: 0, duration_ms: 1, output_tail: "" }
    }
    if (
      request.command[1] === "build" &&
      request.command[2]?.endsWith(".circuit.tsx") &&
      request.command[2] !== "component-with-model.circuit.tsx"
    ) {
      if (request.command[0] === this.production_tsci_bin) {
        return this.production_runner.run(request)
      }
      throw new Error(`Validation build did not use the installed tsci runtime: ${request.command[0]}`)
    }
    if (request.command[1] !== "build" || request.command[2] !== "component-with-model.circuit.tsx") {
      throw new Error(`Unexpected process command: ${request.command.join(" ")}`)
    }
    const [wrapper_source, component_circuit, model_interface] = await Promise.all([
      readFile(join(request.cwd, "component-with-model.circuit.tsx"), "utf8"),
      readFile(join(request.cwd, "component.circuit.json"), "utf8").then(JSON.parse),
      readFile(join(request.cwd, "model-interface.json"), "utf8").then(JSON.parse),
    ])
    const encoded_model_source = /^const modelSource = (.+)$/m.exec(wrapper_source)?.[1]
    if (!encoded_model_source) throw new Error("Generated wrapper did not contain modelSource")
    const source = JSON.parse(encoded_model_source) as string
    const output_directory = join(request.cwd, "dist", "component-with-model")
    await mkdir(output_directory, { recursive: true })
    await writeFile(
      join(output_directory, "circuit.json"),
      `${JSON.stringify(
        [
          ...component_circuit,
          {
            type: "simulation_spice_subcircuit",
            simulation_spice_subcircuit_id: "simulation_spice_subcircuit_test_gain",
            source_component_id: "source_component_test_gain",
            spice_pin_to_source_port_map: Object.fromEntries(
              model_interface.pins.map(
                ({ spice_node, source_port_id }: { spice_node: string; source_port_id: string }) => [
                  spice_node,
                  source_port_id,
                ],
              ),
            ),
            subcircuit_source: source,
          },
        ],
        null,
        2,
      )}\n`,
      "utf8",
    )
    return { exit_code: 0, duration_ms: 1, output_tail: "" }
  }
}

testWithProductionSimulation(
  "MODEL_PIPELINE keeps committed publication authoritative when later checkpoints fail",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "datasheet-model-pipeline-e2e-"))
    temporary_directories.push(root)
    const job_dir = join(root, "job_model_e2e")
    const model_dir = join(job_dir, "spice")
    await mkdir(job_dir, { recursive: true })

    const evidence_source = { page: 1, method: "pdf_text", confidence: "high" }
    const land_pattern_source = {
      page: 2,
      figure: "Recommended land pattern",
      method: "pdf_visual",
      confidence: "high",
      image: "visual-reference/land-pattern.png",
      render_dpi: 200,
    }
    const component_evidence = {
      version: 1,
      status: "resolved",
      part_number: { value: "TEST-GAIN", sources: [evidence_source] },
      package: {
        name: { value: "SOT-23", sources: [evidence_source] },
        pin_count: { value: 3, sources: [evidence_source] },
      },
      pinout: {
        pins: [
          { number: "1", labels: ["IN"], role: "input", sources: [evidence_source] },
          { number: "2", labels: ["OUT"], role: "output", sources: [evidence_source] },
          { number: "3", labels: ["GND"], role: "ground", sources: [evidence_source] },
        ],
      },
      footprint: {
        view: "pcb_top",
        units: "mm",
        drawing_orientation: { value: "pcb_top", sources: [land_pattern_source] },
        pads: [
          {
            pin: "1",
            kind: "smt",
            x: -1,
            y: -1,
            width: 0.6,
            height: 1,
            sources: [land_pattern_source],
          },
          {
            pin: "2",
            kind: "smt",
            x: 1,
            y: -1,
            width: 0.6,
            height: 1,
            sources: [land_pattern_source],
          },
          {
            pin: "3",
            kind: "smt",
            x: 0,
            y: 1,
            width: 0.6,
            height: 1,
            sources: [land_pattern_source],
          },
        ],
      },
      unresolved_ambiguities: [],
    }
    const component_source = `export default function TestGain(props: Record<string, unknown>) {
  return <chip name="U1" {...props} />
}
`
    const component_circuit = [
      {
        type: "source_component",
        source_component_id: "source_component_test_gain",
        name: "U1",
      },
      ...[
        ["1", "IN"],
        ["2", "OUT"],
        ["3", "GND"],
      ].map(([pin, label]) => ({
        type: "source_port",
        source_port_id: `source_port_${pin}`,
        source_component_id: "source_component_test_gain",
        pin_number: pin,
        name: label,
        port_hints: [`pin${pin}`, label],
      })),
    ] as AnyCircuitElement[]
    const application_plan = {
      version: 4,
      availability: "not_present",
      title: "No documented application",
      description: "The fixture datasheet does not contain an application circuit.",
      source_references: [evidence_source],
      searched_sections: ["application information", "reference design"],
      components: [],
      connections: [],
    }
    await Promise.all([
      Bun.write(join(job_dir, "component.circuit.tsx"), component_source),
      Bun.write(join(job_dir, "index.circuit.tsx"), component_source),
      Bun.write(join(job_dir, "component.circuit.json"), `${JSON.stringify(component_circuit, null, 2)}\n`),
      ensureJobTscircuitRuntimeConfig(job_dir),
    ])
    await publishCommittedEvidenceFixture({
      job_dir,
      datasheet: "%PDF-1.4\n% deterministic test fixture\n",
      component_evidence,
      application_plan,
    })

    let rejected_post_commit_job_checkpoints = 0
    const job_store = new JobStore({
      checkpoint_writer(path, value) {
        if (existsSync(join(job_dir, "published-model.json"))) {
          rejected_post_commit_job_checkpoints += 1
          throw new Error("fixture post-publication job checkpoint failure")
        }
        atomicWriteJsonSync(path, value)
      },
    })
    let rejected_post_commit_checkpoints = 0
    const model_run_store = new ModelRunStore({
      checkpoint_writer(path, value) {
        if (existsSync(join(job_dir, "published-model.json"))) {
          rejected_post_commit_checkpoints += 1
          throw new Error("fixture post-publication checkpoint failure")
        }
        atomicWriteJsonSync(path, value)
      },
    })
    job_store.createJob({ job_id: "job_model_e2e", job_dir, file_name: "test-gain.pdf" })
    job_store.updateJob("job_model_e2e", {
      display_status: "complete",
      is_complete: true,
      component_ready: true,
      component_code: component_source,
      circuit_json: component_circuit,
    })
    model_run_store.createModelRun({
      model_run_id: "model_e2e",
      job_id: "job_model_e2e",
      model_dir,
      effort_multiplier: 1,
    })
    const agent_calls: string[] = []
    const process_runner = new ModelWorkflowBoundaryRunner(tsci_path!)

    await runModel(
      { model_run_id: "model_e2e" },
      {
        job_store,
        model_run_store,
        agent_bin: "unused-agent",
        tsci_bin: tsci_path!,
        ngspice_bin: ngspice_path!,
        agent_client: deterministicAgent(agent_calls),
        process_runner,
      },
    )

    const run = model_run_store.getModelRun("model_e2e")
    expect(run?.error_message).toBeUndefined()
    expect(rejected_post_commit_job_checkpoints).toBeGreaterThan(0)
    expect(rejected_post_commit_checkpoints).toBeGreaterThan(0)
    expect(run).toMatchObject({
      status: "complete",
      is_complete: true,
      has_errors: false,
      validation: { all_passed: true, all_critical_passed: true, passing_count: 1 },
      circuit_preview: { build_status: "ready", analog_simulation_status: "available" },
      pipeline: { pipeline_id: "datasheet_model", status: "completed" },
    })
    expect(
      run?.circuit_preview?.circuit_json?.some(({ type }) => type === "simulation_transient_voltage_graph"),
    ).toBe(true)
    expect(run?.circuit_preview?.code).toContain("<analogsimulation")
    expect(run?.reference_preview).toMatchObject({
      source_file: "evidence/figures/transient_gain.png",
      reference_kind: "curve",
      result_origin: "tscircuit_viewer",
      matches_reference: true,
      x_axis_label: "time",
      x_axis_unit: "s",
    })
    expect(Object.values(run!.pipeline!.stage_results).map(({ status }) => status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
    ])
    expect(agent_calls).toEqual(["Independent datasheet graph inventory", "SPICE model generation"])
    expect(
      process_runner.calls.filter(
        ({ command, command_label }) =>
          command[0] === "tesseract" && command_label === "Read reference-axis OCR engine version",
      ),
    ).toHaveLength(2)
    expect(
      process_runner.calls.filter(
        ({ command, command_label }) =>
          command[0] === "tesseract" && command_label.startsWith("OCR canonical axis crop"),
      ),
    ).toHaveLength(2)
    expect(
      process_runner.calls.filter(
        ({ command, command_label }) =>
          command[0] === "pdftotext" && command_label.startsWith("Extract canonical figure geometry"),
      ),
    ).toHaveLength(2)
    expect(
      process_runner.calls.filter(
        ({ command, command_label }) =>
          command[0] === "pdftoppm" && command_label.startsWith("Re-render canonical reference graph"),
      ),
    ).toHaveLength(1)

    const candidates = await readdir(join(model_dir, "candidates"))
    expect(candidates).toHaveLength(1)
    const candidate_dir = join(model_dir, "candidates", candidates[0]!)
    const immutable_result = JSON.parse(
      await readFile(join(candidate_dir, "validation", "validation-results.json"), "utf8"),
    )
    expect(immutable_result).toMatchObject({
      version: 1,
      passed: true,
      cases: [{ case_id: "transient_gain", status: "passed" }],
      stimulus_causality: {
        version: 1,
        method: "bound_pulse_flatten_v2",
        status: "passed",
        checked_case_count: 1,
        checked_observation_count: 1,
      },
    })
    expect(await readFile(join(candidate_dir, "model.lib"), "utf8")).toBe(model_source)
    expect(await Bun.file(join(candidate_dir, "model-manifest.json")).exists()).toBe(true)
    expect(await Bun.file(join(candidate_dir, "validation", "transient_gain", "result.raw")).exists()).toBe(
      true,
    )

    const canonical_plan = JSON.parse(
      await readFile(join(model_dir, "validation-plan.json"), "utf8"),
    ) as ValidationPlan
    expect(canonical_plan.cases[0]?.observations[0]).toMatchObject({
      evidence: {
        page: 1,
        image: "evidence/figures/transient_gain.png",
        metadata: { figure: "Figure 1, transient voltage gain" },
      },
      reference: {
        type: "curve",
        tolerance: 0.1,
      },
    })
    const canonical_reference = canonical_plan.cases[0]?.observations[0]?.reference
    expect(canonical_reference?.type === "curve" ? canonical_reference.points : []).toHaveLength(13)
    expect(canonical_reference).toMatchObject({
      points: expect.arrayContaining([
        { x: 0, y: 0 },
        { x: 0.003, y: 2 },
      ]),
    })

    const published_index = await readFile(join(job_dir, "index.circuit.tsx"), "utf8")
    expect(published_index).toContain("<spicemodel")
    expect(published_index).toContain("spicePinMapping")
    const publication = JSON.parse(await readFile(join(job_dir, "published-model.json"), "utf8")) as {
      accepted_model_directory: string
      revision: string
    }
    const accepted_dir = join(job_dir, publication.accepted_model_directory)
    for (const source_file of [
      "typical-application-plan.json",
      "datasheet.pdf",
      "component-evidence.json",
      "application-fixture-contract.json",
    ]) {
      expect(await readFile(join(accepted_dir, source_file))).toEqual(
        await readFile(join(model_dir, source_file)),
      )
    }
    const retained_observation = JSON.parse(
      await readFile(join(accepted_dir, "model-reference-observation.json"), "utf8"),
    )
    expect(retained_observation.graphs[0].digitized_curve.points).toHaveLength(13)
    const retained_verification = JSON.parse(
      await readFile(join(accepted_dir, "model-reference-verification.json"), "utf8"),
    )
    expect(retained_verification.matches[0]).toMatchObject({
      requirement_id: "transient_gain",
      graph_id: "transient_gain",
      curve_fidelity: {
        observer_curve_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        candidate_curve_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      pixel_trace: {
        source_image_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        verified_point_count: 13,
        total_point_count: 13,
        search_radius_px: 4,
      },
    })
    expect(await readFile(join(job_dir, "component.circuit.tsx"), "utf8")).toBe(component_source)
    expect(await readFile(join(job_dir, "model.lib"), "utf8")).toBe(model_source)
    expect(job_store.getJob("job_model_e2e")?.component_code).toBe(published_index)
    expect(
      job_store
        .getJob("job_model_e2e")
        ?.circuit_json?.filter(({ type }) => type === "simulation_spice_subcircuit"),
    ).toHaveLength(1)
    expect(await Bun.file(join(model_dir, "component-with-model.circuit.json")).exists()).toBe(true)
    const accepted_artifact_identity = {
      preview_generation: publication.accepted_model_directory.split("/").at(-1)!,
      model_revision: publication.revision,
    }
    await expect(
      resolveBenchmarkReferenceImage({
        job_id: "job_model_e2e",
        model_dir,
        benchmark_id: "transient_gain",
      }),
    ).rejects.toMatchObject({ error_code: "preview_artifact_identity_required", status: 400 })
    await expect(
      resolveBenchmarkReferenceImage({
        job_id: "job_model_e2e",
        model_dir,
        benchmark_id: "transient_gain",
        requested_artifact_identity: {
          preview_generation: "stale-accepted-preview-01",
          model_revision: publication.revision,
        },
      }),
    ).rejects.toMatchObject({ error_code: "preview_artifact_identity_mismatch", status: 409 })
    const served_reference = await resolveBenchmarkReferenceImage({
      job_id: "job_model_e2e",
      model_dir,
      benchmark_id: "transient_gain",
      requested_artifact_identity: accepted_artifact_identity,
    })
    expect(served_reference).toBeDefined()
    if (!served_reference) throw new Error("Published datasheet reference was not resolved")
    const served_reference_size =
      "bytes" in served_reference
        ? (served_reference.bytes?.byteLength ?? 0)
        : (await Bun.file(served_reference.file_path).arrayBuffer()).byteLength
    expect(served_reference_size).toBeGreaterThan(0)

    const restored_jobs = new JobStore()
    const restored_models = new ModelRunStore()
    expect(
      await restorePersistedJobs({
        jobs_root: root,
        job_store: restored_jobs,
        model_run_store: restored_models,
      }),
    ).toEqual({ jobs_restored: 1, model_runs_restored: 1 })
    expect(restored_models.getModelRunForJob("job_model_e2e")?.status).toBe("complete")
    expect(
      restored_jobs
        .getJob("job_model_e2e")
        ?.circuit_json?.filter(({ type }) => type === "simulation_spice_subcircuit"),
    ).toHaveLength(1)
  },
  30_000,
)
