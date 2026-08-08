import { expect, test } from "bun:test"
import type { AnyCircuitElement } from "circuit-json"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunProcessRunner } from "@/server/infrastructure/process"
import { TSCIRCUIT_RUNTIME_CONFIG } from "@/server/job-scaffold/tscircuit-runtime-config"
import { buildValidationCircuitPreviews } from "@/server/model-workflow/validation-circuit-previews"
import {
  createModelManifest,
  getAnalogProjectionIssue,
  projectModelCircuitPreview,
  renderValidationCaseTsx,
  validateViewerSimulation,
  type GeneratedModel,
  type ModelContract,
  type ModelInterface,
  type ModelRequirement,
} from "@/server/modeling"
import {
  parseAgentValidationPlan,
  runSpiceValidation,
  type ValidationAnalysis,
  type ValidationCase,
} from "@/server/spice-validation"
import { hasCompletedTransientSimulation } from "@/shared/model-preview-capabilities"

const tsci_path = Bun.which("tsci")
const ngspice_path = Bun.which("ngspice")
const testWithProductionSimulation = tsci_path && ngspice_path ? test : test.skip

const model_interface: ModelInterface = {
  version: 1,
  part_number: "CAUSAL-GAIN",
  entry_name: "CAUSAL_GAIN",
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
}

const model_source = `.SUBCKT CAUSAL_GAIN IN OUT
E_RESPONSE OUT 0 IN 0 0.5
.ENDS CAUSAL_GAIN
`

const pulse = {
  low: 0,
  high: 2,
  delay: 0.001,
  rise: 0.0002,
  fall: 0.0002,
  width: 0.001,
  period: 0.004,
}

const reference_points = [
  { x: 0, y: 0 },
  { x: 0.0005, y: 0 },
  { x: 0.001, y: 0 },
  { x: 0.0011, y: 0.5 },
  { x: 0.0012, y: 1 },
  { x: 0.0017, y: 1 },
  { x: 0.0022, y: 1 },
  { x: 0.0023, y: 0.5 },
  { x: 0.0024, y: 0 },
  { x: 0.003, y: 0 },
]

const requirement: ModelRequirement = {
  requirement_id: "pulse_gain",
  title: "Pulse gain",
  behavior: "OUT follows one half of the voltage step applied to IN",
  analysis: "transient",
  support: { status: "modeled" },
  conditions: { input_pulse_volts: 2 },
  expected: { unit: "V", min: 0, max: 1 },
  reference_curve: {
    channel_id: "output_voltage",
    channel_label: "OUT",
    channel_role: "response",
    measurement: { type: "voltage", positive: "dut.OUT", negative: "gnd" },
    x_quantity: "time",
    x_unit: "s",
    y_quantity: "voltage",
    y_unit: "V",
    tolerance: 0.05,
    points: reference_points,
    crop: {
      page: 7,
      render_dpi: 200,
      x_px: 120,
      y_px: 160,
      width_px: 640,
      height_px: 360,
    },
    image: "evidence/figure-pulse-gain.png",
    electrical_binding: {
      response: { type: "voltage", positive: "dut.OUT", negative: "gnd" },
      stimulus: {
        type: "voltage_step",
        positive: "dut.IN",
        negative: "gnd",
        pulse,
      },
    },
  },
  sources: [
    {
      page: 7,
      locator: "Figure 7-1",
      statement: "Output voltage response to the input pulse",
      image: "evidence/figure-pulse-gain.png",
    },
  ],
}

const contract: ModelContract = {
  version: 1,
  interface: model_interface,
  characterization: {
    version: 1,
    family: "other",
    strategy: "behavioral",
    requirements: [requirement],
    assumptions: [],
    limitations: [],
  },
}

const generated: GeneratedModel = {
  source: model_source,
  card: "# Causal gain model\n\nOUT is controlled only by the instantaneous voltage at IN.\n",
  manifest: createModelManifest({
    model_interface,
    model_source,
    simulator: "ngspice",
  }),
}

function agentPlanProposal(): unknown {
  return {
    version: 1,
    model: { entry_name: "CAUSAL_GAIN", pins: ["IN", "OUT"] },
    cases: [
      {
        id: "pulse-gain",
        title: "Pulse gain",
        requirement_ids: ["pulse_gain"],
        nets: [],
        fixtures: [
          {
            id: "input_step",
            type: "voltage_source",
            positive: "dut.IN",
            negative: "gnd",
            dc_volts: pulse.low,
            pulse: structuredClone(pulse),
          },
          {
            id: "output_load",
            type: "resistor",
            positive: "dut.OUT",
            negative: "gnd",
            resistance_ohms: 10_000,
          },
        ],
        analysis: {
          type: "transient",
          step: 0.000050000000123,
          stop: 0.0030004681647940075,
        },
        observations: [
          {
            id: "out_response",
            requirement_id: "pulse_gain",
            type: "voltage",
            positive: "dut.OUT",
            negative: "gnd",
            unit: "V",
            scale: "linear",
          },
        ],
      },
    ],
  }
}

function parseProductionPlan() {
  return parseAgentValidationPlan(agentPlanProposal(), {
    model_interface,
    model_source,
    model_requirements: contract.characterization.requirements,
    model_family: contract.characterization.family,
  })
}

testWithProductionSimulation(
  "a bound causal transient passes real server ngspice and the installed tscircuit viewer",
  async () => {
    const model_dir = await mkdtemp(join(tmpdir(), "model-real-transient-boundary-"))
    try {
      await Promise.all([
        Bun.write(join(model_dir, "tscircuit.config.ts"), TSCIRCUIT_RUNTIME_CONFIG),
        Bun.write(join(model_dir, "tscircuit.config.json"), "{}\n"),
      ])

      const plan = parseProductionPlan()
      const validation_case = plan.cases[0]!
      expect(model_interface.pins).toHaveLength(2)
      expect(validation_case.analysis.type).toBe("transient")
      expect(validation_case.fixtures[0]).toMatchObject({
        type: "voltage_source",
        positive: "dut.IN",
        negative: "gnd",
        dc_volts: pulse.low,
        pulse,
      })
      expect(validation_case.observations[0]).toMatchObject({
        type: "voltage",
        positive: "dut.OUT",
        negative: "gnd",
        reference: { type: "curve", points: reference_points },
        evidence: { page: 7, image: "evidence/figure-pulse-gain.png" },
      })

      const reassigned_response = agentPlanProposal() as {
        cases: Array<{ observations: Array<{ positive: string }> }>
      }
      reassigned_response.cases[0]!.observations[0]!.positive = "dut.IN"
      expect(() =>
        parseAgentValidationPlan(reassigned_response, {
          model_interface,
          model_source,
          model_requirements: [requirement],
        }),
      ).toThrow(/requirement_response_endpoint_mismatch/)

      const reassigned_stimulus = agentPlanProposal() as {
        cases: Array<{ fixtures: Array<{ pulse: { high: number } }> }>
      }
      reassigned_stimulus.cases[0]!.fixtures[0]!.pulse.high = 1
      expect(() =>
        parseAgentValidationPlan(reassigned_stimulus, {
          model_interface,
          model_source,
          model_requirements: [requirement],
        }),
      ).toThrow(/requirement_stimulus_pulse_mismatch/)

      const server_result = await runSpiceValidation({
        plan,
        manifest: generated.manifest,
        model_source,
        model_dir,
        model_contract: contract,
        ngspice_path: ngspice_path ?? undefined,
      })
      expect(server_result.passed).toBe(true)
      expect(server_result.cases).toHaveLength(1)
      expect(server_result.cases[0]).toMatchObject({ status: "passed", analysis: "transient" })
      expect(server_result.cases[0]!.series[0]).toMatchObject({
        observation_id: "out_response",
        type: "voltage",
        passed: true,
      })
      const server_levels = server_result.cases[0]!.series[0]!.points.map(({ y }) => y)
      expect(Math.max(...server_levels) - Math.min(...server_levels)).toBeGreaterThan(0.9)

      const source = renderValidationCaseTsx({
        validation_case,
        manifest: generated.manifest,
        model_source,
        model_card: generated.card,
      })
      expect(source).toContain("<analogsimulation")
      expect(source).toContain('name="probe_out_response"')

      const preview_build = await buildValidationCircuitPreviews({
        model_dir,
        plan,
        generated,
        tsci_bin: tsci_path ?? "tsci",
        process_runner: new BunProcessRunner(),
        signal: new AbortController().signal,
        append: () => undefined,
      })
      expect(preview_build.circuit_build_errors_by_case[validation_case.id]).toBeUndefined()
      expect(preview_build.errors_by_case[validation_case.id]).toBeUndefined()
      expect(preview_build.viewer_validation_by_case[validation_case.id]).toMatchObject({
        simulation_valid: true,
        passed: true,
      })

      const circuit_json = preview_build.circuit_json_by_case[validation_case.id]
      expect(circuit_json).toBeDefined()
      if (!circuit_json) throw new Error("Installed tsci produced no Circuit JSON")
      expect(hasCompletedTransientSimulation(circuit_json)).toBe(true)

      const records = circuit_json as Array<AnyCircuitElement & Record<string, unknown>>
      const experiments = records.filter(
        (record) =>
          record.type === "simulation_experiment" && record.experiment_type === "spice_transient_analysis",
      )
      const probes = records.filter(
        (record) => record.type === "simulation_voltage_probe" && record.name === "probe_out_response",
      )
      const graphs = records.filter((record) => record.type === "simulation_transient_voltage_graph")
      expect(experiments).toHaveLength(1)
      expect(probes).toHaveLength(1)
      expect(graphs).toHaveLength(1)

      const dut = records.find((record) => record.type === "source_component" && record.name === "DUT")
      const out_port = records.find(
        (record) =>
          record.type === "source_port" &&
          record.source_component_id === dut?.source_component_id &&
          Array.isArray(record.port_hints) &&
          record.port_hints.includes("OUT"),
      )
      expect(out_port?.source_port_id).toBeString()
      expect(probes[0]!.signal_input_source_port_id).toBe(out_port!.source_port_id)
      expect(graphs[0]!.source_probe_id).toBe(probes[0]!.simulation_voltage_probe_id)
      const experiment_id = experiments[0]!.simulation_experiment_id
      expect(experiment_id).toBeString()
      expect(graphs[0]!.simulation_experiment_id).toBe(experiment_id as string)
      expect(graphs[0]!.timestamps_ms).toBeArray()
      expect(graphs[0]!.voltage_levels).toBeArray()
      expect((graphs[0]!.timestamps_ms as number[]).length).toBeGreaterThan(2)
      expect((graphs[0]!.voltage_levels as number[]).length).toBe(
        (graphs[0]!.timestamps_ms as number[]).length,
      )
    } finally {
      await rm(model_dir, { recursive: true, force: true })
    }
  },
  45_000,
)

function staticCase(type: "operating_point" | "dc_sweep"): ValidationCase {
  const analysis: ValidationAnalysis =
    type === "operating_point" ? { type } : { type, source_id: "input_dc", start: 0, stop: 2, step: 0.5 }
  return {
    id: `static-${type}`,
    requirement_ids: [`static_${type}`],
    nets: [],
    fixtures: [
      {
        id: "input_dc",
        type: "voltage_source",
        positive: "dut.IN",
        negative: "gnd",
        dc_volts: 1,
      },
    ],
    analysis,
    observations: [
      {
        id: "out_response",
        requirement_id: `static_${type}`,
        type: "voltage",
        positive: "dut.OUT",
        negative: "gnd",
        unit: "V",
        scale: "linear",
        reference:
          type === "operating_point"
            ? { type: "target", target: 0.5, tolerance: 0.01 }
            : {
                type: "curve",
                tolerance: 0.01,
                points: [
                  { x: 0, y: 0 },
                  { x: 2, y: 1 },
                ],
              },
      },
    ],
  }
}

function forgedCompletedTransient(): AnyCircuitElement[] {
  return [
    {
      type: "source_component",
      source_component_id: "dut_1",
      name: "DUT",
    },
    {
      type: "source_port",
      source_port_id: "dut_out",
      source_component_id: "dut_1",
      name: "OUT",
      port_hints: ["OUT", "pin2"],
    },
    {
      type: "simulation_experiment",
      simulation_experiment_id: "experiment_1",
      experiment_type: "spice_transient_analysis",
      name: "validation",
    },
    {
      type: "simulation_voltage_probe",
      simulation_voltage_probe_id: "probe_1",
      name: "probe_out_response",
      signal_input_source_port_id: "dut_out",
    },
    {
      type: "simulation_transient_voltage_graph",
      simulation_transient_voltage_graph_id: "graph_1",
      simulation_experiment_id: "experiment_1",
      source_probe_id: "probe_1",
      name: "out_response",
      timestamps_ms: [0, 1],
      voltage_levels: [0, 0.5],
      time_per_step: 1,
      start_time_ms: 0,
      end_time_ms: 1,
    },
  ] as unknown as AnyCircuitElement[]
}

test("OP and DC plans stay source-only even when handed a completed transient-looking graph", () => {
  const forged = forgedCompletedTransient()
  expect(hasCompletedTransientSimulation(forged)).toBe(true)

  for (const analysis_type of ["operating_point", "dc_sweep"] as const) {
    const validation_case = staticCase(analysis_type)
    expect(getAnalogProjectionIssue(validation_case)).toContain(analysis_type)
    expect(
      renderValidationCaseTsx({
        validation_case,
        manifest: generated.manifest,
        model_source,
        model_card: generated.card,
      }),
    ).not.toContain("<analogsimulation")

    const viewer_validation = validateViewerSimulation({ validation_case, circuit_json: forged })
    expect(viewer_validation.simulation_valid).toBe(false)
    expect(viewer_validation.passed).toBe(false)
    expect(viewer_validation.errors.map(({ code }) => code)).toContain("viewer_analysis_not_transient")

    const preview = projectModelCircuitPreview({
      validation_case,
      manifest: generated.manifest,
      model_source,
      model_card: generated.card,
      updated_at: "2026-08-01T00:00:00.000Z",
      circuit_json: forged,
    })
    expect(preview.analog_simulation_status).toBe("unsupported")
    expect(preview.error_message).toContain("source-only")
  }
})
