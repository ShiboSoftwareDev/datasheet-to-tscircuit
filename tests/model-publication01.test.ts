import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { deflateSync } from "node:zlib"
import type { AnyCircuitElement } from "circuit-json"
import type { AgentClient } from "@/server/infrastructure/agent"
import type { ProcessRunner, ProcessRunRequest, ProcessRunResult } from "@/server/infrastructure/process"
import { getJobFile } from "@/server/job-api/get-job-file"
import type { JobApiContext } from "@/server/job-api/job-api-context"
import { restoreJobDirectory } from "@/server/job-restorer/restore-job-directory"
import { restoreModelDirectory } from "@/server/job-restorer/restore-model-directory"
import { restorePersistedJobs } from "@/server/job-restorer/restore-persisted-jobs"
import { JobStore } from "@/server/job-store"
import { getModelRunFile } from "@/server/model-run-api/get-model-run-file"
import type { ModelRunApiContext } from "@/server/model-run-api/model-run-api-context"
import { ModelRunStore } from "@/server/model-run-store"
import {
  applyReferenceGraphSourceEligibility,
  buildReferenceGraphSourceProof,
} from "@/server/model-workflow/reference-graph-axis-proof"
import {
  parseReferenceGraphObservation,
  verifyCharacterizationGraphEvidence,
  verifyReferenceGraphTracePixels,
} from "@/server/model-workflow/reference-graph-observation"
import {
  commitPreparedModelPublication,
  discardPreparedModelPublication,
  prepareModelPublication,
} from "@/server/model-workflow/stage-helpers"
import { publishModelStage } from "@/server/model-workflow/stages/publish-model"
import {
  deriveTimeGraphTransientFixtureEvidence,
  parseTimeGraphDiscovery,
} from "@/server/model-workflow/time-graph-hints"
import { writeViewerValidationArtifacts } from "@/server/model-workflow/viewer-validation-artifacts"
import {
  commitModelPublication,
  createModelManifest,
  type GeneratedModel,
  type ModelContract,
  ModelStrategyRegistry,
  readModelPublication,
  readVerifiedPublicationArtifact,
  writeIntegratedComponent,
  writePublicationBundleManifest,
} from "@/server/modeling"
import {
  hashValidationInputs,
  parseValidationPlan,
  type ValidationPlan,
  type ValidationRunResult,
} from "@/server/spice-validation"
import { RETAINED_ACCEPTED_WARNING_PREFIX } from "@/shared/model-warnings"

const temporary_directories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

const pulse = {
  low: 0,
  high: 0.001,
  delay: 0,
  rise: 0.0007,
  fall: 0.0001,
  width: 0.001,
  period: 0.002,
}

const reference_points = Array.from({ length: 8 }, (_, index) => {
  const ratio = index / 7
  return { x: ratio * 0.0007, y: ratio }
})

const electrical_binding = {
  response: {
    type: "voltage" as const,
    positive: "dut.OUT" as const,
    negative: "gnd" as const,
    nominal_volts: 1,
  },
  stimulus: {
    type: "current_step" as const,
    positive: "dut.OUT" as const,
    negative: "gnd" as const,
    pulse,
  },
}

const contract: ModelContract = {
  version: 1,
  interface: {
    version: 1,
    part_number: "PUBLICATION-TEST",
    entry_name: "PUBLICATION_TEST",
    pins: [
      {
        physical_pin: "1",
        component_pin: "pin1",
        source_port_id: "source_port_1",
        spice_node: "OUT",
        labels: ["OUT"],
        role: "output",
      },
    ],
  },
  characterization: {
    version: 1,
    family: "other",
    strategy: "behavioral",
    requirements: [
      {
        requirement_id: "output_voltage",
        title: "Output voltage",
        behavior: "The output follows the printed voltage waveform",
        analysis: "transient",
        support: { status: "modeled" },
        conditions: {},
        expected: { unit: "V", min: 0, max: 1 },
        reference_curve: {
          x_quantity: "time",
          x_unit: "s",
          y_quantity: "voltage",
          y_unit: "V",
          tolerance: 0.05,
          points: reference_points,
          crop: { page: 1, render_dpi: 200, x_px: 0, y_px: 0, width_px: 96, height_px: 64 },
          image: "evidence/figures/output_voltage.png",
          electrical_binding,
        },
        sources: [
          {
            page: 1,
            locator: "Figure 1",
            statement: "Output voltage versus elapsed time.",
          },
        ],
      },
    ],
    assumptions: [],
    limitations: [],
  },
}

const plan: ValidationPlan = {
  version: 1,
  model: { entry_name: "PUBLICATION_TEST", pins: ["OUT"] },
  cases: [
    {
      id: "output_voltage",
      requirement_ids: ["output_voltage"],
      nets: [],
      fixtures: [
        {
          type: "current_source",
          id: "stimulus",
          positive: "dut.OUT",
          negative: "gnd",
          dc_amps: pulse.low,
          pulse,
        },
        {
          type: "resistor",
          id: "load",
          positive: "dut.OUT",
          negative: "gnd",
          resistance_ohms: 1_000,
        },
      ],
      analysis: { type: "transient", step: 0.0001, stop: 0.0007 },
      observations: [
        {
          type: "voltage",
          id: "output",
          requirement_id: "output_voltage",
          positive: "dut.OUT",
          negative: "gnd",
          unit: "V",
          scale: "linear",
          reference: { type: "curve", tolerance: 0.05, points: reference_points },
          evidence: {
            page: 1,
            image: "evidence/figures/output_voltage.png",
            metadata: {
              figure: "Figure 1",
              x_quantity: "time",
              x_unit: "s",
              y_quantity: "voltage",
              y_unit: "V",
            },
          },
        },
      ],
    },
  ],
}

function generatedModel(volts: number): GeneratedModel {
  const source = `.SUBCKT PUBLICATION_TEST OUT\nV_OUTPUT OUT 0 ${volts}\n.ENDS PUBLICATION_TEST\n`
  return {
    source,
    card: `# Publication test\n\nOutput: ${volts} V.\n`,
    manifest: createModelManifest({
      model_interface: contract.interface,
      model_source: source,
      simulator: "ngspice",
    }),
  }
}

function passingResult(generated: GeneratedModel): ValidationRunResult {
  return {
    version: 1,
    passed: true,
    hashes: hashValidationInputs({ plan, model_source: generated.source, manifest: generated.manifest }),
    cases: [
      {
        case_id: "output_voltage",
        status: "passed",
        analysis: "transient",
        series: [
          {
            observation_id: "output",
            type: "voltage",
            unit: "V",
            scale: "linear",
            points: reference_points.map((point) => ({ ...point })),
            passed: true,
            metrics: {
              sample_count: reference_points.length,
              normalized_rmse: 0,
              normalized_max_error: 0,
              max_absolute_error: 0,
            },
            errors: [],
          },
        ],
        errors: [],
        elapsed_ms: 1,
        netlist_sha256: "1".repeat(64),
        raw_sha256: "2".repeat(64),
      },
    ],
    errors: [],
    stimulus_causality: {
      version: 1,
      method: "bound_pulse_flatten_v2",
      status: "passed",
      hashes: hashValidationInputs({ plan, model_source: generated.source, manifest: generated.manifest }),
      checked_case_count: 1,
      checked_observation_count: 1,
    },
  }
}

function componentCircuit(model_source: string, source_port_id = "source_port_1"): AnyCircuitElement[] {
  return [
    { type: "source_component", source_component_id: "source_component_1", name: "U1" },
    {
      type: "source_port",
      source_port_id: "source_port_1",
      source_component_id: "source_component_1",
      pin_number: "1",
      name: "OUT",
      port_hints: ["pin1", "OUT"],
    },
    {
      type: "simulation_spice_subcircuit",
      simulation_spice_subcircuit_id: "simulation_model",
      source_component_id: "source_component_1",
      spice_pin_to_source_port_map: { OUT: source_port_id },
      subcircuit_source: model_source,
    },
  ] as unknown as AnyCircuitElement[]
}

function validationCircuit(generated: GeneratedModel): AnyCircuitElement[] {
  return [
    {
      type: "source_component",
      source_component_id: "validation_dut",
      name: "DUT",
      manufacturer_part_number: generated.manifest.part_number,
    },
    {
      type: "source_port",
      source_port_id: "validation_dut_out",
      source_component_id: "validation_dut",
      name: "OUT",
      port_hints: ["OUT", "pin1"],
    },
    {
      type: "simulation_spice_subcircuit",
      simulation_spice_subcircuit_id: "validation_dut_model",
      source_component_id: "validation_dut",
      spice_pin_to_source_port_map: { OUT: "validation_dut_out" },
      subcircuit_source: generated.source,
    },
    {
      type: "source_component",
      source_component_id: "validation_stimulus",
      name: "stimulus",
      ftype: "simple_chip",
    },
    {
      type: "source_port",
      source_port_id: "validation_stimulus_pos",
      source_component_id: "validation_stimulus",
      name: "POS",
      port_hints: ["POS", "pin1"],
    },
    {
      type: "source_port",
      source_port_id: "validation_stimulus_neg",
      source_component_id: "validation_stimulus",
      name: "NEG",
      port_hints: ["NEG", "pin2"],
    },
    {
      type: "source_net",
      source_net_id: "validation_ground",
      name: "GND",
      member_source_group_ids: [],
      is_ground: true,
    },
    {
      type: "source_trace",
      source_trace_id: "validation_stimulus_positive_trace",
      connected_source_port_ids: ["validation_stimulus_pos", "validation_dut_out"],
      connected_source_net_ids: [],
    },
    {
      type: "source_trace",
      source_trace_id: "validation_stimulus_negative_trace",
      connected_source_port_ids: ["validation_stimulus_neg"],
      connected_source_net_ids: ["validation_ground"],
    },
    {
      type: "simulation_spice_subcircuit",
      simulation_spice_subcircuit_id: "validation_stimulus_model",
      source_component_id: "validation_stimulus",
      spice_pin_to_source_port_map: {
        POS: "validation_stimulus_pos",
        NEG: "validation_stimulus_neg",
      },
      subcircuit_source:
        ".SUBCKT VALIDATION_STIMULUS POS NEG\n" +
        "IDRIVE POS NEG DC 0 PULSE(0 0.001 0 0.0007 0.0001 0.001 0.002)\n" +
        ".ENDS VALIDATION_STIMULUS\n",
    },
    {
      type: "source_component",
      source_component_id: "validation_load",
      name: "load",
      ftype: "simple_resistor",
      resistance: 1_000,
    },
    {
      type: "source_port",
      source_port_id: "validation_load_pos",
      source_component_id: "validation_load",
      name: "pin1",
      port_hints: ["pin1"],
    },
    {
      type: "source_port",
      source_port_id: "validation_load_neg",
      source_component_id: "validation_load",
      name: "pin2",
      port_hints: ["pin2"],
    },
    {
      type: "source_trace",
      source_trace_id: "validation_load_positive_trace",
      connected_source_port_ids: ["validation_load_pos", "validation_dut_out"],
      connected_source_net_ids: [],
    },
    {
      type: "source_trace",
      source_trace_id: "validation_load_negative_trace",
      connected_source_port_ids: ["validation_load_neg"],
      connected_source_net_ids: ["validation_ground"],
    },
    {
      type: "simulation_experiment",
      simulation_experiment_id: "validation_experiment",
      name: "validation",
      experiment_type: "spice_transient_analysis",
      time_per_step: 0.1,
      end_time_ms: 0.7,
    },
    {
      type: "simulation_voltage_probe",
      simulation_voltage_probe_id: "validation_output_probe",
      name: "probe_output",
      signal_input_source_port_id: "validation_dut_out",
    },
    {
      type: "simulation_transient_voltage_graph",
      simulation_transient_voltage_graph_id: "validation_output_graph",
      simulation_experiment_id: "validation_experiment",
      source_probe_id: "validation_output_probe",
      name: "probe_output",
      timestamps_ms: reference_points.map(({ x }) => x * 1_000),
      voltage_levels: reference_points.map(({ y }) => y),
      time_per_step: 0.1,
      start_time_ms: 0,
      end_time_ms: 0.7,
    },
  ] as unknown as AnyCircuitElement[]
}

const crc32_table = Array.from({ length: 256 }, (_, index) => {
  let crc = index
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

function referenceGraphPng(width = 96, height = 64): Uint8Array {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row_bytes = width * 3
  const scanlines = Buffer.alloc((row_bytes + 1) * height, 255)
  for (let y = 0; y < height; y += 1) scanlines[y * (row_bytes + 1)] = 0
  const setPixel = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const offset = y * (row_bytes + 1) + 1 + x * 3
    scanlines[offset] = 20
    scanlines[offset + 1] = 80
    scanlines[offset + 2] = 180
  }
  let x = 4
  let y = 58
  const target_x = 91
  const target_y = 5
  const dx = Math.abs(target_x - x)
  const sx = x < target_x ? 1 : -1
  const dy = -Math.abs(target_y - y)
  const sy = y < target_y ? 1 : -1
  let error = dx + dy
  while (true) {
    setPixel(x, y - 1)
    setPixel(x, y)
    setPixel(x, y + 1)
    if (x === target_x && y === target_y) break
    const doubled = error * 2
    if (doubled >= dy) {
      error += dy
      x += sx
    }
    if (doubled <= dx) {
      error += dx
      y += sy
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND"),
  ])
}

class PublicationReferenceRunner implements ProcessRunner {
  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    if (request.command[0] === "tesseract" && request.command[1] === "--version") {
      return { exit_code: 0, duration_ms: 1, output_tail: "tesseract 5.0.0-test\n" }
    }
    if (request.command[0] === "tesseract") {
      const output_base = request.command[2]
      if (!output_base) throw new Error("Publication reference fixture omitted its OCR output base")
      const tsv = [
        "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
        "5\t1\t1\t1\t1\t1\t7\t180\t10\t10\t96\t0s",
        "5\t1\t1\t1\t1\t2\t263\t180\t20\t10\t96\t700us",
        "5\t1\t2\t1\t1\t1\t0\t169\t10\t10\t96\t0V",
        "5\t1\t2\t1\t1\t2\t0\t10\t10\t10\t96\t1V",
      ].join("\n")
      await Bun.write(`${output_base}.tsv`, `${tsv}\n`)
      return { exit_code: 0, duration_ms: 1, output_tail: "" }
    }
    if (request.command[0] === "pdftotext") {
      const output_path = request.command.at(-1)
      if (!output_path) throw new Error("Publication reference fixture omitted its bbox output path")
      await Bun.write(
        output_path,
        '<doc><page><word xMin="1" yMin="24" xMax="12" yMax="28">Figure</word>' +
          '<word xMin="13" yMin="24" xMax="16" yMax="28">1</word></page></doc>\n',
      )
      return { exit_code: 0, duration_ms: 1, output_tail: "" }
    }
    if (request.command[0] !== "pdftoppm") {
      throw new Error(`Publication reference fixture received unsupported command ${request.command[0]}`)
    }
    const output_prefix = request.command.at(-1)
    const width_index = request.command.indexOf("-W")
    const height_index = request.command.indexOf("-H")
    if (!output_prefix || width_index < 0 || height_index < 0) {
      throw new Error("Publication reference fixture requires an exact pdftoppm crop")
    }
    await Bun.write(
      `${output_prefix}.png`,
      referenceGraphPng(Number(request.command[width_index + 1]), Number(request.command[height_index + 1])),
    )
    return { exit_code: 0, duration_ms: 1, output_tail: "" }
  }
}

const publication_reference_runner = new PublicationReferenceRunner()

async function writeReferenceProof(input: { model_dir: string; evidence_dir: string }): Promise<void> {
  const datasheet = await readFile(join(input.model_dir, "datasheet.pdf"))
  const source_pdf_sha256 = createHash("sha256").update(datasheet).digest("hex")
  const fixture_evidence_context =
    "Figure 1. VOUT = 1 V. Load current steps from 0 A to 1 mA, tr = 700 us, tf = 100 us. Output voltage response."
  const transient_fixture_evidence = deriveTimeGraphTransientFixtureEvidence(fixture_evidence_context)
  if (!transient_fixture_evidence) {
    throw new Error("Publication reference fixture must prove its printed current step")
  }
  const discovery_value = {
    version: 1,
    source_pdf_sha256,
    page_count: 1,
    hints: [
      {
        hint_id: "time_graph_001",
        page: 1,
        figure: "Figure 1",
        reason: "Figure 1. Output voltage response",
        operating_condition_evidence: fixture_evidence_context,
        fixture_evidence_context,
        summary_fixture_evidence_context: null,
        condition_conflicts: [],
        unsupported_fixture_conditions: [],
        transient_fixture_evidence,
      },
    ],
  }
  const observation_value = {
    version: 1,
    source_pdf_sha256,
    reviewed_hints: [
      {
        hint_id: "time_graph_001",
        disposition: "graph",
        graph_id: "output_voltage",
        reason: "The printed horizontal axis is elapsed time.",
      },
    ],
    graphs: [
      {
        graph_id: "output_voltage",
        page: 1,
        locator: "Figure 1",
        x_axis: "time",
        time_axis_evidence: "Time (100 us/div)",
        response_quantity: "voltage",
        public_pin_observable: true,
        fixture_reproducible: true,
        reason: "The public OUT voltage responds to a public current step.",
        crop: { page: 1, render_dpi: 200, x_px: 0, y_px: 0, width_px: 96, height_px: 64 },
        electrical_binding,
        digitized_curve: {
          method: "manual_pixel_trace",
          x_quantity: "time",
          x_unit: "s",
          y_quantity: "voltage",
          y_unit: "V",
          x_range: { min: 0, max: 0.0007 },
          y_range: { min: 0, max: 1 },
          x_axis: {
            scale: "linear",
            first: { pixel: 4, value: 0 },
            second: { pixel: 91, value: 0.0007 },
          },
          y_axis: {
            scale: "linear",
            first: { pixel: 58, value: 0 },
            second: { pixel: 5, value: 1 },
          },
          trace_color: { r: 20, g: 80, b: 180, tolerance: 24 },
          points: Array.from({ length: 8 }, (_, index) => {
            const ratio = index / 7
            return {
              pixel_x: 4 + ratio * 87,
              pixel_y: 58 - ratio * 53,
            }
          }),
        },
      },
    ],
  }
  await mkdir(join(input.evidence_dir, "figures"), { recursive: true })
  await Promise.all([
    Bun.write(join(input.evidence_dir, "figures", "output_voltage.png"), referenceGraphPng()),
    Bun.write(join(input.model_dir, "time-graph-hints.json"), `${JSON.stringify(discovery_value)}\n`),
    Bun.write(
      join(input.model_dir, "model-reference-observation.json"),
      `${JSON.stringify(observation_value)}\n`,
    ),
  ])
  const discovery = parseTimeGraphDiscovery(discovery_value, source_pdf_sha256)
  const observation = parseReferenceGraphObservation(observation_value, discovery, contract.interface)
  const source_proof = await buildReferenceGraphSourceProof({
    observation,
    datasheet_path: join(input.model_dir, "datasheet.pdf"),
    process_runner: publication_reference_runner,
    signal: new AbortController().signal,
  })
  const source_observation = applyReferenceGraphSourceEligibility({ observation, proof: source_proof })
  await Bun.write(
    join(input.model_dir, "model-reference-observation.json"),
    `${JSON.stringify(source_observation)}\n`,
  )
  const numeric_verification = verifyCharacterizationGraphEvidence({
    characterization: contract.characterization,
    observation: source_observation,
    source_proof,
  })
  const verification = await verifyReferenceGraphTracePixels({
    characterization: contract.characterization,
    observation: source_observation,
    numeric_verification,
    evidence_dir: input.evidence_dir,
  })
  await Promise.all([
    Bun.write(
      join(input.model_dir, "model-reference-source-proof.json"),
      `${JSON.stringify(source_proof)}\n`,
    ),
    Bun.write(
      join(input.model_dir, "model-reference-verification.json"),
      `${JSON.stringify(verification)}\n`,
    ),
  ])
}

async function createWorkspace(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporary_directories.push(root)
  const job_dir = join(root, "job")
  const model_dir = join(job_dir, "spice")
  const evidence_dir = join(model_dir, "attempt-evidence")
  await Promise.all([mkdir(evidence_dir, { recursive: true }), mkdir(job_dir, { recursive: true })])
  const original_component = 'export default function Original() { return <chip name="U1" /> }\n'
  const original_circuit = [
    { type: "source_component", source_component_id: "source_component_1", name: "U1" },
    {
      type: "source_port",
      source_port_id: "source_port_1",
      source_component_id: "source_component_1",
      pin_number: "1",
      name: "OUT",
      port_hints: ["pin1", "OUT"],
    },
  ] as unknown as AnyCircuitElement[]
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.4\n"),
    Bun.write(join(model_dir, "datasheet.pdf"), "%PDF-1.4\n"),
    Bun.write(join(job_dir, "index.circuit.tsx"), original_component),
    Bun.write(join(job_dir, "component.circuit.tsx"), original_component),
    Bun.write(join(job_dir, "component.circuit.json"), JSON.stringify(original_circuit)),
    Bun.write(join(model_dir, "component.circuit.tsx"), original_component),
    Bun.write(join(model_dir, "component.circuit.json"), JSON.stringify(original_circuit)),
    Bun.write(join(model_dir, "model-interface.json"), JSON.stringify(contract.interface)),
  ])
  return { root, job_dir, model_dir, evidence_dir, original_component, original_circuit }
}

async function createPreparedPublication(input: {
  job_dir: string
  model_dir: string
  evidence_dir: string
  model_run_id: string
  invocation_id: string
  generated: GeneratedModel
  result?: ValidationRunResult
  caller_publication_policy?: "legacy_compatibility"
}) {
  const wrapper_dir = join(input.model_dir, "wrapper-stage")
  await mkdir(wrapper_dir, { recursive: true })
  const wrapper_source = await writeIntegratedComponent({
    model_dir: wrapper_dir,
    manifest: input.generated.manifest,
    model_source: input.generated.source,
  })
  const circuit_json = componentCircuit(input.generated.source)
  const job_id = input.model_run_id.replace(/^model_/, "job_")
  await writeReferenceProof(input)
  const publication_input = {
    job_id,
    job_dir: input.job_dir,
    model_dir: input.model_dir,
    model_run_id: input.model_run_id,
    invocation_id: input.invocation_id,
    contract,
    plan,
    result: input.result ?? passingResult(input.generated),
    generated: input.generated,
    evidence_dir: input.evidence_dir,
    wrapper_source,
    circuit_json,
    circuit_json_by_case: { output_voltage: validationCircuit(input.generated) },
    process_runner: publication_reference_runner,
    ...(input.caller_publication_policy ? { publication_policy: input.caller_publication_policy } : {}),
  }
  return prepareModelPublication(publication_input)
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  )
}

test("publication preparation rejects a forged passing result with a truncated case list", async () => {
  const workspace = await createWorkspace("model-publication-truncated-cases-")
  const accepted = generatedModel(1)

  await expect(
    createPreparedPublication({
      ...workspace,
      model_run_id: "model_truncated_cases",
      invocation_id: crypto.randomUUID(),
      generated: accepted,
      result: { ...passingResult(accepted), cases: [] },
    }),
  ).rejects.toThrow(/cases has 0 cases; the current plan has 1/)

  expect(await Bun.file(join(workspace.job_dir, "published-model.json")).exists()).toBe(false)
  expect(await Bun.file(join(workspace.model_dir, "accepted-revisions")).exists()).toBe(false)
})

test("publication preparation rejects a passing flag over non-finite simulator points", async () => {
  const workspace = await createWorkspace("model-publication-non-finite-points-")
  const accepted = generatedModel(1)
  const forged = passingResult(accepted)
  forged.cases[0]!.series[0]!.points[0]!.y = Number.POSITIVE_INFINITY

  await expect(
    createPreparedPublication({
      ...workspace,
      model_run_id: "model_non_finite_points",
      invocation_id: crypto.randomUUID(),
      generated: accepted,
      result: forged,
    }),
  ).rejects.toThrow(/point.*y must be a finite number/)

  expect(await Bun.file(join(workspace.job_dir, "published-model.json")).exists()).toBe(false)
})

test("a caller cannot downgrade the normal publication writer to legacy policy", async () => {
  const workspace = await createWorkspace("model-publication-fresh-downgrade-")
  const accepted = generatedModel(1)

  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_fresh_downgrade",
    invocation_id: crypto.randomUUID(),
    generated: accepted,
    caller_publication_policy: "legacy_compatibility",
  })

  expect(prepared.commit).toMatchObject({
    version: 3,
    publication_policy: "fresh_time_voltage_v1",
  })
  for (const bundle of [prepared.accepted_model_dir, prepared.published_component_dir]) {
    expect(JSON.parse(await readFile(join(bundle, "model-workflow-policy.json"), "utf8"))).toEqual({
      version: 1,
      policy: "fresh_time_voltage_v1",
    })
  }
})

test("accepted publication retains and binds the independent reference-graph trace", async () => {
  const workspace = await createWorkspace("model-publication-reference-trace-")
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_reference_trace",
    invocation_id: crypto.randomUUID(),
    generated: generatedModel(1),
  })

  const expected_artifact_identity = {
    preview_generation: basename(prepared.accepted_model_dir),
    model_revision: prepared.commit.revision,
  }
  expect(prepared.projection.validation.preview_generation).toBe(
    expected_artifact_identity.preview_generation,
  )
  expect(prepared.projection.selected_previews.output_voltage?.artifact_identity).toEqual(
    expected_artifact_identity,
  )
  expect(
    JSON.parse(
      await readFile(
        join(prepared.accepted_model_dir, "validation", "cases", "output_voltage.preview.json"),
        "utf8",
      ),
    ).artifact_identity,
  ).toEqual(expected_artifact_identity)

  const manifest = JSON.parse(
    await readFile(join(prepared.accepted_model_dir, "bundle-manifest.json"), "utf8"),
  ) as { files: Record<string, { size_bytes: number }> }
  for (const file of [
    "time-graph-hints.json",
    "model-reference-observation.json",
    "model-reference-source-proof.json",
    "model-reference-verification.json",
  ]) {
    const contents = await readFile(join(workspace.model_dir, file), "utf8")
    expect(await readFile(join(prepared.accepted_model_dir, file), "utf8")).toBe(contents)
    expect(manifest.files[file]).toMatchObject({ size_bytes: Buffer.byteLength(contents) })
  }
  const datasheet = await readFile(join(workspace.model_dir, "datasheet.pdf"))
  expect(await readFile(join(prepared.accepted_model_dir, "datasheet.pdf"))).toEqual(datasheet)
  expect(manifest.files["datasheet.pdf"]).toMatchObject({ size_bytes: datasheet.byteLength })
})

test("publication preparation rolls back a sibling bundle after a partial promotion failure", async () => {
  const workspace = await createWorkspace("model-publication-partial-promotion-")
  await Bun.write(join(workspace.job_dir, "published-models"), "blocks the destination directory\n")

  await expect(
    createPreparedPublication({
      ...workspace,
      model_run_id: "model_partial_promotion",
      invocation_id: crypto.randomUUID(),
      generated: generatedModel(1),
    }),
  ).rejects.toThrow(/materialize both immutable bundles/)

  const accepted_revisions = await readdir(join(workspace.model_dir, "accepted-revisions")).catch(() => [])
  expect(accepted_revisions).toEqual([])
  expect(await Bun.file(join(workspace.job_dir, "published-model.json")).exists()).toBe(false)
})

test("a committed pointer recovers one authoritative pair before store and root mirrors catch up", async () => {
  const workspace = await createWorkspace("model-publication-crash-")
  const job_store = new JobStore()
  const model_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_publication", job_dir: workspace.job_dir, file_name: "part.pdf" })
  job_store.updateJob("job_publication", {
    display_status: "complete",
    is_complete: true,
    component_ready: true,
    component_code: workspace.original_component,
    circuit_json: workspace.original_circuit,
  })
  model_store.createModelRun({
    model_run_id: "model_publication",
    job_id: "job_publication",
    model_dir: workspace.model_dir,
    effort_multiplier: 1,
  })
  const old = generatedModel(0.5)
  const invocation_id = crypto.randomUUID()
  model_store.updateModelRun("model_publication", {
    status: "validating",
    is_complete: false,
    current_invocation_id: invocation_id,
    model_source: old.source,
    model_card: old.card,
    manifest: old.manifest,
  })
  await Promise.all([
    Bun.write(join(workspace.model_dir, "model.lib"), old.source),
    Bun.write(join(workspace.model_dir, "model-card.md"), old.card),
    Bun.write(join(workspace.job_dir, "model.lib"), old.source),
  ])
  const accepted = generatedModel(1)
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_publication",
    invocation_id,
    generated: accepted,
  })

  // Simulate power loss at the exact commit barrier: immutable snapshots and
  // pointer are durable, but live stores and root compatibility files are old.
  commitModelPublication(workspace.job_dir, prepared.commit.job_id, prepared.commit)

  expect(await readFile(join(workspace.model_dir, "model.lib"), "utf8")).toBe(old.source)
  expect(await readFile(join(workspace.job_dir, "index.circuit.tsx"), "utf8")).toBe(
    workspace.original_component,
  )

  const restored_models = new ModelRunStore()
  const restored_model = await restoreModelDirectory({
    job_id: "job_publication",
    model_dir: workspace.model_dir,
    model_run_store: restored_models,
  })
  expect(restored_model).toMatchObject({
    status: "complete",
    is_complete: true,
    has_errors: false,
    current_invocation_id: invocation_id,
    model_source: accepted.source,
    model_card: accepted.card,
    manifest: { revision: accepted.manifest.revision },
    validation: { all_passed: true },
  })

  const restored_jobs = new JobStore()
  const restored_job = await restoreJobDirectory({
    job_id: "job_publication",
    job_dir: workspace.job_dir,
    job_store: restored_jobs,
  })
  expect(restored_job?.component_code).toContain("<spicemodel")
  expect(
    restored_job?.circuit_json?.find(({ type }) => type === "simulation_spice_subcircuit"),
  ).toMatchObject({ subcircuit_source: accepted.source })

  // A post-pointer debug/event write can checkpoint the same invocation as
  // failed. The committed invocation remains the authoritative outcome.
  model_store.updateModelRun("model_publication", {
    status: "failed",
    is_complete: true,
    has_errors: true,
    error_message: "post-commit bookkeeping failed",
    current_invocation_id: invocation_id,
  })
  const failed_checkpoint_models = new ModelRunStore()
  const recovered_failed_checkpoint = await restoreModelDirectory({
    job_id: "job_publication",
    model_dir: workspace.model_dir,
    model_run_store: failed_checkpoint_models,
  })
  expect(recovered_failed_checkpoint).toMatchObject({
    status: "complete",
    is_complete: true,
    has_errors: false,
    current_invocation_id: invocation_id,
    model_source: accepted.source,
  })
  expect(recovered_failed_checkpoint?.error_message).toBeUndefined()

  // A later invocation must retain this accepted pair without being mistaken
  // for the invocation that crossed the commit barrier.
  const newer_invocation_id = crypto.randomUUID()
  model_store.updateModelRun("model_publication", {
    status: "validating",
    is_complete: false,
    current_invocation_id: newer_invocation_id,
  })
  const retried_models = new ModelRunStore()
  const retained = await restoreModelDirectory({
    job_id: "job_publication",
    model_dir: workspace.model_dir,
    model_run_store: retried_models,
  })
  expect(retained).toMatchObject({
    status: "failed",
    is_complete: true,
    has_errors: true,
    model_source: accepted.source,
  })
  expect(retained?.warnings?.some((warning) => warning.startsWith(RETAINED_ACCEPTED_WARNING_PREFIX))).toBe(
    true,
  )
  expect(retained?.validation).toBeUndefined()
  expect(retained?.circuit_preview).toBeUndefined()
  expect(retained?.reference_preview).toBeUndefined()
  expect(retained?.preview_options).toEqual([])

  // A fully persisted candidate projection remains inspectable after restart,
  // while the accepted model/download identity stays authoritative.
  const preview_generation = `candidate-${newer_invocation_id}-${accepted.manifest.revision}`
  const candidate_ui = structuredClone(prepared.projection)
  candidate_ui.validation.artifact_state = "candidate"
  candidate_ui.validation.model_revision = "candidate-r2"
  candidate_ui.validation.preview_generation = preview_generation
  const candidate_preview_dir = join(workspace.model_dir, "current-previews", preview_generation)
  await mkdir(candidate_preview_dir, { recursive: true })
  await Promise.all([
    Bun.write(join(candidate_preview_dir, "model-ui.json"), `${JSON.stringify(candidate_ui)}\n`),
    Bun.write(
      join(workspace.model_dir, "current-preview.json"),
      `${JSON.stringify({
        version: 1,
        model_run_id: "model_publication",
        invocation_id: newer_invocation_id,
        revision: "candidate-r2",
        preview_generation,
      })}\n`,
    ),
  ])
  const restored_candidate = await restoreModelDirectory({
    job_id: "job_publication",
    model_dir: workspace.model_dir,
    model_run_store: new ModelRunStore(),
  })
  expect(restored_candidate).toMatchObject({
    status: "failed",
    model_source: accepted.source,
    manifest: { revision: accepted.manifest.revision },
    validation: {
      artifact_state: "candidate",
      model_revision: "candidate-r2",
      preview_generation,
    },
    preview_options: [{ benchmark_id: "output_voltage" }],
    circuit_preview: { source_file: "validation/cases/output_voltage.circuit.tsx" },
  })
  const forged_candidate_ui = {
    ...structuredClone(candidate_ui),
    selected_previews: {
      ...candidate_ui.selected_previews,
      output_voltage: {
        circuit_preview: {
          source_file: "validation/cases/output_voltage.circuit.tsx",
          code: "",
          build_status: "ready",
          updated_at: "2026-08-01T00:00:00.000Z",
          analysis_type: "transient",
          analog_simulation_status: "available",
        },
      },
    },
  }
  await Bun.write(join(candidate_preview_dir, "model-ui.json"), `${JSON.stringify(forged_candidate_ui)}\n`)
  const restored_forged_candidate = await restoreModelDirectory({
    job_id: "job_publication",
    model_dir: workspace.model_dir,
    model_run_store: new ModelRunStore(),
  })
  expect(restored_forged_candidate?.validation).toMatchObject({
    artifact_state: "candidate",
    preview_generation,
  })
  expect(restored_forged_candidate?.circuit_preview).toBeUndefined()
  expect(restored_forged_candidate?.reference_preview).toBeUndefined()
  await Promise.all([
    rm(join(workspace.model_dir, "current-preview.json"), { force: true }),
    rm(join(workspace.model_dir, "current-previews"), { recursive: true, force: true }),
  ])

  // A compatibility checkpoint cannot promote a newer invocation merely by
  // claiming completion; only the pointer-owning invocation crossed commit.
  model_store.updateModelRun("model_publication", {
    status: "complete",
    is_complete: true,
    has_errors: false,
    current_invocation_id: newer_invocation_id,
  })
  const uncommitted_completion = await restoreModelDirectory({
    job_id: "job_publication",
    model_dir: workspace.model_dir,
    model_run_store: new ModelRunStore(),
  })
  expect(uncommitted_completion).toMatchObject({
    status: "failed",
    is_complete: true,
    has_errors: true,
    current_invocation_id: newer_invocation_id,
    model_source: accepted.source,
    validation: undefined,
  })
  expect(uncommitted_completion?.error_message).toMatch(/claimed completion without committing/)
})

test("a valid publication cannot replace its owning job marker but recovers a missing model checkpoint", async () => {
  const workspace = await createWorkspace("model-publication-checkpoint-loss-")
  const accepted = generatedModel(1)
  const invocation_id = crypto.randomUUID()
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_checkpoint_loss",
    invocation_id,
    generated: accepted,
  })
  commitModelPublication(workspace.job_dir, prepared.commit.job_id, prepared.commit)

  await expect(
    restoreJobDirectory({
      job_id: "job_checkpoint_loss",
      job_dir: workspace.job_dir,
      job_store: new JobStore(),
    }),
  ).rejects.toMatchObject({
    name: "JobRestoreMarkerError",
    code: "job_marker_missing_with_publication",
  })

  const restored_without_checkpoint = await restoreModelDirectory({
    job_id: "job_checkpoint_loss",
    model_dir: workspace.model_dir,
    model_run_store: new ModelRunStore(),
  })
  expect(restored_without_checkpoint).toMatchObject({
    model_run_id: "model_checkpoint_loss",
    job_id: "job_checkpoint_loss",
    status: "complete",
    is_complete: true,
    has_errors: false,
    current_invocation_id: invocation_id,
    model_source: accepted.source,
  })

  await Bun.write(join(workspace.model_dir, "model-run.json"), "{not json")
  const restored_with_corrupt_checkpoint = await restoreModelDirectory({
    job_id: "job_checkpoint_loss",
    model_dir: workspace.model_dir,
    model_run_store: new ModelRunStore(),
  })
  expect(restored_with_corrupt_checkpoint).toMatchObject({
    model_run_id: "model_checkpoint_loss",
    status: "complete",
    has_errors: false,
    current_invocation_id: invocation_id,
    model_source: accepted.source,
  })

  for (const current_invocation_id of [undefined, "invalid invocation id"]) {
    await Bun.write(
      join(workspace.model_dir, "model-run.json"),
      JSON.stringify({
        model_run_id: "model_checkpoint_loss",
        job_id: "job_checkpoint_loss",
        status: "failed",
        is_complete: true,
        has_errors: true,
        ...(current_invocation_id === undefined ? {} : { current_invocation_id }),
      }),
    )
    const restored_without_newer_identity = await restoreModelDirectory({
      job_id: "job_checkpoint_loss",
      model_dir: workspace.model_dir,
      model_run_store: new ModelRunStore(),
    })
    expect(restored_without_newer_identity).toMatchObject({
      model_run_id: "model_checkpoint_loss",
      status: "complete",
      is_complete: true,
      has_errors: false,
      current_invocation_id: invocation_id,
      model_source: accepted.source,
    })
  }

  await Bun.write(
    join(workspace.model_dir, "model-run.json"),
    JSON.stringify({
      model_run_id: "different_model_run",
      job_id: "job_checkpoint_loss",
      status: "failed",
      current_invocation_id: crypto.randomUUID(),
    }),
  )
  const restored_with_conflicting_checkpoint = await restoreModelDirectory({
    job_id: "job_checkpoint_loss",
    model_dir: workspace.model_dir,
    model_run_store: new ModelRunStore(),
  })
  expect(restored_with_conflicting_checkpoint).toMatchObject({
    model_run_id: "model_checkpoint_loss",
    status: "complete",
    has_errors: false,
    current_invocation_id: invocation_id,
    model_source: accepted.source,
  })
  expect(restored_with_conflicting_checkpoint?.warnings).toContain(
    "Ignored a conflicting model-run checkpoint and recovered the hash-verified accepted publication.",
  )
})

test("a failed integrated build cannot replace the prior accepted root files or state", async () => {
  const workspace = await createWorkspace("model-publication-integration-failure-")
  const job_store = new JobStore()
  const model_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_integration", job_dir: workspace.job_dir, file_name: "part.pdf" })
  job_store.updateJob("job_integration", {
    display_status: "complete",
    is_complete: true,
    component_ready: true,
    component_code: workspace.original_component,
    circuit_json: workspace.original_circuit,
  })
  model_store.createModelRun({
    model_run_id: "model_integration",
    job_id: "job_integration",
    model_dir: workspace.model_dir,
    effort_multiplier: 1,
  })
  const old = generatedModel(0.5)
  model_store.updateModelRun("model_integration", {
    status: "complete",
    is_complete: true,
    model_source: old.source,
    model_card: old.card,
    manifest: old.manifest,
  })
  await Promise.all([
    Bun.write(join(workspace.model_dir, "model.lib"), old.source),
    Bun.write(join(workspace.model_dir, "model-card.md"), old.card),
    Bun.write(join(workspace.model_dir, "model-manifest.json"), JSON.stringify(old.manifest)),
    Bun.write(join(workspace.job_dir, "model.lib"), old.source),
  ])

  const candidate = generatedModel(1)
  const candidate_dir = join(workspace.model_dir, "candidates", "candidate")
  const attempt_dir = join(workspace.model_dir, "attempts", "candidate")
  const validation_dir = join(candidate_dir, "validation")
  const canonical_plan = parseValidationPlan(plan, {
    model_interface: contract.interface,
    model_requirements: contract.characterization.requirements,
    model_family: contract.characterization.family,
  })
  const candidate_result = passingResult(candidate)
  await Promise.all([mkdir(validation_dir, { recursive: true }), mkdir(attempt_dir, { recursive: true })])
  await Promise.all([
    Bun.write(join(candidate_dir, "model.lib"), candidate.source),
    Bun.write(join(candidate_dir, "model-card.md"), candidate.card),
    Bun.write(join(candidate_dir, "model-manifest.json"), JSON.stringify(candidate.manifest)),
    Bun.write(join(attempt_dir, "model-contract.json"), JSON.stringify(contract)),
    Bun.write(join(attempt_dir, "validation-plan.json"), JSON.stringify(canonical_plan)),
    Bun.write(join(validation_dir, "validation-results.json"), JSON.stringify(candidate_result)),
  ])
  await writeViewerValidationArtifacts({
    validation_dir,
    plan: canonical_plan,
    generated: candidate,
    circuit_json_by_case: { output_voltage: validationCircuit(candidate) },
  })

  const process_runner: ProcessRunner = {
    async run(request) {
      const wrapper_source = await readFile(join(request.cwd, "component-with-model.circuit.tsx"), "utf8")
      const encoded_source = /^const modelSource = (.+)$/m.exec(wrapper_source)?.[1]
      if (!encoded_source) throw new Error("Missing wrapper model source")
      const source = JSON.parse(encoded_source) as string
      const output_dir = join(request.cwd, "dist", "component-with-model")
      await mkdir(output_dir, { recursive: true })
      await Bun.write(
        join(output_dir, "circuit.json"),
        JSON.stringify(componentCircuit(source, "wrong_source_port")),
      )
      return { exit_code: 0, duration_ms: 1, output_tail: "" }
    },
  }
  const unused_agent: AgentClient = {
    async run() {
      throw new Error("Agent must not run during publication")
    },
  }

  await expect(
    publishModelStage.execute({
      run_id: "model_integration",
      pipeline_id: "spice_generation",
      stage_id: "publish",
      debug_dir: join(workspace.model_dir, "debug"),
      context: {
        model_run_id: "model_integration",
        job_id: "job_integration",
        job_dir: workspace.job_dir,
        model_dir: workspace.model_dir,
        use_openai: false,
        max_repair_attempts: 1,
        invocation_id: crypto.randomUUID(),
      },
      services: {
        job_store,
        model_run_store: model_store,
        agent_client: unused_agent,
        process_runner,
        strategy_registry: new ModelStrategyRegistry(),
        tsci_bin: "fixture-tsci",
        ngspice_bin: "unused-ngspice",
        ngspice_executor: async () => {
          throw new Error("ngspice must not run during publication")
        },
      },
      dependency_outputs: {
        repair_spice_model: {
          result_path: join(validation_dir, "validation-results.json"),
          model_path: join(candidate_dir, "model.lib"),
          model_card_path: join(candidate_dir, "model-card.md"),
          manifest_path: join(candidate_dir, "model-manifest.json"),
          contract_path: join(attempt_dir, "model-contract.json"),
          plan_path: join(attempt_dir, "validation-plan.json"),
          evidence_dir: workspace.evidence_dir,
          passed: true,
          repair_attempts: 0,
          revision: candidate.manifest.revision,
        },
      },
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/pin mapping/)

  expect(await Bun.file(join(workspace.job_dir, "published-model.json")).exists()).toBe(false)
  expect(await readFile(join(workspace.model_dir, "model.lib"), "utf8")).toBe(old.source)
  expect(await readFile(join(workspace.model_dir, "model-card.md"), "utf8")).toBe(old.card)
  expect(await readFile(join(workspace.job_dir, "index.circuit.tsx"), "utf8")).toBe(
    workspace.original_component,
  )
  expect(await readFile(join(workspace.job_dir, "model.lib"), "utf8")).toBe(old.source)
  expect(model_store.getModelRun("model_integration")).toMatchObject({
    model_source: old.source,
    model_card: old.card,
    manifest: { revision: old.manifest.revision },
  })
})

test("a committed bundle rejects tampering before readers select it", async () => {
  const workspace = await createWorkspace("model-publication-tamper-")
  const accepted = generatedModel(1)
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_tamper",
    invocation_id: crypto.randomUUID(),
    generated: accepted,
  })
  commitModelPublication(workspace.job_dir, prepared.commit.job_id, prepared.commit)
  await Bun.write(join(prepared.accepted_model_dir, "model-card.md"), "tampered\n")

  await expect(readModelPublication(workspace.job_dir, prepared.commit.job_id)).rejects.toThrow(
    /bundle contents/,
  )
})

test("fresh publication readers reject hash-consistent stale validation artifacts", async () => {
  const workspace = await createWorkspace("model-publication-stale-validation-")
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_stale_validation",
    invocation_id: crypto.randomUUID(),
    generated: generatedModel(1),
  })
  const result_path = join(prepared.accepted_model_dir, "validation-results.json")
  const stale_result = JSON.parse(await readFile(result_path, "utf8")) as {
    hashes: { model_sha256: string }
    stimulus_causality?: { hashes: { model_sha256: string } }
  }
  stale_result.hashes.model_sha256 = "0".repeat(64)
  if (stale_result.stimulus_causality) {
    stale_result.stimulus_causality.hashes.model_sha256 = "0".repeat(64)
  }
  await Bun.write(result_path, JSON.stringify(stale_result))
  const accepted_bundle_manifest_sha256 = await writePublicationBundleManifest(prepared.accepted_model_dir)
  commitModelPublication(workspace.job_dir, prepared.commit.job_id, {
    ...prepared.commit,
    accepted_bundle_manifest_sha256,
  })

  await expect(readModelPublication(workspace.job_dir, prepared.commit.job_id)).rejects.toThrow(
    /validation input hash mismatch.*model\.lib/,
  )
})

test("fresh publication pointers require the bound fresh policy", async () => {
  const workspace = await createWorkspace("model-publication-pointer-policy-")
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_pointer_policy",
    invocation_id: crypto.randomUUID(),
    generated: generatedModel(1),
  })
  const pointer_path = join(workspace.job_dir, "published-model.json")
  const { publication_policy: _publication_policy, ...missing_policy } = prepared.commit
  await Bun.write(pointer_path, JSON.stringify(missing_policy))
  await expect(readModelPublication(workspace.job_dir, prepared.commit.job_id)).rejects.toThrow(
    /unexpected or missing fields/,
  )

  await Bun.write(
    pointer_path,
    JSON.stringify({ ...prepared.commit, publication_policy: "legacy_compatibility" }),
  )
  await expect(readModelPublication(workspace.job_dir, prepared.commit.job_id)).rejects.toThrow(
    /publication_policy must be fresh_time_voltage_v1/,
  )
})

test("fresh publication resolution rejects missing or mismatched bundle policy markers", async () => {
  const missing_workspace = await createWorkspace("model-publication-missing-policy-")
  const missing_prepared = await createPreparedPublication({
    ...missing_workspace,
    model_run_id: "model_missing_policy",
    invocation_id: crypto.randomUUID(),
    generated: generatedModel(1),
  })
  await unlink(join(missing_prepared.accepted_model_dir, "model-workflow-policy.json"))
  const missing_manifest_sha256 = await writePublicationBundleManifest(missing_prepared.accepted_model_dir)
  commitModelPublication(missing_workspace.job_dir, missing_prepared.commit.job_id, {
    ...missing_prepared.commit,
    accepted_bundle_manifest_sha256: missing_manifest_sha256,
  })
  await expect(
    readModelPublication(missing_workspace.job_dir, missing_prepared.commit.job_id),
  ).rejects.toThrow(/does not contain model-workflow-policy\.json/)

  const mismatch_workspace = await createWorkspace("model-publication-mismatched-policy-")
  const mismatch_prepared = await createPreparedPublication({
    ...mismatch_workspace,
    model_run_id: "model_mismatched_policy",
    invocation_id: crypto.randomUUID(),
    generated: generatedModel(1),
  })
  await Bun.write(
    join(mismatch_prepared.published_component_dir, "model-workflow-policy.json"),
    JSON.stringify({ version: 1, policy: "legacy_compatibility" }),
  )
  const mismatch_manifest_sha256 = await writePublicationBundleManifest(
    mismatch_prepared.published_component_dir,
  )
  commitModelPublication(mismatch_workspace.job_dir, mismatch_prepared.commit.job_id, {
    ...mismatch_prepared.commit,
    published_component_bundle_manifest_sha256: mismatch_manifest_sha256,
  })
  await expect(
    readModelPublication(mismatch_workspace.job_dir, mismatch_prepared.commit.job_id),
  ).rejects.toThrow(/fresh workflow policy does not match both published bundles/)
})

test("legacy version 2 publications remain readable but cannot be written by the normal writer", async () => {
  const workspace = await createWorkspace("model-publication-legacy-read-")
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_legacy_read",
    invocation_id: crypto.randomUUID(),
    generated: generatedModel(1),
  })
  const bundle_directories = [prepared.accepted_model_dir, prepared.published_component_dir]
  for (const directory of bundle_directories) {
    const record = JSON.parse(await readFile(join(directory, "publication-record.json"), "utf8")) as Record<
      string,
      unknown
    >
    delete record.publication_policy
    record.version = 2
    await Promise.all([
      Bun.write(join(directory, "publication-record.json"), JSON.stringify(record)),
      unlink(join(directory, "model-workflow-policy.json")),
    ])
  }
  const [accepted_bundle_manifest_sha256, published_component_bundle_manifest_sha256] = await Promise.all(
    bundle_directories.map(writePublicationBundleManifest),
  )
  const {
    version: _version,
    publication_policy: _policy,
    accepted_bundle_manifest_sha256: _accepted_hash,
    published_component_bundle_manifest_sha256: _component_hash,
    ...legacy_identity
  } = prepared.commit
  const legacy_commit = {
    version: 2 as const,
    ...legacy_identity,
    accepted_bundle_manifest_sha256,
    published_component_bundle_manifest_sha256,
  }

  expect(() =>
    commitModelPublication(workspace.job_dir, prepared.commit.job_id, legacy_commit as never),
  ).toThrow(/only fresh version 3 publications/)

  await Bun.write(join(workspace.job_dir, "published-model.json"), JSON.stringify(legacy_commit))
  const resolved = await readModelPublication(workspace.job_dir, prepared.commit.job_id)
  expect(resolved?.commit).toMatchObject({ version: 2, publication_id: prepared.commit.publication_id })
})

test("publication identity is bound into both immutable bundles", async () => {
  const workspace = await createWorkspace("model-publication-identity-")
  const accepted = generatedModel(1)
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_identity",
    invocation_id: crypto.randomUUID(),
    generated: accepted,
  })
  commitModelPublication(workspace.job_dir, prepared.commit.job_id, prepared.commit)
  const pointer_path = join(workspace.job_dir, "published-model.json")
  const changed_pointer = {
    ...JSON.parse(await readFile(pointer_path, "utf8")),
    invocation_id: crypto.randomUUID(),
  }
  await Bun.write(pointer_path, JSON.stringify(changed_pointer))

  await expect(readModelPublication(workspace.job_dir, prepared.commit.job_id)).rejects.toThrow(
    /metadata does not match/,
  )
})

test("matching bundle hashes cannot bless a non-server-owned wrapper", async () => {
  const workspace = await createWorkspace("model-publication-wrapper-identity-")
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_wrapper_identity",
    invocation_id: crypto.randomUUID(),
    generated: generatedModel(1),
  })
  const replacement = 'export default function Unrelated() { return <chip name="WRONG" /> }\n'
  await Promise.all([
    Bun.write(join(prepared.accepted_model_dir, "component-with-model.circuit.tsx"), replacement),
    Bun.write(join(prepared.published_component_dir, "index.circuit.tsx"), replacement),
  ])
  const [accepted_bundle_manifest_sha256, published_component_bundle_manifest_sha256] = await Promise.all([
    writePublicationBundleManifest(prepared.accepted_model_dir),
    writePublicationBundleManifest(prepared.published_component_dir),
  ])
  commitModelPublication(workspace.job_dir, prepared.commit.job_id, {
    ...prepared.commit,
    accepted_bundle_manifest_sha256,
    published_component_bundle_manifest_sha256,
  })

  await expect(readModelPublication(workspace.job_dir, prepared.commit.job_id)).rejects.toThrow(
    /server-owned model integration/,
  )
})

test("publication readers reject pointer and ancestor symlinks", async () => {
  const pointer_workspace = await createWorkspace("model-publication-pointer-symlink-")
  const pointer_prepared = await createPreparedPublication({
    ...pointer_workspace,
    model_run_id: "model_pointer_symlink",
    invocation_id: crypto.randomUUID(),
    generated: generatedModel(1),
  })
  commitModelPublication(pointer_workspace.job_dir, pointer_prepared.commit.job_id, pointer_prepared.commit)
  const pointer_path = join(pointer_workspace.job_dir, "published-model.json")
  const pointer_target = join(pointer_workspace.root, "pointer-target.json")
  await rename(pointer_path, pointer_target)
  await symlink(pointer_target, pointer_path)
  await expect(
    readModelPublication(pointer_workspace.job_dir, pointer_prepared.commit.job_id),
  ).rejects.toThrow(/not a symlink/)

  const ancestor_workspace = await createWorkspace("model-publication-ancestor-symlink-")
  const ancestor_prepared = await createPreparedPublication({
    ...ancestor_workspace,
    model_run_id: "model_ancestor_symlink",
    invocation_id: crypto.randomUUID(),
    generated: generatedModel(1),
  })
  commitModelPublication(
    ancestor_workspace.job_dir,
    ancestor_prepared.commit.job_id,
    ancestor_prepared.commit,
  )
  const accepted_parent = join(ancestor_workspace.model_dir, "accepted-revisions")
  const escaped_parent = join(ancestor_workspace.root, "escaped-accepted-revisions")
  await rename(accepted_parent, escaped_parent)
  await symlink(escaped_parent, accepted_parent)
  await expect(
    readModelPublication(ancestor_workspace.job_dir, ancestor_prepared.commit.job_id),
  ).rejects.toThrow(/outside the job workspace/)
})

test("verified artifact reads reject ancestor and final-path swaps after publication validation", async () => {
  const workspace = await createWorkspace("model-publication-read-swap-")
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_read_swap",
    invocation_id: crypto.randomUUID(),
    generated: generatedModel(1),
  })
  commitModelPublication(workspace.job_dir, prepared.commit.job_id, prepared.commit)
  const publication = await readModelPublication(workspace.job_dir, prepared.commit.job_id)
  if (!publication) throw new Error("publication fixture was not committed")

  const original_source = await readFile(join(prepared.accepted_model_dir, "model.lib"), "utf8")
  const attacker_dir = join(workspace.root, "attacker-accepted")
  const attacker_source = join(attacker_dir, "model.lib")
  const saved_accepted_dir = join(workspace.root, "saved-accepted")
  await mkdir(attacker_dir, { recursive: true })
  await Bun.write(attacker_source, "S".repeat(Buffer.byteLength(original_source)))
  await rename(prepared.accepted_model_dir, saved_accepted_dir)
  await symlink(attacker_dir, prepared.accepted_model_dir)

  await expect(
    readVerifiedPublicationArtifact({
      publication,
      bundle: "accepted_model",
      relative_path: "model.lib",
      max_bytes: 2 * 1024 * 1024,
    }),
  ).rejects.toThrow(/changed after publication validation/)

  await unlink(prepared.accepted_model_dir)
  await rename(saved_accepted_dir, prepared.accepted_model_dir)
  const model_path = join(prepared.accepted_model_dir, "model.lib")
  await rename(model_path, `${model_path}.saved`)
  await symlink(attacker_source, model_path)
  await expect(
    readVerifiedPublicationArtifact({
      publication,
      bundle: "accepted_model",
      relative_path: "model.lib",
      max_bytes: 2 * 1024 * 1024,
    }),
  ).rejects.toThrow(/not a symlink/)
})

test("publication downloads buffer verified bytes before response bodies are consumed", async () => {
  const workspace = await createWorkspace("model-publication-buffered-download-")
  const job_id = "job_buffered_download"
  const model_run_id = "model_buffered_download"
  const job_store = new JobStore()
  const model_store = new ModelRunStore()
  job_store.createJob({ job_id, job_dir: workspace.job_dir, file_name: "part.pdf" })
  model_store.createModelRun({
    model_run_id,
    job_id,
    model_dir: workspace.model_dir,
    effort_multiplier: 1,
  })
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id,
    invocation_id: crypto.randomUUID(),
    generated: generatedModel(1),
  })
  commitModelPublication(workspace.job_dir, job_id, prepared.commit)

  const model_response = await getModelRunFile(
    new URL(`http://localhost/api/model-run/file?job_id=${job_id}&file=model`),
    { model_run_store: model_store } as unknown as ModelRunApiContext,
  )
  const component_response = await getJobFile(
    new URL(`http://localhost/api/job/file?job_id=${job_id}&file=component`),
    { job_store } as unknown as JobApiContext,
  )
  expect(model_response.status).toBe(200)
  expect(component_response.status).toBe(200)

  const model_path = join(prepared.accepted_model_dir, "model.lib")
  const component_path = join(prepared.published_component_dir, "index.circuit.tsx")
  const original_model = await readFile(model_path, "utf8")
  const original_component = await readFile(component_path, "utf8")
  await Promise.all([
    Bun.write(model_path, "M".repeat(Buffer.byteLength(original_model))),
    Bun.write(component_path, "C".repeat(Buffer.byteLength(original_component))),
  ])

  expect(await model_response.text()).toBe(original_model)
  expect(await component_response.text()).toBe(original_component)
})

test("a copied publication cannot cross-wire another job or duplicate its model id on restart", async () => {
  const source = await createWorkspace("model-publication-owner-")
  const owner_job_id = "job_owner"
  const prepared = await createPreparedPublication({
    ...source,
    model_run_id: "model_owner",
    invocation_id: crypto.randomUUID(),
    generated: generatedModel(1),
  })
  const source_job_store = new JobStore()
  source_job_store.createJob({
    job_id: owner_job_id,
    job_dir: source.job_dir,
    file_name: "owner.pdf",
  })
  commitModelPublication(source.job_dir, owner_job_id, prepared.commit)

  const jobs_root = await mkdtemp(join(tmpdir(), "model-publication-cross-job-"))
  temporary_directories.push(jobs_root)
  const owner_dir = join(jobs_root, owner_job_id)
  const copied_job_id = "job_copy"
  const copied_dir = join(jobs_root, copied_job_id)
  await cp(source.job_dir, owner_dir, { recursive: true })
  await cp(owner_dir, copied_dir, { recursive: true })
  new JobStore().createJob({ job_id: copied_job_id, job_dir: copied_dir, file_name: "copy.pdf" })

  const failures: Array<{ job_id: string; cause: string }> = []
  const restored_jobs = new JobStore()
  const restored_models = new ModelRunStore()
  const result = await restorePersistedJobs({
    jobs_root,
    job_store: restored_jobs,
    model_run_store: restored_models,
    on_restore_error: (failure) => {
      failures.push(failure)
    },
  })

  expect(result).toEqual({ jobs_restored: 2, model_runs_restored: 1 })
  expect(restored_jobs.getJob(owner_job_id)?.component_code).toContain("<spicemodel")
  expect(restored_jobs.getJob(copied_job_id)).toMatchObject({
    has_errors: true,
    error_message: expect.stringContaining("belongs to job"),
    warnings: [expect.stringContaining("Committed model publication failed integrity validation")],
  })
  expect(restored_models.getModelRunForJob(owner_job_id)?.model_run_id).toBe("model_owner")
  expect(restored_models.getModelRunForJob(copied_job_id)).toBeUndefined()
  expect(failures).toEqual([
    expect.objectContaining({ job_id: copied_job_id, cause: expect.stringContaining("belongs to job") }),
  ])
})

test("bundle manifests safely bind a file named __proto__", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-publication-prototype-key-"))
  temporary_directories.push(directory)
  await Bun.write(join(directory, "__proto__"), "bound bytes\n")
  await writePublicationBundleManifest(directory)
  const manifest = JSON.parse(await readFile(join(directory, "bundle-manifest.json"), "utf8"))
  expect(Object.hasOwn(manifest.files, "__proto__")).toBe(true)
  expect(manifest.files.__proto__).toMatchObject({ size_bytes: 12 })
})

test("cancellation is checked again before the publication pointer is committed", async () => {
  const workspace = await createWorkspace("model-publication-cancel-")
  const job_store = new JobStore()
  const model_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_cancel", job_dir: workspace.job_dir, file_name: "part.pdf" })
  model_store.createModelRun({
    model_run_id: "model_cancel",
    job_id: "job_cancel",
    model_dir: workspace.model_dir,
    effort_multiplier: 1,
  })
  const accepted = generatedModel(1)
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_cancel",
    invocation_id: crypto.randomUUID(),
    generated: accepted,
  })
  const controller = new AbortController()
  controller.abort(new Error("cancel before publication"))

  await expect(
    commitPreparedModelPublication({
      prepared,
      job_id: "job_cancel",
      job_dir: workspace.job_dir,
      job_store,
      model_dir: workspace.model_dir,
      model_run_id: "model_cancel",
      model_run_store: model_store,
      plan,
      generated: accepted,
      circuit_json: componentCircuit(accepted.source),
      signal: controller.signal,
    }),
  ).rejects.toThrow("cancel before publication")
  expect(await Bun.file(join(workspace.job_dir, "published-model.json")).exists()).toBe(false)
  expect(await pathExists(prepared.accepted_model_dir)).toBe(false)
  expect(await pathExists(prepared.published_component_dir)).toBe(false)
})

test("prepared publication cleanup preserves the generation selected by the pointer", async () => {
  const workspace = await createWorkspace("model-publication-selected-cleanup-")
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_selected_cleanup",
    invocation_id: crypto.randomUUID(),
    generated: generatedModel(1),
  })
  commitModelPublication(workspace.job_dir, prepared.commit.job_id, prepared.commit)

  await discardPreparedModelPublication(prepared)

  expect(await pathExists(prepared.accepted_model_dir)).toBe(true)
  expect(await pathExists(prepared.published_component_dir)).toBe(true)
})

test("the commit barrier rejects a hash-consistent bundle with truncated passing series", async () => {
  const workspace = await createWorkspace("model-publication-truncated-series-")
  const job_store = new JobStore()
  const model_store = new ModelRunStore()
  const invocation_id = crypto.randomUUID()
  job_store.createJob({
    job_id: "job_truncated_series",
    job_dir: workspace.job_dir,
    file_name: "part.pdf",
  })
  model_store.createModelRun({
    model_run_id: "model_truncated_series",
    job_id: "job_truncated_series",
    model_dir: workspace.model_dir,
    effort_multiplier: 1,
  })
  model_store.updateModelRun("model_truncated_series", { current_invocation_id: invocation_id })
  const accepted = generatedModel(1)
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_truncated_series",
    invocation_id,
    generated: accepted,
  })
  const forged = passingResult(accepted)
  forged.cases[0]!.series = []
  await Bun.write(join(prepared.accepted_model_dir, "validation-results.json"), JSON.stringify(forged))
  prepared.commit.accepted_bundle_manifest_sha256 = await writePublicationBundleManifest(
    prepared.accepted_model_dir,
  )

  await expect(
    commitPreparedModelPublication({
      prepared,
      job_id: "job_truncated_series",
      job_dir: workspace.job_dir,
      job_store,
      model_dir: workspace.model_dir,
      model_run_id: "model_truncated_series",
      model_run_store: model_store,
      plan,
      generated: accepted,
      circuit_json: componentCircuit(accepted.source),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/series does not cover every current validation-plan observation/)

  expect(await Bun.file(join(workspace.job_dir, "published-model.json")).exists()).toBe(false)
  expect(model_store.getModelRun("model_truncated_series")?.model_source).toBeUndefined()
})

test("a stale prepared publication cannot replace the current invocation", async () => {
  const workspace = await createWorkspace("model-publication-stale-")
  const job_store = new JobStore()
  const model_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_stale", job_dir: workspace.job_dir, file_name: "part.pdf" })
  model_store.createModelRun({
    model_run_id: "model_stale",
    job_id: "job_stale",
    model_dir: workspace.model_dir,
    effort_multiplier: 1,
  })
  const prepared_invocation_id = crypto.randomUUID()
  const accepted = generatedModel(1)
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_stale",
    invocation_id: prepared_invocation_id,
    generated: accepted,
  })
  model_store.updateModelRun("model_stale", { current_invocation_id: crypto.randomUUID() })

  await expect(
    commitPreparedModelPublication({
      prepared,
      job_id: "job_stale",
      job_dir: workspace.job_dir,
      job_store,
      model_dir: workspace.model_dir,
      model_run_id: "model_stale",
      model_run_store: model_store,
      plan,
      generated: accepted,
      circuit_json: componentCircuit(accepted.source),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/invocation_id is no longer current/)
  expect(await Bun.file(join(workspace.job_dir, "published-model.json")).exists()).toBe(false)
  expect(await pathExists(prepared.accepted_model_dir)).toBe(false)
  expect(await pathExists(prepared.published_component_dir)).toBe(false)
})

test("live publication state must match the validated immutable bundle", async () => {
  const workspace = await createWorkspace("model-publication-caller-state-")
  const job_store = new JobStore()
  const model_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_caller_state", job_dir: workspace.job_dir, file_name: "part.pdf" })
  model_store.createModelRun({
    model_run_id: "model_caller_state",
    job_id: "job_caller_state",
    model_dir: workspace.model_dir,
    effort_multiplier: 1,
  })
  const invocation_id = crypto.randomUUID()
  model_store.updateModelRun("model_caller_state", { current_invocation_id: invocation_id })
  const accepted = generatedModel(1)
  const prepared = await createPreparedPublication({
    ...workspace,
    model_run_id: "model_caller_state",
    invocation_id,
    generated: accepted,
  })

  await expect(
    commitPreparedModelPublication({
      prepared,
      job_id: "job_caller_state",
      job_dir: workspace.job_dir,
      job_store,
      model_dir: workspace.model_dir,
      model_run_id: "model_caller_state",
      model_run_store: model_store,
      plan,
      generated: generatedModel(0.5),
      circuit_json: componentCircuit(accepted.source),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow(/caller state differs.*generated model/)
  expect(await Bun.file(join(workspace.job_dir, "published-model.json")).exists()).toBe(false)
  expect(model_store.getModelRun("model_caller_state")?.model_source).toBeUndefined()
  expect(await pathExists(prepared.accepted_model_dir)).toBe(false)
  expect(await pathExists(prepared.published_component_dir)).toBe(false)
})
