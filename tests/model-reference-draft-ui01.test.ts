import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelRunStore } from "@/server/model-run-store"
import { projectComparisonGraphsUi } from "@/server/model-workflow/comparison-draft-ui"
import { projectFoundReferencesUi } from "@/server/model-workflow/found-reference-ui"
import type { ReferenceGraphObservation } from "@/server/model-workflow/reference-graph-observation"
import type { ModelContract } from "@/server/modeling"
import { resolveDirectoryReferenceImage } from "@/server/modeling/reference-image"
import type { ValidationPlan } from "@/server/spice-validation"

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

test("Create Comparison Graphs publishes one UI series for every graph channel", async () => {
  const root = await mkdtemp(join(tmpdir(), "model-comparison-draft-"))
  temporary_directories.push(root)
  const model_dir = join(root, "spice")
  const evidence_dir = join(root, "evidence")
  const source_file = "evidence/figures/multi-channel.png"
  await Bun.write(join(root, source_file), new Uint8Array([137, 80, 78, 71]))

  const channels = [
    { id: "output_voltage", role: "response", type: "voltage", unit: "V" },
    { id: "enable_voltage", role: "stimulus", type: "voltage", unit: "V" },
    { id: "power_good_voltage", role: "response", type: "voltage", unit: "V" },
    { id: "inductor_current", role: "response", type: "current", unit: "A" },
  ] as const
  const contract: ModelContract = {
    version: 1,
    interface: {
      version: 1,
      part_number: "MULTI",
      entry_name: "MULTI",
      pins: [],
    },
    characterization: {
      version: 1,
      family: "other",
      strategy: "behavioral",
      requirements: channels.map((channel) => ({
        requirement_id: `figure_1__${channel.id}`,
        title: channel.id,
        behavior: `Reproduce ${channel.id}`,
        analysis: "transient",
        support: { status: "modeled" },
        conditions: {},
        expected: { unit: channel.unit },
        reference_curve: {
          channel_id: channel.id,
          channel_role: channel.role,
          x_quantity: "time",
          x_unit: "s",
          y_quantity: channel.type,
          y_unit: channel.unit,
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
          image: source_file,
          crop: { page: 1, render_dpi: 200, x_px: 10, y_px: 20, width_px: 300, height_px: 200 },
        },
        sources: [{ page: 1, locator: "Figure 1", statement: channel.id }],
      })),
      assumptions: [],
      limitations: [],
    },
  }
  const plan: ValidationPlan = {
    version: 1,
    model: { entry_name: "MULTI", pins: [] },
    cases: [
      {
        id: "figure_1",
        requirement_ids: channels.map((channel) => `figure_1__${channel.id}`),
        nets: [],
        fixtures: [],
        analysis: { type: "transient", step: 0.01, stop: 1 },
        observations: channels.map((channel) =>
          channel.type === "voltage"
            ? {
                id: channel.id,
                requirement_id: `figure_1__${channel.id}`,
                role: channel.role,
                type: "voltage" as const,
                positive: "dut.OUT" as const,
                negative: "gnd" as const,
                unit: "V" as const,
                scale: "linear" as const,
                reference: {
                  type: "curve" as const,
                  tolerance: 0.05,
                  points: [
                    { x: 0, y: 0 },
                    { x: 1, y: 1 },
                  ],
                },
                evidence: { page: 1, image: source_file },
              }
            : {
                id: channel.id,
                requirement_id: `figure_1__${channel.id}`,
                role: channel.role,
                type: "current" as const,
                element_id: "load",
                unit: "A" as const,
                scale: "linear" as const,
                reference: {
                  type: "curve" as const,
                  tolerance: 0.05,
                  points: [
                    { x: 0, y: 0 },
                    { x: 1, y: 1 },
                  ],
                },
                evidence: { page: 1, image: source_file },
              },
        ),
      },
    ],
  }
  const store = new ModelRunStore()
  store.createModelRun({
    model_run_id: "model_comparison",
    job_id: "job_comparison",
    model_dir,
    effort_multiplier: 1,
  })

  await projectComparisonGraphsUi({
    model_run_store: store,
    model_run_id: "model_comparison",
    model_dir,
    contract,
    plan,
    evidence_dir,
    signal: new AbortController().signal,
  })

  const stored = JSON.parse(
    await readFile(join(model_dir, "current-preview", "cases", "figure_1.preview.json"), "utf8"),
  )
  expect(stored.reference_preview.series.map(({ series_id }: { series_id: string }) => series_id)).toEqual(
    channels.map(({ id }) => id),
  )
  expect(store.getModelRun("model_comparison")?.preview_options).toHaveLength(1)
  expect(store.getModelRun("model_comparison")?.reference_preview?.series).toHaveLength(4)
})
