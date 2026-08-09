import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelRunStore } from "@/server/model-run-store"
import { projectSimulationSourcesUi } from "@/server/model-workflow/simulation-source-ui"
import type { ValidationPlan } from "@/server/spice-validation"
import { parseModelSelectedPreview } from "@/shared/model-selected-preview"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("Create Simulation TSX publishes every source without pre-running validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "simulation-source-ui-test-"))
  roots.push(root)
  const model_dir = join(root, "spice")
  const evidence_dir = join(root, "evidence")
  await mkdir(evidence_dir, { recursive: true })
  await Bun.write(join(evidence_dir, "graph.png"), "source image")
  const plan: ValidationPlan = {
    version: 1,
    model: { entry_name: "TEST_MODEL", pins: ["OUT"] },
    cases: [
      {
        id: "startup",
        title: "Startup",
        requirement_ids: ["startup_output"],
        nets: [],
        fixtures: [],
        analysis: { type: "transient", step: 0.001, stop: 0.01 },
        observations: [
          {
            id: "output",
            requirement_id: "startup_output",
            type: "voltage",
            role: "response",
            positive: "dut.OUT",
            negative: "gnd",
            unit: "V",
            scale: "linear",
            evidence: { image: "evidence/graph.png" },
            reference: {
              type: "curve",
              tolerance: 0.1,
              points: [
                { x: 0, y: 0 },
                { x: 0.01, y: 3.3 },
              ],
            },
          },
        ],
      },
    ],
  }
  const source = "export default function Preview() { return <board /> }\n"
  const store = new ModelRunStore()
  store.createModelRun({
    model_run_id: "model-run-1",
    job_id: "job-1",
    model_dir,
    effort_multiplier: 1,
  })

  await projectSimulationSourcesUi({
    model_run_store: store,
    model_run_id: "model-run-1",
    model_dir,
    plan,
    evidence_dir,
    source_by_case: { startup: source },
    signal: new AbortController().signal,
  })

  const model_run = store.getModelRun("model-run-1")
  expect(model_run?.preview_options.map(({ benchmark_id }) => benchmark_id)).toEqual(["startup"])
  expect(model_run?.circuit_preview).toMatchObject({
    code: source,
    build_status: "source_ready",
    analysis_type: "transient",
  })
  expect(model_run?.circuit_preview?.circuit_json).toBeUndefined()
  expect(model_run?.circuit_preview?.analog_simulation_status).toBeUndefined()

  const stored = parseModelSelectedPreview(
    JSON.parse(await readFile(join(model_dir, "current-preview/cases/startup.preview.json"), "utf8")),
  )
  expect(stored.circuit_preview?.code).toBe(source)
  expect(stored.reference_preview?.reference_points).toEqual([
    { x: 0, y: 0 },
    { x: 0.01, y: 3.3 },
  ])
  expect(await readFile(join(model_dir, "current-preview/cases/startup.circuit.tsx"), "utf8")).toBe(source)
})
