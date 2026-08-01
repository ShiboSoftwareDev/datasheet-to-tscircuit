import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  attachStimulusCausalityCheck,
  checkCandidateStimulusCausality,
  materiallyDependsOnStimulus,
} from "@/server/model-workflow/candidate-stimulus-causality"
import { createModelRepairFeedback } from "@/server/model-workflow/stage-helpers"
import {
  createModelManifest,
  type ModelContract,
  projectModelValidationSummary,
  validateModelCompletionIntegrity,
} from "@/server/modeling"
import { executeLocalNgspice, runSpiceValidation, type ValidationPlan } from "@/server/spice-validation"

const temporary_directories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

const curve_points = [
  { x: 0, y: 0 },
  { x: 0.0001, y: 0 },
  { x: 0.0002, y: 0 },
  { x: 0.0003, y: 0.63 },
  { x: 0.0004, y: 0.86 },
  { x: 0.0005, y: 0.95 },
  { x: 0.0007, y: 0.99 },
  { x: 0.001, y: 1 },
]

const contract: ModelContract = {
  version: 1,
  interface: {
    version: 1,
    part_number: "CAUSAL-DYNAMIC",
    entry_name: "CAUSAL_DYNAMIC",
    pins: [
      {
        physical_pin: "1",
        component_pin: "pin1",
        source_port_id: "source_port_1",
        spice_node: "IN",
        labels: ["IN"],
        role: "input",
      },
      {
        physical_pin: "2",
        component_pin: "pin2",
        source_port_id: "source_port_2",
        spice_node: "OUT",
        labels: ["OUT"],
        role: "output",
      },
      {
        physical_pin: "3",
        component_pin: "pin3",
        source_port_id: "source_port_3",
        spice_node: "GND",
        labels: ["GND"],
        role: "ground",
      },
    ],
  },
  characterization: {
    version: 1,
    family: "other",
    strategy: "behavioral",
    requirements: [
      {
        requirement_id: "step_response",
        title: "Step response",
        behavior: "Output responds to the public input step",
        analysis: "transient",
        support: { status: "modeled" },
        conditions: {},
        expected: { unit: "V", min: 0, max: 1 },
        reference_curve: {
          x_quantity: "time",
          x_unit: "s",
          y_quantity: "voltage",
          y_unit: "V",
          points: curve_points,
          tolerance: 0.1,
          electrical_binding: {
            response: { type: "voltage", positive: "dut.OUT", negative: "dut.GND" },
            stimulus: {
              type: "voltage_step",
              positive: "dut.IN",
              negative: "dut.GND",
              pulse: {
                low: 0,
                high: 1,
                delay: 0.0002,
                rise: 0.000001,
                fall: 0.000001,
                width: 0.005,
                period: 0.01,
              },
            },
          },
        },
        sources: [{ page: 1, locator: "Figure 1", statement: "Input step response" }],
      },
    ],
    assumptions: [],
    limitations: [],
  },
}

const plan: ValidationPlan = {
  version: 1,
  model: { entry_name: "CAUSAL_DYNAMIC", pins: ["IN", "OUT", "GND"] },
  cases: [
    {
      id: "step_response_case",
      requirement_ids: ["step_response"],
      nets: [],
      fixtures: [
        {
          type: "voltage_source",
          id: "drive",
          positive: "dut.IN",
          negative: "dut.GND",
          dc_volts: 0,
          pulse: {
            low: 0,
            high: 1,
            delay: 0.0002,
            rise: 0.000001,
            fall: 0.000001,
            width: 0.005,
            period: 0.01,
          },
        },
        {
          type: "resistor",
          id: "ground_link",
          positive: "dut.GND",
          negative: "gnd",
          resistance_ohms: 0.001,
        },
        {
          type: "resistor",
          id: "load",
          positive: "dut.OUT",
          negative: "dut.GND",
          resistance_ohms: 1_000_000,
        },
      ],
      analysis: { type: "transient", step: 0.00001, stop: 0.001 },
      observations: [
        {
          id: "output_voltage",
          requirement_id: "step_response",
          type: "voltage",
          positive: "dut.OUT",
          negative: "dut.GND",
          unit: "V",
          scale: "linear",
          reference: { type: "curve", tolerance: 0.1, points: curve_points },
        },
      ],
    },
  ],
}

async function runCheck(model_source: string) {
  const model_dir = await mkdtemp(join(tmpdir(), "candidate-causality-test-"))
  temporary_directories.push(model_dir)
  const manifest = createModelManifest({
    model_interface: contract.interface,
    model_source,
    simulator: "ngspice",
  })
  const baseline_result = await runSpiceValidation({
    plan,
    manifest,
    model_source,
    model_dir,
    artifact_directory: join(model_dir, "baseline"),
    model_contract: contract,
    ngspice: executeLocalNgspice,
    ngspice_path: Bun.which("ngspice") ?? "ngspice",
  })
  const check = await checkCandidateStimulusCausality({
    plan,
    contract,
    manifest,
    model_source,
    baseline_result,
    model_dir,
    ngspice: executeLocalNgspice,
    ngspice_path: Bun.which("ngspice") ?? "ngspice",
  })
  return { baseline_result, check, manifest }
}

const ngspice_path = Bun.which("ngspice")
const testWithNgspice = ngspice_path ? test : test.skip

describe("private bound-stimulus causality check", () => {
  testWithNgspice("accepts causal C state driven by the bound public input step", async () => {
    const model_source = `.SUBCKT CAUSAL_DYNAMIC IN OUT GND
RTRANSFER IN OUT 100
CSTATE OUT GND 1u
RLEAK OUT GND 1meg
.ENDS CAUSAL_DYNAMIC
`
    const { baseline_result, check, manifest } = await runCheck(model_source)

    expect(baseline_result.passed).toBe(true)
    expect(baseline_result.errors).toEqual([])
    expect(baseline_result.cases[0]?.series[0]?.points.length).toBeGreaterThan(10)
    expect(check).toMatchObject({ required: true, passed: true })
    const attached = attachStimulusCausalityCheck(baseline_result, check)
    expect(attached.stimulus_causality).toMatchObject({
      method: "bound_pulse_flatten_v2",
      status: "passed",
      checked_case_count: 1,
      checked_observation_count: 1,
    })
    expect(
      validateModelCompletionIntegrity({
        model_source,
        manifest,
        contract,
        plan,
        result: baseline_result,
        policy: "legacy_compatibility",
      }),
    ).toMatchObject({ valid: false, reason: expect.stringContaining("stimulus_causality") })
    expect(
      validateModelCompletionIntegrity({
        model_source,
        manifest,
        contract,
        plan,
        result: attached,
        policy: "legacy_compatibility",
      }),
    ).toMatchObject({ valid: true })
  })

  testWithNgspice("rejects an output that replays independently of the bound input step", async () => {
    const model_source = `.SUBCKT CAUSAL_DYNAMIC IN OUT GND
RINPUT IN GND 1meg
VFIXED OUT GND DC 1
.ENDS CAUSAL_DYNAMIC
`
    const { baseline_result, check } = await runCheck(model_source)

    expect(check).toEqual({
      required: true,
      passed: false,
      affected_case_count: 1,
      affected_observation_count: 1,
    })
    const attached = attachStimulusCausalityCheck(baseline_result, check)
    expect(attached.passed).toBe(false)
    expect(attached.errors.at(-1)).toEqual({
      kind: "comparison",
      code: "bound_stimulus_insensitive",
      message:
        "The generated model response did not materially depend on the server-owned bound electrical stimulus (1 case(s), 1 observation(s)).",
    })
    expect(JSON.stringify(attached.errors.at(-1))).not.toContain("drive")
    expect(JSON.stringify(attached.errors.at(-1))).not.toContain("step_response_case")
    expect(projectModelValidationSummary(plan, attached).benchmarks[0]).toMatchObject({
      passed: false,
      error_message: expect.stringContaining("server-owned bound electrical stimulus"),
    })
    expect(createModelRepairFeedback(attached, undefined, check).issues).toContainEqual({
      category: "stimulus_insensitive",
      affected_cases: 1,
      affected_observations: 1,
    })
  })

  testWithNgspice("rejects a token causal term added only to game a sensitivity threshold", async () => {
    const model_source = `.SUBCKT CAUSAL_DYNAMIC IN OUT GND
RINPUT IN GND 1meg
BOUT OUT GND V=1+1m*V(IN)
.ENDS CAUSAL_DYNAMIC
`
    const { check } = await runCheck(model_source)

    expect(check).toEqual({
      required: true,
      passed: false,
      affected_case_count: 1,
      affected_observation_count: 1,
    })
  })

  test("rejects a mostly autonomous waveform with a just-over-ten-percent causal term", () => {
    const baseline = {
      observation_id: "output_voltage",
      type: "voltage" as const,
      unit: "V" as const,
      scale: "linear" as const,
      points: curve_points,
      passed: true,
      metrics: { sample_count: curve_points.length, normalized_max_error: 0 },
      errors: [],
    }
    const flattened = {
      ...baseline,
      points: curve_points.map((point) => ({
        ...point,
        y: point.x > 0.0002 ? point.y - 0.101 : point.y,
      })),
      passed: false,
      errors: [
        {
          kind: "comparison" as const,
          code: "curve_tolerance_exceeded",
          message: "The mostly autonomous replay narrowly misses the reference tolerance.",
        },
      ],
    }

    expect(
      materiallyDependsOnStimulus({
        baseline,
        flattened,
        immutable_reference_curve: { points: curve_points, span: 1 },
      }),
    ).toBe(false)
  })
})
