import { expect, test } from "bun:test"
import {
  createModelTrainingCandidateQuality,
  ModelCandidateSearchSession,
  modelCandidateTopologyFingerprint,
} from "@/server/model-workflow/model-candidate-search"
import type { ModelTrainingValidationReport } from "@/server/model-workflow/model-training-validation"

function report(input: {
  error: number
  passed?: boolean
  viewer_available?: boolean
}): ModelTrainingValidationReport {
  const passed = input.passed ?? false
  const series = {
    observation_id: "vout",
    status: passed ? ("passed" as const) : ("failed" as const),
    metrics: {
      sample_count: 2,
      normalized_max_error: input.error,
      normalized_rmse: input.error / 2,
    },
    samples: [
      { x: 0, reference_y: 3.3, simulated_y: 3.3, error: 0 },
      { x: 1, reference_y: 3.2, simulated_y: 3.2 + input.error, error: input.error },
    ],
    error_codes: passed ? [] : ["curve_tolerance_exceeded"],
  }
  const viewer_available = input.viewer_available ?? true
  return {
    version: 1,
    status: passed ? "passed" : "failed",
    cases: [
      {
        case_id: "load_step",
        status: passed ? "passed" : "failed",
        server_series: [series],
        viewer_series: viewer_available ? [series] : [],
        error_codes: viewer_available ? [] : ["viewer_validation_unavailable"],
      },
    ],
    error_codes: viewer_available ? [] : ["viewer_validation_unavailable"],
  }
}

function snapshot(source: string, validation: ModelTrainingValidationReport) {
  return {
    source,
    card: "card",
    quality: createModelTrainingCandidateQuality(validation),
    topology_fingerprint: modelCandidateTopologyFingerprint(source),
    candidate_receipt: "{}\n",
    training_receipt: "{}\n",
  }
}

test("candidate search retains the best complete direct-and-viewer result", () => {
  const search = new ModelCandidateSearchSession()
  const simple = ".SUBCKT X A B\n.param R=1\nR1 A B {R}\n.ENDS X\n"
  const worse = ".SUBCKT X A B\n.param R=2\nR1 A B {R}\n.ENDS X\n"
  const unavailable = ".SUBCKT X A B\nR1 A B 3\n.ENDS X\n"

  expect(search.consider(snapshot(simple, report({ error: 0.2 })))).toBe("initial")
  expect(search.consider(snapshot(worse, report({ error: 0.4 })))).toBe("retained")
  expect(search.best?.source).toBe(simple)
  expect(search.consider(snapshot(unavailable, report({ error: 0.01, viewer_available: false })))).toBe(
    "retained",
  )
  expect(search.best?.source).toBe(simple)
})

test("numeric parameter changes share a topology and search budgets are global", () => {
  const first = ".SUBCKT X A B\n.param R=1\nR1 A B {R}\n.ENDS X\n"
  const calibrated = ".SUBCKT X A B\n.param R=2.5e-1\nR1 A B {R}\n.ENDS X\n"
  expect(modelCandidateTopologyFingerprint(first)).toBe(modelCandidateTopologyFingerprint(calibrated))

  const search = new ModelCandidateSearchSession()
  expect(search.reserveFit(first, 64)).toMatchObject({
    allowed: true,
    granted_fit_evaluations: 48,
  })
  expect(search.reserveFit(calibrated, 64)).toMatchObject({
    allowed: true,
    granted_fit_evaluations: 48,
  })
  expect(search.reserveFit(first, 3)).toMatchObject({ allowed: false })
  expect(search.summary.fit_evaluations).toBe(96)
})

test("candidate search stops after three distinct topologies and ten checks", () => {
  const search = new ModelCandidateSearchSession()
  for (let index = 0; index < 3; index += 1) {
    expect(search.reserveCheck(`.SUBCKT X A B\nR${index} A B 1\n.ENDS X\n`).allowed).toBe(true)
  }
  expect(search.reserveCheck(".SUBCKT X A B\nC4 A B 1u\n.ENDS X\n")).toMatchObject({
    allowed: false,
    diagnostic: expect.stringContaining("3 distinct topologies"),
  })

  const same_topology = ".SUBCKT X A B\nR0 A B 1\n.ENDS X\n"
  while (search.summary.remaining_checks > 0) {
    expect(search.reserveCheck(same_topology).allowed).toBe(true)
  }
  expect(search.reserveCheck(same_topology)).toMatchObject({
    allowed: false,
    diagnostic: expect.stringContaining("10 full candidate checks"),
  })
})
