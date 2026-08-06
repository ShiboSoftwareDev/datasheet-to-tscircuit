import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelRunStore } from "@/server/model-run-store"
import { projectFoundReferencesUi } from "@/server/model-workflow/found-reference-ui"
import type { ReferenceGraphObservation } from "@/server/model-workflow/reference-graph-observation"
import { resolveDirectoryReferenceImage } from "@/server/modeling/reference-image"

const temporary_directories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

test("Find Reference Graphs publishes source references without comparison artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-reference-draft-"))
  temporary_directories.push(root)
  const model_dir = join(root, "spice")
  const evidence_dir = join(root, "evidence")
  const image_path = join(evidence_dir, "figures", "load_step.png")
  await Bun.write(image_path, new Uint8Array([137, 80, 78, 71]))
  await mkdir(join(model_dir, "current-preview"), { recursive: true })
  await Bun.write(join(model_dir, "current-preview", "stale-comparison.json"), "{}")

  const observation: ReferenceGraphObservation = {
    version: 1,
    source_pdf_sha256: "a".repeat(64),
    reviewed_hints: [],
    graphs: [
      {
        graph_id: "load_step",
        page: 7,
        locator: "Figure 7",
        x_axis: "time",
        time_axis_evidence: "100 us/div",
        response_quantity: "voltage",
        public_pin_observable: true,
        fixture_reproducible: true,
        reason: "Public output voltage under a supported load step.",
        crop: { page: 7, render_dpi: 200, x_px: 10, y_px: 20, width_px: 300, height_px: 200 },
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

  await projectFoundReferencesUi({
    model_run_store: store,
    model_run_id: "model_draft",
    model_dir,
    observation,
    evidence_dir,
    signal: new AbortController().signal,
  })

  const run = store.getModelRun("model_draft")
  expect(run?.found_references).toEqual([
    {
      reference_id: "load_step",
      title: "Figure 7",
      source_file: "evidence/figures/load_step.png",
      page: 7,
      figure: "Figure 7",
      x_axis_label: "Time",
      x_axis_unit: "s",
      updated_at: expect.any(String),
    },
  ])
  expect(run?.preview_options).toEqual([])
  expect(run?.circuit_preview).toBeUndefined()
  expect(run?.reference_preview).toBeUndefined()
  expect("reference_points" in (run?.found_references?.[0] ?? {})).toBe(false)
  expect(await stat(join(model_dir, "current-preview")).catch(() => undefined)).toBeUndefined()
  expect(
    JSON.parse(await readFile(join(model_dir, "found-references", "reference-index.json"), "utf8")),
  ).toMatchObject({
    references: [
      {
        benchmark_id: "load_step",
        sources: [{ page: 7, image: "evidence/figures/load_step.png" }],
      },
    ],
  })
  expect(
    await resolveDirectoryReferenceImage(join(model_dir, "found-references"), "load_step"),
  ).toMatchObject({
    benchmark_found: true,
    image: { file_name: "load_step.png", content_type: "image/png" },
  })
  expect(await readFile(join(model_dir, "found-references", "evidence", "figures", "load_step.png"))).toEqual(
    await readFile(image_path),
  )
})
