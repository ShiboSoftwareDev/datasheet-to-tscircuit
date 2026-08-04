import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertValidationPlanSensitiveToDut } from "@/server/model-workflow/validation-sensitivity"
import type { ModelContract } from "@/server/modeling"
import {
  executeLocalNgspice,
  type NgspiceExecutor,
  parseValidationPlan,
  type ValidationPlan,
} from "@/server/spice-validation"

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

async function runSensitivityCheck(
  plan: ValidationPlan,
  model_contract: ModelContract = contract,
  ngspice: NgspiceExecutor = executeLocalNgspice,
): Promise<void> {
  const model_dir = await mkdtemp(join(tmpdir(), "model-sensitivity-"))
  temporary_directories.push(model_dir)
  const parsed = parseValidationPlan(plan, {
    model_interface: model_contract.interface,
    model_requirements: model_contract.characterization.requirements,
  })
  await assertValidationPlanSensitiveToDut({
    plan: parsed,
    contract: model_contract,
    model_dir,
    artifact_directory: join(model_dir, "private-sensitivity"),
    ngspice,
    ngspice_path: ngspice_path ?? "ngspice",
  })
}

testWithNgspice("rejects an observation fixed by its fixture instead of the DUT", async () => {
  const insensitive_plan = planWithFixtures([
    {
      type: "resistor",
      id: "pullup",
      positive: "dut.OUT",
      negative: "net.reference",
      resistance_ohms: 1e-3,
    },
    {
      type: "voltage_source",
      id: "reference",
      positive: "net.reference",
      negative: "gnd",
      dc_volts: 1,
    },
  ])

  await expect(runSensitivityCheck(insensitive_plan)).rejects.toThrow(
    "do not materially respond to server-owned DUT sensitivity probes",
  )
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

testWithNgspice("accepts a max-only shutdown-current observation when the inert probe passes", async () => {
  const shutdown_contract: ModelContract = {
    version: 1,
    interface: {
      version: 1,
      part_number: "SHUTDOWN-CURRENT-TEST",
      entry_name: "SHUTDOWN_CURRENT_TEST",
      pins: [
        {
          physical_pin: "1",
          component_pin: "pin1",
          source_port_id: "source_port_1",
          spice_node: "VIN",
          labels: ["VIN"],
          role: "power",
        },
      ],
    },
    characterization: {
      version: 1,
      family: "other",
      strategy: "behavioral",
      requirements: [
        {
          requirement_id: "shutdown_input_current",
          title: "Shutdown input current",
          behavior: "VIN draws no more than 600 nA while disabled",
          analysis: "operating_point",
          support: { status: "modeled" },
          conditions: { vin_v: 3.6, enabled: false },
          expected: { unit: "A", max: 600e-9 },
          sources: [{ page: 1, locator: "table", statement: "Shutdown current is 600 nA maximum" }],
        },
      ],
      assumptions: [],
      limitations: [],
    },
  }
  const shutdown_plan: ValidationPlan = {
    version: 1,
    model: { entry_name: "SHUTDOWN_CURRENT_TEST", pins: ["VIN"] },
    cases: [
      {
        id: "shutdown_current",
        requirement_ids: ["shutdown_input_current"],
        nets: ["supply"],
        fixtures: [
          {
            type: "voltage_source",
            id: "vin_supply",
            positive: "net.supply",
            negative: "gnd",
            dc_volts: 3.6,
          },
          {
            type: "resistor",
            id: "vin_sense",
            positive: "net.supply",
            negative: "dut.VIN",
            resistance_ohms: 1,
          },
        ],
        analysis: { type: "operating_point" },
        observations: [
          {
            type: "current",
            id: "vin_current",
            requirement_id: "shutdown_input_current",
            element_id: "vin_sense",
            unit: "A",
            scale: "linear",
            reference: { type: "bounds", max: 600e-9 },
          },
        ],
      },
    ],
  }

  await expect(runSensitivityCheck(shutdown_plan, shutdown_contract)).resolves.toBeUndefined()
})

testWithNgspice(
  "uses finite probe samples even when one lies outside the log comparison domain",
  async () => {
    const log_plan = planWithFixtures([
      {
        type: "resistor",
        id: "load",
        positive: "dut.OUT",
        negative: "gnd",
        resistance_ohms: 1_000,
      },
    ])
    const observation = log_plan.cases[0]?.observations[0]
    if (!observation) throw new Error("Expected sensitivity observation")
    observation.scale = "log"

    await expect(runSensitivityCheck(log_plan)).resolves.toBeUndefined()
  },
)

test("does not treat a missing observation vector as DUT sensitivity", async () => {
  const sensitive_plan = planWithFixtures([
    {
      type: "resistor",
      id: "load",
      positive: "dut.OUT",
      negative: "gnd",
      resistance_ohms: 1_000,
    },
  ])
  const missing_vector: NgspiceExecutor = async ({ raw_path }) => {
    await writeFile(
      raw_path,
      `Title: sensitivity missing-vector regression
Plotname: Operating Point
Flags: real
No. Variables: 1
No. Points: 1
Variables:
  0 v(unrelated) voltage
Values:
0 0
`,
      "utf8",
    )
    return { exit_code: 0, stdout: "", stderr: "", cancelled: false }
  }

  await expect(runSensitivityCheck(sensitive_plan, contract, missing_vector)).rejects.toThrow(
    "missing_vector",
  )
})
