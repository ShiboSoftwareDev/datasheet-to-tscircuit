import { expect, test } from "bun:test"
import {
  compareModelFitScores,
  readModelFitParameterDeclarations,
  replaceModelFitParameters,
  scoreModelFitValidation,
  searchModelParameters,
} from "@/server/model-workflow/model-parameter-fit"
import type { ValidationRunResult } from "@/server/spice-validation"

test("numeric .param declarations are explicit, case-insensitive, and replaced without touching comments", () => {
  const source = [
    ".param LOOP_GAIN=2.5 ; tuned",
    ".PARAM tau = 1e-6",
    "B1 out 0 V={LOOP_GAIN*V(in)}",
    "* .param COMMENTED=9",
    "",
  ].join("\n")

  expect(readModelFitParameterDeclarations(source)).toEqual([
    { name: "LOOP_GAIN", value: 2.5 },
    { name: "tau", value: 1e-6 },
  ])
  const replaced = replaceModelFitParameters(source, { loop_gain: 3, TAU: 2e-6 })
  expect(replaced).toContain(".param LOOP_GAIN=3e+0 ; tuned")
  expect(replaced).toContain(".PARAM tau = 2e-6")
  expect(replaced).toContain("* .param COMMENTED=9")
})

test("bounded parameter search explores globally and refines deterministically", async () => {
  const source = ".param A=0.1\n.param B=10\n"
  const result = await searchModelParameters({
    source,
    ranges: [
      { name: "A", min: -2, max: 2, scale: "linear" },
      { name: "B", min: 1, max: 100, scale: "log" },
    ],
    max_evaluations: 48,
    evaluate: async (candidate) => {
      const values = Object.fromEntries(
        readModelFitParameterDeclarations(candidate).map(({ name, value }) => [name, value]),
      )
      const error = Math.abs(values.A - 1.1) + Math.abs(Math.log(values.B / 20))
      return {
        runnable: true,
        failed_series_count: error > 0.1 ? 1 : 0,
        worst_normalized_max_error: error,
        mean_normalized_rmse: error / 2,
      }
    },
  })

  expect(result.evaluations).toBeLessThanOrEqual(48)
  expect(result.best.score.worst_normalized_max_error).toBeLessThan(0.18)
  expect(result.best.values.A).toBeGreaterThan(0.9)
  expect(result.best.values.A).toBeLessThan(1.3)
  expect(result.best.values.B).toBeGreaterThan(16)
  expect(result.best.values.B).toBeLessThan(25)
  expect(result.improvements.length).toBeGreaterThan(1)
})

test("fit scoring rejects simulator failures before comparing numeric residuals", () => {
  const validation = (runnable: boolean, normalized_error: number): ValidationRunResult => ({
    version: 1,
    passed: false,
    hashes: {
      plan_sha256: "a".repeat(64),
      model_sha256: "b".repeat(64),
      manifest_sha256: "c".repeat(64),
    },
    cases: [
      {
        case_id: "transient",
        status: "failed",
        analysis: "transient",
        series: [
          {
            observation_id: "vout",
            type: "voltage",
            unit: "V",
            scale: "linear",
            points: [],
            metrics: {
              sample_count: 1,
              normalized_max_error: normalized_error,
              normalized_rmse: normalized_error / 2,
            },
            passed: false,
            errors: [],
          },
        ],
        errors: [],
        elapsed_ms: 1,
        netlist_sha256: "d".repeat(64),
      },
    ],
    errors: runnable ? [] : [{ kind: "simulator", code: "failed", message: "not runnable" }],
  })
  const stable = scoreModelFitValidation(validation(true, 0.4))
  const broken = scoreModelFitValidation(validation(false, 0.01))

  expect(stable.runnable).toBe(true)
  expect(broken.runnable).toBe(false)
  expect(compareModelFitScores(stable, broken)).toBeLessThan(0)
})

test("fitted R/C/L parameters require a positive search domain", async () => {
  await expect(
    searchModelParameters({
      source: ".SUBCKT X A B\n.param R_VALUE=10\nR1 A B {R_VALUE}\n.ENDS X\n",
      ranges: [{ name: "R_VALUE", min: -1, max: 20, scale: "linear" }],
      max_evaluations: 3,
      evaluate: async () => ({
        runnable: true,
        failed_series_count: 0,
        worst_normalized_max_error: 0,
        mean_normalized_rmse: 0,
      }),
    }),
  ).rejects.toThrow("strictly positive lower bound")
})
