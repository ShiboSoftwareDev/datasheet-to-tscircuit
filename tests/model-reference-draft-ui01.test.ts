import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelRunStore } from "@/server/model-run-store"
import { projectReferenceDraftUi } from "@/server/model-workflow/reference-draft-ui"
import { loadStoredModelPreview } from "@/server/modeling"
import type { ValidationPlan } from "@/server/spice-validation"

const temporary_directories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

test("a reference graph is inspectable before a model candidate exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-reference-draft-"))
  temporary_directories.push(root)
  const model_dir = join(root, "spice")
  const evidence_dir = join(root, "evidence")
  const image_path = join(evidence_dir, "figures", "load_step.png")
  await Bun.write(image_path, new Uint8Array([137, 80, 78, 71]))

  const plan: ValidationPlan = {
    version: 1,
    model: { entry_name: "TEST_DUT", pins: ["VIN", "VOUT", "GND"] },
    cases: [
      {
        id: "load_step",
        title: "Load transient",
        requirement_ids: ["load_step"],
        nets: [],
        fixtures: [
          {
            id: "stimulus",
            type: "current_source",
            positive: "dut.VOUT",
            negative: "gnd",
            dc_amps: 0.1,
            pulse: {
              low: 0.1,
              high: 0.5,
              delay: 0.0001,
              rise: 0.00001,
              fall: 0.00001,
              width: 0.0005,
              period: 0.001,
            },
          },
        ],
        analysis: { type: "transient", step: 0.00001, stop: 0.001 },
        observations: [
          {
            id: "response",
            requirement_id: "load_step",
            type: "voltage",
            positive: "dut.VOUT",
            negative: "gnd",
            unit: "V",
            scale: "linear",
            evidence: {
              page: 7,
              image: "evidence/figures/load_step.png",
              metadata: {
                x_quantity: "time",
                x_unit: "s",
                y_quantity: "voltage",
                y_unit: "V",
              },
            },
            reference: {
              type: "curve",
              tolerance: 0.1,
              points: [
                { x: 0, y: 3.3 },
                { x: 0.0005, y: 3.2 },
                { x: 0.001, y: 3.3 },
              ],
            },
          },
        ],
      },
    ],
  }
  const store = new ModelRunStore()
  store.createModelRun({
    model_run_id: "model_draft",
    job_id: "job_draft",
    model_dir,
    effort_multiplier: 1,
  })

  await projectReferenceDraftUi({
    model_run_store: store,
    model_run_id: "model_draft",
    model_dir,
    plan,
    evidence_dir,
    signal: new AbortController().signal,
  })

  const run = store.getModelRun("model_draft")
  expect(run?.preview_options).toEqual([
    {
      benchmark_id: "load_step",
      title: "Load transient",
      circuit_file: "validation/cases/load_step.circuit.tsx",
      reference_file: "evidence/figures/load_step.png",
      result_file: undefined,
    },
  ])
  expect(run?.circuit_preview).toBeUndefined()
  expect(run?.reference_preview).toMatchObject({
    benchmark_id: "load_step",
    source_file: "evidence/figures/load_step.png",
    reference_points: [
      { x: 0, y: 3.3 },
      { x: 0.0005, y: 3.2 },
      { x: 0.001, y: 3.3 },
    ],
    result_points: undefined,
    matches_reference: undefined,
  })
  const selected = await loadStoredModelPreview({
    job_id: "job_draft",
    model_dir,
    case_id: "load_step",
    prefer_current_preview: true,
  })
  expect(selected).toEqual({ reference_preview: run?.reference_preview })
  expect(await readFile(join(model_dir, "current-preview", "evidence", "figures", "load_step.png"))).toEqual(
    await readFile(image_path),
  )
})
