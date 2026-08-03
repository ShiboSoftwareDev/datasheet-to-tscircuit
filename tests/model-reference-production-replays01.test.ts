import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  parseApplicationFixtureContract,
  parseFreshModelContract,
  parseModelInterface,
} from "@/server/modeling"
import { characterizeReferenceGraphs } from "@/server/model-workflow/characterization/from-reference-graphs"
import {
  parseCanonicalReferenceGraphObservation,
  parseReferenceGraphObservation,
} from "@/server/model-workflow/reference-graph-observation"
import type { TimeGraphDiscovery } from "@/server/model-workflow/time-graph-hints"
import { buildGraphValidationPlan } from "@/server/model-workflow/validation-plan-from-graphs"

interface Run105ReferenceReplay {
  version: 1
  source: string
  model_run_id: string
  failure: string
  model_interface: unknown
  application_fixture: unknown
  discovery: TimeGraphDiscovery
  observation: {
    graphs: Array<{
      digitized_curve?: {
        x_range: { min: number; max: number }
        x_axis: {
          scale: "linear"
          first: { pixel: number; value: number }
          second: { pixel: number; value: number }
        }
        points: Array<{ pixel_x: number; pixel_y: number; x?: number; y?: number }>
      }
    }>
  }
}

async function readRun105Replay() {
  const replay_path = join(
    import.meta.dir,
    "fixtures/model-run-replays/run105-tps63802-negative-elapsed-reference.json",
  )
  const replay_bytes = await readFile(replay_path)
  expect(createHash("sha256").update(replay_bytes).digest("hex")).toBe(
    "dac60da447174ff1ddc5360e78f4418a86cd1780bb3788a1ddfeaf4d79e8248d",
  )
  const replay = JSON.parse(replay_bytes.toString("utf8")) as Run105ReferenceReplay
  expect(replay).toMatchObject({
    version: 1,
    source: "model-agent(105)",
    model_run_id: "bb51c363-4ddb-4e30-9fed-d6f6fabd2f74",
    failure: "derived_negative_elapsed_time",
  })
  return {
    replay,
    model_interface: parseModelInterface(replay.model_interface),
    application_fixture: parseApplicationFixtureContract(replay.application_fixture),
  }
}

test("run 105 is rejected at the observer boundary before negative elapsed time reaches characterization", async () => {
  const { replay, model_interface, application_fixture } = await readRun105Replay()

  expect(() =>
    parseCanonicalReferenceGraphObservation(
      replay.observation,
      replay.discovery,
      model_interface,
      application_fixture,
    ),
  ).toThrow(
    /digitized_curve\.points cannot contain negative elapsed time derived from the pixel-axis calibration/,
  )
})

test("a source-aligned correction of run 105 survives fresh contract and validation-plan boundaries", async () => {
  const { replay, model_interface, application_fixture } = await readRun105Replay()
  const corrected_observation = structuredClone(replay.observation)
  const curve = corrected_observation.graphs[0]?.digitized_curve
  if (!curve) throw new Error("run 105 replay lost its digitized curve")

  // Run 105 used pixel 63 as zero while tracing from pixel 25. Align zero to
  // the first source-recognized vertical grid line and retain the printed
  // 100 us/div scale across the ten-division scope window.
  curve.x_axis = {
    scale: "linear",
    first: { pixel: 22, value: 0 },
    second: { pixel: 557, value: 0.001 },
  }
  curve.x_range = { min: 0, max: 0.001 }
  for (const point of curve.points) {
    delete point.x
    delete point.y
  }

  const observation = parseReferenceGraphObservation(
    corrected_observation,
    replay.discovery,
    model_interface,
    application_fixture,
  )
  const points = observation.graphs[0]?.digitized_curve?.points
  if (!points) throw new Error("corrected run 105 replay was unexpectedly demoted")
  expect(points).toHaveLength(39)
  expect(Math.min(...points.map(({ x }) => x))).toBeGreaterThanOrEqual(0)

  const characterization = characterizeReferenceGraphs({ model_interface, observation })
  const contract = parseFreshModelContract({
    version: 1,
    interface: model_interface,
    characterization,
    application_fixture,
  })
  const plan = buildGraphValidationPlan(contract)
  const analysis = plan.cases[0]?.analysis
  expect(plan.cases).toHaveLength(1)
  expect(analysis).toMatchObject({ type: "transient" })
  if (analysis?.type !== "transient") throw new Error("run 105 replay did not produce a transient case")
  expect(analysis.start ?? 0).toBeGreaterThanOrEqual(0)
  expect(analysis.stop).toBeGreaterThan(Math.max(...points.map(({ x }) => x)))
})
