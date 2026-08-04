import { expect, test } from "bun:test"
import {
  compareCandidateQuality,
  createCandidateQuality,
  type CandidateViewerQualityCase,
} from "@/server/model-workflow/candidate-quality"
import type { ValidationRunResult } from "@/server/spice-validation"

function result(input: {
  normalized_error: number
  passed?: boolean
  causality_failed?: boolean
}): ValidationRunResult {
  const passed = input.passed ?? false
  return {
    version: 1,
    passed,
    hashes: {
      plan_sha256: "a".repeat(64),
      model_sha256: "b".repeat(64),
      manifest_sha256: "c".repeat(64),
    },
    cases: [
      {
        case_id: "transient",
        status: passed ? "passed" : "failed",
        analysis: "transient",
        elapsed_ms: 1,
        netlist_sha256: "d".repeat(64),
        series: [
          {
            observation_id: "output",
            type: "voltage",
            unit: "V",
            scale: "linear",
            points: [],
            metrics: {
              sample_count: 1,
              normalized_max_error: input.normalized_error,
            },
            passed,
            errors: passed
              ? []
              : [
                  {
                    kind: "comparison",
                    code: "curve_tolerance_exceeded",
                    message: "curve mismatch",
                  },
                ],
          },
        ],
        errors: [],
      },
    ],
    errors: input.causality_failed
      ? [
          {
            kind: "comparison",
            code: "bound_stimulus_insensitive",
            message: "stimulus insensitive",
          },
        ]
      : [],
  }
}

function viewer(input: {
  available?: boolean
  passed?: boolean
  error: number
}): CandidateViewerQualityCase[] {
  return [
    {
      case_id: "transient",
      available: input.available ?? true,
      series:
        input.available === false
          ? []
          : [
              {
                passed: input.passed ?? false,
                normalized_max_error: input.error,
              },
            ],
    },
  ]
}

test("candidate quality retains a runnable candidate over a numerically tempting viewer regression", () => {
  const incumbent = createCandidateQuality({
    result: result({ normalized_error: 0.08 }),
    viewer_cases: viewer({ error: 0.08 }),
  })
  const regressed = createCandidateQuality({
    result: result({ normalized_error: 0.04 }),
    viewer_cases: viewer({ available: false, error: 0.04 }),
  })

  expect(compareCandidateQuality(incumbent, regressed)).toBeLessThan(0)
})

test("candidate quality prefers fewer failed cases and never replaces an incumbent on a tie", () => {
  const improved = createCandidateQuality({
    result: result({ normalized_error: 0.04, passed: true }),
    viewer_cases: viewer({ error: 0.04, passed: true }),
  })
  const incumbent = createCandidateQuality({
    result: result({ normalized_error: 0.08 }),
    viewer_cases: viewer({ error: 0.08 }),
  })

  expect(compareCandidateQuality(improved, incumbent)).toBeLessThan(0)
  expect(compareCandidateQuality(incumbent, incumbent)).toBe(0)
})

test("candidate quality penalizes stimulus-insensitive overfit before residual size", () => {
  const causal = createCandidateQuality({
    result: result({ normalized_error: 0.08 }),
    viewer_cases: viewer({ error: 0.08 }),
  })
  const overfit = createCandidateQuality({
    result: result({ normalized_error: 0.04, causality_failed: true }),
    viewer_cases: viewer({ error: 0.04 }),
  })

  expect(compareCandidateQuality(causal, overfit)).toBeLessThan(0)
})
