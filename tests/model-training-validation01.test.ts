import { expect, test } from "bun:test"
import {
  createModelTrainingValidationPlan,
  createModelTrainingValidationReport,
} from "@/server/model-workflow/model-training-validation"
import { createModelTrainingContract, type ModelContract } from "@/server/modeling"
import type { ViewerSimulationValidation } from "@/server/modeling"
import type { ValidationPlan, ValidationRunResult } from "@/server/spice-validation"

const contract: ModelContract = {
  version: 1,
  interface: {
    version: 1,
    part_number: "TRAINING",
    entry_name: "TRAINING",
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
        requirement_id: "visible_curve",
        title: "Visible curve",
        behavior: "Follow the visible curve",
        analysis: "transient",
        support: { status: "modeled" },
        conditions: {},
        expected: { unit: "V", min: 0, max: 7 },
        reference_curve: {
          x_quantity: "time",
          x_unit: "s",
          y_quantity: "voltage",
          y_unit: "V",
          points: Array.from({ length: 8 }, (_, x) => ({ x, y: x })),
        },
        sources: [{ page: 1, locator: "Figure 1", statement: "Visible curve" }],
      },
    ],
    assumptions: [],
    limitations: [],
  },
}

const plan: ValidationPlan = {
  version: 1,
  model: { entry_name: "TRAINING", pins: ["OUT"] },
  cases: [
    {
      id: "visible_case",
      requirement_ids: ["visible_curve"],
      nets: [],
      fixtures: [
        {
          id: "load",
          type: "current_source",
          positive: "dut.OUT",
          negative: "gnd",
          dc_amps: 0,
        },
      ],
      analysis: { type: "transient", step: 0.1, stop: 7 },
      observations: [
        {
          id: "output",
          requirement_id: "visible_curve",
          type: "voltage",
          positive: "dut.OUT",
          negative: "gnd",
          unit: "V",
          scale: "linear",
          reference: {
            type: "curve",
            tolerance: 0.05,
            points: Array.from({ length: 8 }, (_, x) => ({ x, y: x })),
          },
        },
      ],
    },
  ],
}

test("public training plan preserves fixtures but removes every withheld reference sample", () => {
  const training_contract = createModelTrainingContract(contract)
  const training_plan = createModelTrainingValidationPlan({ plan, training_contract })
  const reference = training_plan.cases[0]?.observations[0]?.reference

  expect(training_plan.cases[0]?.fixtures).toEqual(plan.cases[0]?.fixtures)
  expect(reference?.type).toBe("curve")
  if (reference?.type !== "curve") throw new Error("expected a curve")
  expect(reference.points.map(({ x }) => x)).toEqual([0, 1, 3, 5, 7])
  expect(plan.cases[0]?.observations[0]?.reference).toMatchObject({
    points: expect.arrayContaining([
      { x: 2, y: 2 },
      { x: 4, y: 4 },
      { x: 6, y: 6 },
    ]),
  })
})

test("training report returns numeric residuals only at public plan samples for server and viewer", () => {
  const training_plan = createModelTrainingValidationPlan({
    plan,
    training_contract: createModelTrainingContract(contract),
  })
  const points = Array.from({ length: 8 }, (_, x) => ({ x, y: x + 0.25 }))
  const series = {
    observation_id: "output",
    type: "voltage" as const,
    unit: "V" as const,
    scale: "linear" as const,
    points,
    passed: false,
    metrics: {
      sample_count: 5,
      normalized_rmse: 0.05,
      normalized_max_error: 0.05,
      max_absolute_error: 0.25,
    },
    errors: [
      {
        kind: "comparison" as const,
        code: "curve_tolerance_exceeded",
        message: "private full-curve diagnostic",
      },
    ],
  }
  const server_case: ValidationRunResult["cases"][number] = {
    case_id: "visible_case",
    status: "failed",
    analysis: "transient",
    series: [series],
    errors: [],
    elapsed_ms: 1,
    netlist_sha256: "a".repeat(64),
  }
  const viewer: ViewerSimulationValidation = {
    simulation_valid: true,
    passed: false,
    series: [series],
    errors: series.errors,
  }

  const report = createModelTrainingValidationReport({
    plan: training_plan,
    server_cases: [server_case],
    server_passed: false,
    viewer_validation_by_case: { visible_case: viewer },
  })

  expect(report.status).toBe("failed")
  expect(report.cases[0]?.server_series[0]?.samples.map(({ x }) => x)).toEqual([0, 1, 3, 5, 7])
  expect(report.cases[0]?.viewer_series[0]?.samples.map(({ error }) => error)).toEqual([
    0.25, 0.25, 0.25, 0.25, 0.25,
  ])
  expect(JSON.stringify(report)).not.toContain("private full-curve diagnostic")
  expect(JSON.stringify(report)).not.toMatch(/\"x\":(?:2|4|6),/)
})
