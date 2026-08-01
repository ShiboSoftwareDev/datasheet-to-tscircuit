import { expect, test } from "bun:test"
import { createModelRepairFeedback, validationFailureFeedback } from "@/server/model-workflow/stage-helpers"
import type { ViewerSimulationValidation } from "@/server/modeling"
import type { ValidationRunResult } from "@/server/spice-validation"

test("model repair feedback exposes only typed aggregate failure categories", () => {
  const private_error = {
    kind: "comparison" as const,
    code: "target_tolerance_exceeded",
    message:
      "private fixture /tmp/secret-validation/circuit.cir expected 937.125 but stdout said hidden-net=4.25",
    path: "cases.private_fixture.fixtures[0].resistance_ohms",
  }
  const convergence_error = {
    kind: "convergence" as const,
    code: "private_convergence_code_with_fixture_topology",
    message: "singular matrix at secret_net_17; raw simulator stdout follows",
    path: "/tmp/private-validation/netlist.cir",
  }
  const result: ValidationRunResult = {
    version: 1,
    passed: false,
    hashes: {
      plan_sha256: "a".repeat(64),
      model_sha256: "b".repeat(64),
      manifest_sha256: "c".repeat(64),
    },
    cases: [
      {
        case_id: "private_load_topology_937_125",
        status: "failed",
        analysis: "operating_point",
        series: [
          {
            observation_id: "secret_output_node",
            type: "voltage",
            unit: "V",
            scale: "linear",
            points: [{ x: 61.75, y: 937.125 }],
            passed: false,
            metrics: {
              sample_count: 987,
              normalized_rmse: 42.5,
              normalized_max_error: 43.5,
              max_absolute_error: 932.875,
            },
            errors: [private_error],
          },
        ],
        errors: [private_error],
        elapsed_ms: 123,
        netlist_sha256: "d".repeat(64),
        raw_sha256: "e".repeat(64),
      },
      {
        case_id: "private_transient_topology",
        status: "failed",
        analysis: "transient",
        series: [],
        errors: [convergence_error],
        elapsed_ms: 456,
        netlist_sha256: "f".repeat(64),
      },
    ],
    errors: [private_error, convergence_error],
  }

  expect(createModelRepairFeedback(result)).toEqual({
    version: 1,
    status: "failed",
    issues: [
      { category: "target_mismatch", affected_cases: 1, affected_observations: 1 },
      { category: "convergence_failure", affected_cases: 1, affected_observations: 0 },
    ],
  })

  const feedback = validationFailureFeedback(result)
  expect(feedback).toContain("target_mismatch")
  expect(feedback).toContain("convergence_failure")
  for (const private_value of [
    "sample_count",
    "987",
    "937.125",
    "932.875",
    "private_load_topology",
    "private_transient_topology",
    "secret_output_node",
    "private_convergence_code",
    "secret_net_17",
    "stdout",
    "netlist.cir",
    "/tmp/",
    "resistance_ohms",
    "dddddddd",
  ]) {
    expect(feedback).not.toContain(private_value)
  }
})

test("unknown validation details collapse to a fixed generic category", () => {
  const result: ValidationRunResult = {
    version: 1,
    passed: false,
    hashes: {
      plan_sha256: "a".repeat(64),
      model_sha256: "b".repeat(64),
      manifest_sha256: "c".repeat(64),
    },
    cases: [],
    errors: [
      {
        kind: "contract",
        code: "private_unknown_code",
        message: "private fixture value 123456789",
        path: "/private/fixture.json",
      },
    ],
  }

  expect(createModelRepairFeedback(result).issues).toEqual([
    { category: "validation_failure", affected_cases: 0, affected_observations: 0 },
  ])
  expect(validationFailureFeedback(result)).not.toMatch(/private|123456789|fixture\.json/)
})

test("viewer-only curve mismatches enter repair as category/count feedback", () => {
  const result: ValidationRunResult = {
    version: 1,
    passed: true,
    hashes: {
      plan_sha256: "a".repeat(64),
      model_sha256: "b".repeat(64),
      manifest_sha256: "c".repeat(64),
    },
    cases: [
      {
        case_id: "private_viewer_case_987654",
        status: "passed",
        analysis: "transient",
        series: [],
        errors: [],
        elapsed_ms: 1,
        netlist_sha256: "d".repeat(64),
        raw_sha256: "e".repeat(64),
      },
    ],
    errors: [],
  }
  const viewer_validation: ViewerSimulationValidation = {
    simulation_valid: true,
    passed: false,
    series: [
      {
        observation_id: "secret_viewer_observation",
        type: "voltage",
        unit: "V",
        scale: "linear",
        points: [
          { x: 123.456, y: 987.654 },
          { x: 234.567, y: 876.543 },
        ],
        passed: false,
        metrics: { sample_count: 2, normalized_rmse: 42.5, normalized_max_error: 43.5 },
        errors: [
          {
            kind: "comparison",
            code: "curve_tolerance_exceeded",
            message: "Private viewer peak 43.5 exceeded hidden tolerance 0.012345",
          },
        ],
      },
    ],
    errors: [
      {
        kind: "comparison",
        code: "curve_tolerance_exceeded",
        message: "Private viewer peak 43.5 exceeded hidden tolerance 0.012345",
      },
    ],
  }

  expect(createModelRepairFeedback(result, { private_viewer_case_987654: viewer_validation })).toEqual({
    version: 1,
    status: "failed",
    issues: [{ category: "viewer_curve_mismatch", affected_cases: 1, affected_observations: 1 }],
  })
  const feedback = validationFailureFeedback(result, {
    private_viewer_case_987654: viewer_validation,
  })
  expect(feedback).toContain("viewer_curve_mismatch")
  expect(feedback).not.toMatch(/private|secret|987\.654|43\.5|0\.012345|123\.456|234\.567/)
})
