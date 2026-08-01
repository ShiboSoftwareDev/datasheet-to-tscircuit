import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModelContract, ModelInterface, ModelRequirement } from "@/server/modeling"
import { parseValidationPlan, runSpiceValidation, ValidationPlanError } from "@/server/spice-validation"
import type { ModelManifest } from "@/shared/job-types"

const temporary_directories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

const model_interface: ModelInterface = {
  version: 1,
  part_number: "ANALYSIS-REGRESSION",
  entry_name: "ANALYSIS_REGRESSION",
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
}

const manifest: ModelManifest = {
  version: 1,
  part_number: model_interface.part_number,
  dialect: "portable",
  entry_name: model_interface.entry_name,
  model_file: "model.lib",
  revision: "analysis-regression",
  simulator: "ngspice",
  generated_at: "2026-01-01T00:00:00.000Z",
  pins: model_interface.pins.map(({ component_pin, spice_node }) => ({ component_pin, spice_node })),
}

const model_source = `.SUBCKT ANALYSIS_REGRESSION IN OUT GND
E_GAIN OUT GND IN GND 2
.ENDS ANALYSIS_REGRESSION
`

function requirement(analysis: ModelRequirement["analysis"]): ModelRequirement {
  return {
    requirement_id: "output_voltage",
    title: "Output voltage",
    behavior: "The output follows the modeled static response",
    analysis,
    support: { status: "modeled" },
    conditions: {},
    expected: { unit: "V", target: 1, tolerance: 0.1 },
    sources: [],
  }
}

function modelContract(model_requirement: ModelRequirement): ModelContract {
  return {
    version: 1,
    interface: model_interface,
    characterization: {
      version: 1,
      family: "other",
      strategy: "behavioral",
      requirements: [model_requirement],
      assumptions: [],
      limitations: [],
    },
  }
}

function validationPlan(analysis: "operating_point" | "dc_sweep"): unknown {
  return {
    version: 1,
    model: { entry_name: model_interface.entry_name, pins: ["IN", "OUT", "GND"] },
    cases: [
      {
        id: "output_voltage",
        requirement_ids: ["output_voltage"],
        nets: [],
        fixtures: [
          {
            id: "input",
            type: "voltage_source",
            positive: "dut.IN",
            negative: "gnd",
            dc_volts: 0,
          },
          {
            id: "load",
            type: "resistor",
            positive: "dut.OUT",
            negative: "gnd",
            resistance_ohms: 10_000,
          },
          {
            id: "ground_ref",
            type: "voltage_source",
            positive: "dut.GND",
            negative: "gnd",
            dc_volts: 0,
          },
        ],
        analysis:
          analysis === "operating_point"
            ? { type: "operating_point" }
            : { type: "dc_sweep", source_id: "input", start: 0, stop: 1, step: 0.25 },
        observations: [
          {
            id: "output_voltage",
            requirement_id: "output_voltage",
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

test("missing raw vectors are simulator infrastructure failures, never comparisons", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "spice-missing-vector-kind-"))
  temporary_directories.push(model_dir)
  const model_requirement = requirement("operating_point")
  const missing_vector_raw = `Title: missing vector regression
Plotname: Operating Point
Flags: real
No. Variables: 1
No. Points: 1
Variables:
  0 v(unrelated) voltage
Values:
0 0
`

  const result = await runSpiceValidation({
    plan: validationPlan("operating_point"),
    manifest,
    model_source,
    model_dir,
    model_contract: modelContract(model_requirement),
    ngspice: async ({ raw_path }) => {
      await writeFile(raw_path, missing_vector_raw, "utf8")
      return { exit_code: 0, stdout: "", stderr: "", cancelled: false }
    },
  })

  expect(result.passed).toBe(false)
  expect(result.errors).toEqual([
    expect.objectContaining({
      kind: "simulator",
      code: "missing_vector",
    }),
  ])
  expect(result.errors.some(({ kind }) => kind === "comparison")).toBe(false)
  expect(result.cases[0]?.series).toEqual([])
})

test("DC sweeps strengthen operating-point requirements but operating points cannot weaken DC sweeps", () => {
  const operating_point_requirement = requirement("operating_point")
  expect(
    parseValidationPlan(validationPlan("dc_sweep"), {
      model_interface,
      model_requirements: [operating_point_requirement],
    }).cases[0]?.analysis.type,
  ).toBe("dc_sweep")

  const dc_sweep_requirement = requirement("dc_sweep")
  try {
    parseValidationPlan(validationPlan("operating_point"), {
      model_interface,
      model_requirements: [dc_sweep_requirement],
    })
    throw new Error("Expected operating-point downgrade to be rejected")
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationPlanError)
    expect((error as ValidationPlanError).errors).toContainEqual(
      expect.objectContaining({
        path: "cases[0].requirement_ids[0]",
        code: "requirement_analysis_mismatch",
      }),
    )
  }
})
