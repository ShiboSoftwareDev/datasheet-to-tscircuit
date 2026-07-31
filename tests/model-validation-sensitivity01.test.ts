import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertValidationPlanSensitiveToDut } from "@/server/model-workflow/validation-sensitivity"
import type { ModelContract } from "@/server/modeling"
import { executeLocalNgspice, parseValidationPlan, type ValidationPlan } from "@/server/spice-validation"

const ngspice_path = Bun.which("ngspice")
const testWithNgspice = ngspice_path ? test : test.skip
const temporary_directories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

const contract: ModelContract = {
  version: 1,
  interface: {
    version: 1,
    part_number: "SENSITIVITY-TEST",
    entry_name: "SENSITIVITY_TEST",
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
        behavior: "The output is one volt",
        analysis: "operating_point",
        support: { status: "modeled" },
        conditions: {},
        expected: { unit: "V", target: 1, tolerance: 0.01 },
        sources: [{ page: 1, locator: "table", statement: "Output is one volt" }],
      },
    ],
    assumptions: [],
    limitations: [],
  },
}

function planWithFixtures(fixtures: ValidationPlan["cases"][number]["fixtures"]): ValidationPlan {
  return {
    version: 1,
    model: { entry_name: "SENSITIVITY_TEST", pins: ["OUT"] },
    cases: [
      {
        id: "output_voltage",
        requirement_ids: ["output_voltage"],
        nets: fixtures.some(
          (fixture) =>
            "positive" in fixture &&
            (fixture.positive === "net.reference" || fixture.negative === "net.reference"),
        )
          ? ["reference"]
          : [],
        fixtures,
        analysis: { type: "operating_point" },
        observations: [
          {
            type: "voltage",
            id: "output",
            requirement_id: "output_voltage",
            positive: "dut.OUT",
            negative: "gnd",
            unit: "V",
            scale: "linear",
            reference: { type: "target", target: 1, tolerance: 0.01 },
          },
        ],
      },
    ],
  }
}

async function runSensitivityCheck(plan: ValidationPlan): Promise<void> {
  const model_dir = await mkdtemp(join(tmpdir(), "model-sensitivity-"))
  temporary_directories.push(model_dir)
  const parsed = parseValidationPlan(plan, {
    model_interface: contract.interface,
    model_requirements: contract.characterization.requirements,
  })
  await assertValidationPlanSensitiveToDut({
    plan: parsed,
    contract,
    model_dir,
    artifact_directory: join(model_dir, "private-sensitivity"),
    ngspice: executeLocalNgspice,
    ngspice_path: ngspice_path!,
  })
}

testWithNgspice("rejects a fixture that pulls an inert DUT output to the target", async () => {
  const insensitive_plan = planWithFixtures([
    {
      type: "resistor",
      id: "pullup",
      positive: "dut.OUT",
      negative: "net.reference",
      resistance_ohms: 1_000,
    },
    {
      type: "voltage_source",
      id: "reference",
      positive: "net.reference",
      negative: "gnd",
      dc_volts: 1,
    },
  ])

  await expect(runSensitivityCheck(insensitive_plan)).rejects.toThrow("pass with an inert DUT")
})

testWithNgspice("accepts an observation whose target requires active DUT behavior", async () => {
  const sensitive_plan = planWithFixtures([
    {
      type: "resistor",
      id: "load",
      positive: "dut.OUT",
      negative: "gnd",
      resistance_ohms: 1_000,
    },
  ])

  await expect(runSensitivityCheck(sensitive_plan)).resolves.toBeUndefined()
})
