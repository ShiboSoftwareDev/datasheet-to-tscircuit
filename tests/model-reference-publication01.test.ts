import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "bun:test"
import type { AnyCircuitElement } from "circuit-json"
import { BunProcessRunner } from "@/server/infrastructure/process"
import { createModelManifest, type GeneratedModel, type ModelContract } from "@/server/modeling"
import {
  applyReferenceGraphSourceEligibility,
  buildReferenceGraphSourceProof,
} from "@/server/model-workflow/reference-graph-axis-proof"
import {
  parseReferenceGraphObservation,
  verifyCharacterizationGraphEvidence,
  verifyReferenceGraphTracePixels,
} from "@/server/model-workflow/reference-graph-observation"
import { prepareModelPublication } from "@/server/model-workflow/stage-helpers"
import { parseTimeGraphDiscovery } from "@/server/model-workflow/time-graph-hints"
import {
  hashValidationInputs,
  parseValidationPlan,
  type ValidationPlan,
  type ValidationRunResult,
} from "@/server/spice-validation"

const temporary_directories: string[] = []
const pdftoppm_path = Bun.which("pdftoppm")
const source_proof_tools_available = [pdftoppm_path, Bun.which("pdftotext"), Bun.which("tesseract")].every(
  Boolean,
)
const testWithPdfRenderer = source_proof_tools_available ? test : test.skip

afterEach(async () => {
  await Promise.all(temporary_directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function referenceGraphPdf(extra_mark = false): Uint8Array {
  const x_grid = Array.from({ length: 9 }, (_, index) => 20 + index * 15)
  const y_grid = Array.from({ length: 6 }, (_, index) => 20 + index * 20)
  const trace_pixels = reference_points.map(({ x, y }) => ({
    x: 35 + (x / 0.0007) * 105,
    y: 60 - (y - 1) * 200,
  }))
  const trace_command = trace_pixels
    .map(
      ({ x, y }, index) =>
        `${(x * 0.36).toFixed(4)} ${(57.6 - y * 0.36).toFixed(4)} ${index === 0 ? "m" : "l"}`,
    )
    .join(" ")
  const graph_commands = [
    "0.72 G",
    "0.25 w",
    ...x_grid.map((x) => `${(x * 0.36).toFixed(4)} 21.6 m ${(x * 0.36).toFixed(4)} 50.4 l S`),
    ...y_grid.map((y) => `7.2 ${(57.6 - y * 0.36).toFixed(4)} m 45 ${(57.6 - y * 0.36).toFixed(4)} l S`),
    "0 0 0 RG",
    "0.5 w",
    "7.2 14.4 m 50.4 14.4 l S",
    "7.2 14.4 m 7.2 50.4 l S",
    "0.078431 0.313725 0.705882 RG",
    "0.72 w",
    `${trace_command} S`,
    "0 0 0 rg",
    "BT /F1 4 Tf 55 48 Td (Horizontal) Tj ET",
    "BT /F1 4 Tf 55 43 Td (100 us/div) Tj ET",
    "BT /F1 4 Tf 55 28 Td (Ch1) Tj ET",
    "BT /F1 4 Tf 55 23 Td (100 mV/div) Tj ET",
    "BT /F1 4 Tf 28 10 Td (V O = 1 V) Tj ET",
    "BT /F1 4 Tf 31 4 Td (Figure 1.) Tj ET",
    ...(extra_mark ? ["1 0 0 rg", "20 10 1 1 re f"] : []),
  ].join("\n")
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 86.4 57.6] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(graph_commands)} >>\nstream\n${graph_commands}\nendstream`,
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

const electrical_binding = {
  response: {
    type: "voltage" as const,
    positive: "dut.OUT" as const,
    negative: "gnd" as const,
    nominal_volts: 1,
  },
  stimulus: {
    type: "voltage_step" as const,
    positive: "dut.IN" as const,
    negative: "gnd" as const,
    pulse: {
      low: 0,
      high: 1,
      delay: 0,
      rise: 0.0007,
      fall: 0.0001,
      width: 0.001,
      period: 0.002,
    },
  },
}

const reference_points = Array.from({ length: 20 }, (_, index) => {
  const ratio = index / 19
  return { x: ratio * 0.0007, y: 1 + Math.sin(ratio * Math.PI * 2) * 0.05 }
})

const viewer_points = Array.from({ length: 8 }, (_, index) => {
  const x = index * 0.0001
  return { x, y: 1 + Math.sin((x / 0.0007) * Math.PI * 2) * 0.05 }
})

const contract: ModelContract = {
  version: 1,
  interface: {
    version: 1,
    part_number: "REFERENCE-PUBLICATION",
    entry_name: "REFERENCE_PUBLICATION",
    pins: [
      {
        physical_pin: "1",
        component_pin: "pin1",
        source_port_id: "source_port_in",
        spice_node: "IN",
        labels: ["IN"],
        role: "input",
      },
      {
        physical_pin: "2",
        component_pin: "pin2",
        source_port_id: "source_port_out",
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
        requirement_id: "waveform",
        title: "Output waveform",
        behavior: "Output voltage follows the printed elapsed-time response.",
        analysis: "transient",
        support: { status: "modeled" },
        conditions: {},
        expected: { unit: "V", min: 0, max: 1 },
        reference_curve: {
          x_quantity: "time",
          x_unit: "s",
          y_quantity: "voltage",
          y_unit: "V",
          points: reference_points,
          crop: { page: 1, render_dpi: 200, x_px: 0, y_px: 0, width_px: 240, height_px: 160 },
          electrical_binding,
        },
        sources: [{ page: 1, locator: "Figure 1", statement: "Output voltage versus elapsed time." }],
      },
    ],
    assumptions: [],
    limitations: [],
  },
}

const plan = parseValidationPlan(
  {
    version: 1,
    model: { entry_name: "REFERENCE_PUBLICATION", pins: ["IN", "OUT"] },
    cases: [
      {
        id: "waveform",
        requirement_ids: ["waveform"],
        nets: [],
        fixtures: [
          {
            type: "voltage_source",
            id: "stimulus",
            positive: "dut.IN",
            negative: "gnd",
            dc_volts: 0,
            pulse: {
              low: 0,
              high: 1,
              delay: 0,
              rise: 0.0007,
              fall: 0.0001,
              width: 0.001,
              period: 0.002,
            },
          },
          {
            type: "resistor",
            id: "load",
            positive: "dut.OUT",
            negative: "gnd",
            resistance_ohms: 10_000,
          },
        ],
        analysis: { type: "transient", step: 0.0001, stop: 0.0007 },
        observations: [
          {
            type: "voltage",
            id: "output",
            requirement_id: "waveform",
            positive: "dut.OUT",
            negative: "gnd",
            unit: "V",
            scale: "linear",
            reference: { type: "curve", points: reference_points, tolerance: 0.05 },
          },
        ],
      },
    ],
  } satisfies ValidationPlan,
  {
    model_interface: contract.interface,
    model_requirements: contract.characterization.requirements,
    model_family: contract.characterization.family,
  },
)

const model_source = `.SUBCKT REFERENCE_PUBLICATION IN OUT
EOUT OUT 0 IN 0 1
.ENDS REFERENCE_PUBLICATION
`

function generatedModel(): GeneratedModel {
  return {
    source: model_source,
    card: "# Reference publication fixture\n",
    manifest: createModelManifest({
      model_interface: contract.interface,
      model_source,
      simulator: "ngspice",
    }),
  }
}

function viewerCircuit(generated: GeneratedModel): AnyCircuitElement[] {
  return [
    {
      type: "source_component",
      source_component_id: "dut",
      name: "DUT",
      manufacturer_part_number: generated.manifest.part_number,
    },
    {
      type: "source_port",
      source_port_id: "dut_in",
      source_component_id: "dut",
      name: "IN",
      port_hints: ["IN", "pin1"],
    },
    {
      type: "source_port",
      source_port_id: "dut_out",
      source_component_id: "dut",
      name: "OUT",
      port_hints: ["OUT", "pin2"],
    },
    {
      type: "simulation_spice_subcircuit",
      simulation_spice_subcircuit_id: "dut_model",
      source_component_id: "dut",
      spice_pin_to_source_port_map: { IN: "dut_in", OUT: "dut_out" },
      subcircuit_source: generated.source,
    },
    {
      type: "source_component",
      source_component_id: "stimulus",
      name: "stimulus",
      ftype: "simple_chip",
    },
    {
      type: "source_port",
      source_port_id: "stimulus_pos",
      source_component_id: "stimulus",
      name: "POS",
      port_hints: ["POS", "pin1"],
    },
    {
      type: "source_port",
      source_port_id: "stimulus_neg",
      source_component_id: "stimulus",
      name: "NEG",
      port_hints: ["NEG", "pin2"],
    },
    {
      type: "source_net",
      source_net_id: "ground",
      name: "GND",
      member_source_group_ids: [],
      is_ground: true,
    },
    {
      type: "source_trace",
      source_trace_id: "stimulus_positive",
      connected_source_port_ids: ["stimulus_pos", "dut_in"],
      connected_source_net_ids: [],
    },
    {
      type: "source_trace",
      source_trace_id: "stimulus_negative",
      connected_source_port_ids: ["stimulus_neg"],
      connected_source_net_ids: ["ground"],
    },
    {
      type: "simulation_spice_subcircuit",
      simulation_spice_subcircuit_id: "stimulus_model",
      source_component_id: "stimulus",
      spice_pin_to_source_port_map: { POS: "stimulus_pos", NEG: "stimulus_neg" },
      subcircuit_source:
        ".SUBCKT VALIDATION_STIMULUS POS NEG\n" +
        "VDRIVE POS NEG DC 0 PULSE(0 1 0 0.0007 0.0001 0.001 0.002)\n" +
        ".ENDS VALIDATION_STIMULUS\n",
    },
    {
      type: "source_component",
      source_component_id: "load",
      name: "load",
      ftype: "simple_resistor",
      resistance: 10_000,
    },
    {
      type: "source_port",
      source_port_id: "load_pin1",
      source_component_id: "load",
      name: "pin1",
      port_hints: ["pin1", "1"],
    },
    {
      type: "source_port",
      source_port_id: "load_pin2",
      source_component_id: "load",
      name: "pin2",
      port_hints: ["pin2", "2"],
    },
    {
      type: "source_trace",
      source_trace_id: "load_positive",
      connected_source_port_ids: ["load_pin1", "dut_out"],
      connected_source_net_ids: [],
    },
    {
      type: "source_trace",
      source_trace_id: "load_negative",
      connected_source_port_ids: ["load_pin2"],
      connected_source_net_ids: ["ground"],
    },
    {
      type: "simulation_experiment",
      simulation_experiment_id: "experiment",
      name: "validation",
      experiment_type: "spice_transient_analysis",
      time_per_step: 0.1,
      start_time_ms: 0,
      end_time_ms: 0.7,
    },
    {
      type: "simulation_voltage_probe",
      simulation_voltage_probe_id: "output_probe",
      name: "probe_output",
      signal_input_source_port_id: "dut_out",
    },
    {
      type: "simulation_transient_voltage_graph",
      simulation_transient_voltage_graph_id: "output_graph",
      simulation_experiment_id: "experiment",
      source_probe_id: "output_probe",
      name: "probe_output",
      timestamps_ms: viewer_points.map(({ x }) => x * 1_000),
      voltage_levels: viewer_points.map(({ y }) => y),
      time_per_step: 0.1,
      start_time_ms: 0,
      end_time_ms: 0.7,
    },
  ] as unknown as AnyCircuitElement[]
}

function passingResult(generated: GeneratedModel): ValidationRunResult {
  const hashes = hashValidationInputs({ plan, model_source: generated.source, manifest: generated.manifest })
  return {
    version: 1,
    passed: true,
    hashes,
    cases: [
      {
        case_id: "waveform",
        status: "passed",
        analysis: "transient",
        series: [
          {
            observation_id: "output",
            type: "voltage",
            unit: "V",
            scale: "linear",
            points: reference_points,
            passed: true,
            metrics: { sample_count: reference_points.length, normalized_max_error: 0 },
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
      hashes,
      checked_case_count: 1,
      checked_observation_count: 1,
    },
  }
}

async function createWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "model-reference-publication-"))
  temporary_directories.push(root)
  const job_dir = join(root, "job")
  const model_dir = join(job_dir, "spice")
  const evidence_dir = join(model_dir, "attempt", "evidence")
  await mkdir(join(evidence_dir, "figures"), { recursive: true })
  const datasheet = referenceGraphPdf()
  await Promise.all([
    Bun.write(join(job_dir, "component.circuit.tsx"), "export default () => null\n"),
    Bun.write(join(model_dir, "datasheet.pdf"), datasheet),
  ])
  return { job_dir, model_dir, evidence_dir, datasheet }
}

async function prepare(input: Awaited<ReturnType<typeof createWorkspace>>) {
  const generated = generatedModel()
  const circuit_json_by_case = { waveform: viewerCircuit(generated) }
  return prepareModelPublication({
    job_id: "job_reference_publication",
    job_dir: input.job_dir,
    model_dir: input.model_dir,
    model_run_id: "model_reference_publication",
    invocation_id: crypto.randomUUID(),
    contract,
    plan,
    result: passingResult(generated),
    generated,
    evidence_dir: input.evidence_dir,
    wrapper_source: "export default () => null\n",
    circuit_json: [],
    circuit_json_by_case,
  })
}

async function renderFixturePdf(input: {
  pdf_path: string
  output_prefix: string
  cwd: string
}): Promise<void> {
  await new BunProcessRunner().run({
    command: [
      pdftoppm_path!,
      "-f",
      "1",
      "-l",
      "1",
      "-r",
      "200",
      "-x",
      "0",
      "-y",
      "0",
      "-W",
      "240",
      "-H",
      "160",
      "-png",
      "-singlefile",
      input.pdf_path,
      input.output_prefix,
    ],
    command_label: "Render valid reference-publication fixture",
    cwd: input.cwd,
    signal: new AbortController().signal,
    wall_timeout_ms: 30_000,
  })
}

async function writeReferenceProof(
  input: Awaited<ReturnType<typeof createWorkspace>>,
  options: { tamper_receipt?: boolean } = {},
): Promise<void> {
  const source_pdf_sha256 = createHash("sha256").update(input.datasheet).digest("hex")
  const discovery_value = {
    version: 1,
    source_pdf_sha256,
    page_count: 1,
    hints: [
      {
        hint_id: "time_graph_001",
        page: 1,
        figure: "Figure 1",
        reason: "Figure 1 contains a voltage waveform with an elapsed-time axis.",
        operating_condition_evidence:
          "Figure 1. VOUT = 1 V. IN from 0 V to 1 V, tr = 700 us, tf = 100 us. Output voltage response.",
        fixture_evidence_context:
          "Figure 1. VOUT = 1 V. IN from 0 V to 1 V, tr = 700 us, tf = 100 us. Output voltage response.",
        summary_fixture_evidence_context: null,
        condition_conflicts: [],
        unsupported_fixture_conditions: [],
        transient_fixture_evidence: {
          method: "printed_experiment_conditions_v2",
          source_excerpts: [
            {
              scope: "graph_caption",
              text: "Figure 1. VOUT = 1 V. IN from 0 V to 1 V, tr = 700 us, tf = 100 us. Output voltage response.",
            },
          ],
          response: { signal: "VO", quantity: "voltage", nominal_volts: 1 },
          stimulus: {
            signal: "IN",
            type: "voltage_step",
            low: 0,
            high: 1,
            rise: 0.0007,
            fall: 0.0001,
          },
          auxiliary_conditions: [],
        },
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
        graph_id: "waveform_graph",
        reason: "The printed horizontal axis is elapsed time.",
      },
    ],
    graphs: [
      {
        graph_id: "waveform_graph",
        page: 1,
        locator: "Figure 1",
        x_axis: "time",
        time_axis_evidence: "Time (100 us/div)",
        response_quantity: "voltage",
        public_pin_observable: true,
        fixture_reproducible: true,
        reason: "The public OUT pin is plotted against elapsed time for a public IN voltage step.",
        crop: { page: 1, render_dpi: 200, x_px: 0, y_px: 0, width_px: 240, height_px: 160 },
        electrical_binding,
        digitized_curve: {
          method: "manual_pixel_trace",
          x_quantity: "time",
          x_unit: "s",
          y_quantity: "voltage",
          y_unit: "V",
          x_range: { min: 0, max: 0.0007 },
          y_range: { min: 0.8, max: 1.2 },
          x_axis: {
            scale: "linear",
            first: { pixel: 35, value: 0 },
            second: { pixel: 140, value: 0.0007 },
          },
          y_axis: {
            scale: "linear",
            first: { pixel: 100, value: 0.8 },
            second: { pixel: 20, value: 1.2 },
          },
          trace_color: { r: 20, g: 80, b: 180, tolerance: 24 },
          points: Array.from({ length: 20 }, (_, index) => {
            const ratio = index / 19
            return {
              pixel_x: 35 + ratio * 105,
              pixel_y: 60 - Math.sin(ratio * Math.PI * 2) * 10,
            }
          }),
        },
      },
    ],
  }
  await renderFixturePdf({
    pdf_path: join(input.model_dir, "datasheet.pdf"),
    output_prefix: join(input.evidence_dir, "figures", "waveform"),
    cwd: input.model_dir,
  })
  await Promise.all([
    Bun.write(
      join(input.model_dir, "attempt", "time-graph-hints.json"),
      `${JSON.stringify(discovery_value)}\n`,
    ),
    Bun.write(
      join(input.model_dir, "attempt", "model-reference-observation.json"),
      `${JSON.stringify(observation_value)}\n`,
    ),
  ])
  const discovery = parseTimeGraphDiscovery(discovery_value, source_pdf_sha256)
  const observation = parseReferenceGraphObservation(observation_value, discovery, contract.interface)
  const source_proof = await buildReferenceGraphSourceProof({
    observation,
    datasheet_path: join(input.model_dir, "datasheet.pdf"),
    process_runner: new BunProcessRunner(),
    signal: new AbortController().signal,
  })
  if (source_proof.results[0]?.status !== "verified") {
    throw new Error(`Fixture source proof failed: ${JSON.stringify(source_proof.results[0])}`)
  }
  const source_observation = applyReferenceGraphSourceEligibility({ observation, proof: source_proof })
  await Bun.write(
    join(input.model_dir, "attempt", "model-reference-observation.json"),
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
  if (options.tamper_receipt) verification.matches[0]!.pixel_trace.verified_point_count = 0
  await Bun.write(
    join(input.model_dir, "attempt", "model-reference-source-proof.json"),
    `${JSON.stringify(source_proof)}\n`,
  )
  await Bun.write(
    join(input.model_dir, "attempt", "model-reference-verification.json"),
    `${JSON.stringify(verification)}\n`,
  )
}

test("fresh waveform publication rejects missing independent reference proof", async () => {
  const workspace = await createWorkspace()

  await expect(prepare(workspace)).rejects.toThrow(
    /Fresh waveform publication requires retained .* beside evidence/,
  )
})

testWithPdfRenderer(
  "fresh waveform publication accepts proof rendered from a valid canonical PDF",
  async () => {
    const workspace = await createWorkspace()
    await writeReferenceProof(workspace)

    const publication = await prepare(workspace)

    expect(
      await Bun.file(join(publication.accepted_model_dir, "model-reference-verification.json")).exists(),
    ).toBe(true)
    expect(
      await Bun.file(join(publication.accepted_model_dir, "validation/viewer-validation.json")).exists(),
    ).toBe(true)
  },
)

testWithPdfRenderer(
  "fresh waveform publication recomputes and rejects a tampered reference receipt",
  async () => {
    const workspace = await createWorkspace()
    await writeReferenceProof(workspace, { tamper_receipt: true })

    await expect(prepare(workspace)).rejects.toThrow(
      /model-reference-verification\.json is stale or tampered/,
    )
  },
)

testWithPdfRenderer(
  "fresh waveform publication rejects a retained crop from another PDF render",
  async () => {
    const workspace = await createWorkspace()
    await writeReferenceProof(workspace)
    const alternate_pdf = join(workspace.model_dir, "alternate.pdf")
    await Bun.write(alternate_pdf, referenceGraphPdf(true))
    await renderFixturePdf({
      pdf_path: alternate_pdf,
      output_prefix: join(workspace.evidence_dir, "figures", "waveform"),
      cwd: workspace.model_dir,
    })

    await expect(prepare(workspace)).rejects.toThrow(
      /not the exact server render of canonical datasheet\.pdf/,
    )
  },
)

testWithPdfRenderer(
  "fresh waveform publication rejects a canonical PDF changed after observation",
  async () => {
    const workspace = await createWorkspace()
    await writeReferenceProof(workspace)
    await Bun.write(join(workspace.model_dir, "datasheet.pdf"), referenceGraphPdf(true))

    await expect(prepare(workspace)).rejects.toThrow(
      /source_pdf_sha256 must match the canonical datasheet PDF/,
    )
  },
)
