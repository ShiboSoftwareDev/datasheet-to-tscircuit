import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import { preflightModelPublicationUi } from "@/server/model-workflow/publication-ui-preflight"
import type { ModelUiProjection } from "@/server/modeling/ui-projection"
import { serializeStoredModelPreview } from "@/server/modeling/ui-projection-storage"
import type { ValidationPlan } from "@/server/spice-validation"
import type { ModelSelectedPreview } from "@/shared/job-types"

const plan: ValidationPlan = {
  version: 1,
  model: { entry_name: "UI_PREFLIGHT", pins: ["OUT"] },
  cases: [
    {
      id: "waveform",
      requirement_ids: ["waveform"],
      nets: [],
      fixtures: [],
      analysis: { type: "transient", step: 0.001, stop: 0.002 },
      observations: [
        {
          id: "output",
          requirement_id: "waveform",
          type: "voltage",
          positive: "dut.OUT",
          negative: "gnd",
          unit: "V",
          scale: "linear",
          reference: {
            type: "curve",
            tolerance: 0.05,
            points: [
              { x: 0, y: 0 },
              { x: 0.002, y: 1 },
            ],
          },
          evidence: { page: 1, image: "evidence/figures/waveform.png" },
        },
      ],
    },
  ],
}

function selectedPreview(): ModelSelectedPreview {
  const circuit_json = [
    {
      type: "simulation_experiment",
      simulation_experiment_id: "experiment_1",
      name: "validation",
      experiment_type: "spice_transient_analysis",
    },
    {
      type: "simulation_voltage_probe",
      simulation_voltage_probe_id: "probe_1",
      name: "probe_output",
    },
    {
      type: "simulation_transient_voltage_graph",
      simulation_transient_voltage_graph_id: "graph_1",
      simulation_experiment_id: "experiment_1",
      source_probe_id: "probe_1",
      timestamps_ms: [0, 1, 2],
      voltage_levels: [0, 0.5, 1],
      time_per_step: 1,
      start_time_ms: 0,
      end_time_ms: 2,
    },
  ] as AnyCircuitElement[]
  return {
    artifact_identity: {
      preview_generation: "accepted-preview-generation-01",
      model_revision: "a1b2c3d4e5f60718",
    },
    circuit_preview: {
      source_file: "validation/cases/waveform.circuit.tsx",
      code: "export default () => <board />\n",
      build_status: "ready",
      updated_at: "2026-08-01T00:00:00.000Z",
      circuit_json,
      analysis_type: "transient",
      analog_simulation_status: "available",
      snapshot_origin: "server_validation",
    },
    reference_preview: {
      benchmark_id: "waveform",
      title: "Waveform",
      source_file: "evidence/figures/waveform.png",
      x_axis_label: "time",
      x_axis_unit: "s",
      y_axis_unit: "V",
      x_scale: "linear",
      y_scale: "linear",
      reference_kind: "curve",
      reference_points: [
        { x: 0, y: 0 },
        { x: 0.002, y: 1 },
      ],
      result_points: [
        { x: 0, y: 0 },
        { x: 0.002, y: 1 },
      ],
      series: [
        {
          series_id: "output",
          title: "Output",
          role: "response",
          quantity: "voltage",
          unit: "V",
          source_file: "evidence/figures/waveform.png",
          y_scale: "linear",
          reference_kind: "curve",
          reference_points: [
            { x: 0, y: 0 },
            { x: 0.002, y: 1 },
          ],
          result_points: [
            { x: 0, y: 0 },
            { x: 0.002, y: 1 },
          ],
          matches_reference: true,
        },
      ],
      result_status: "verified",
      result_origin: "tscircuit_viewer",
      matches_reference: true,
      updated_at: "2026-08-01T00:00:00.000Z",
    },
  }
}

async function writeAcceptedUiFixture(include_reference = true) {
  const root = await mkdtemp(join(tmpdir(), "model-publication-ui-preflight-"))
  const cases_dir = join(root, "validation", "cases")
  const figures_dir = join(root, "evidence", "figures")
  await Promise.all([mkdir(cases_dir, { recursive: true }), mkdir(figures_dir, { recursive: true })])
  const preview = selectedPreview()
  const circuit_source = preview.circuit_preview?.code
  if (!circuit_source) throw new Error("UI preflight fixture is missing its circuit source")
  await Promise.all([
    Bun.write(join(root, "validation-plan.json"), `${JSON.stringify(plan, null, 2)}\n`),
    Bun.write(join(cases_dir, "waveform.preview.json"), serializeStoredModelPreview(preview)),
    Bun.write(join(cases_dir, "waveform.circuit.tsx"), circuit_source),
    ...(include_reference
      ? [Bun.write(join(figures_dir, "waveform.png"), new Uint8Array([137, 80, 78, 71, 1]))]
      : []),
  ])
  const projection = {
    validation: {},
    preview_options: [],
    selected_previews: { waveform: preview },
  } as unknown as ModelUiProjection
  return { root, projection }
}

test("publication UI preflight exercises the exact stored preview and reference-image path", async () => {
  const fixture = await writeAcceptedUiFixture()
  try {
    await expect(
      preflightModelPublicationUi({
        accepted_bundle: fixture.root,
        plan,
        projection: fixture.projection,
        fresh: true,
      }),
    ).resolves.toBeUndefined()
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test("publication UI preflight rejects a fresh bundle whose reference image cannot be served", async () => {
  const fixture = await writeAcceptedUiFixture(false)
  try {
    await expect(
      preflightModelPublicationUi({
        accepted_bundle: fixture.root,
        plan,
        projection: fixture.projection,
        fresh: true,
      }),
    ).rejects.toThrow(/cannot resolve its datasheet reference image/)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test("publication UI preflight applies the exact fresh accepted series contract", async () => {
  const fixture = await writeAcceptedUiFixture()
  try {
    const preview = fixture.projection.selected_previews.waveform
    if (!preview?.reference_preview) throw new Error("preflight fixture reference is missing")
    const invalid_preview: ModelSelectedPreview = {
      ...preview,
      reference_preview: { ...preview.reference_preview, series: undefined },
    }
    fixture.projection = {
      ...fixture.projection,
      selected_previews: { waveform: invalid_preview },
    }
    await Bun.write(
      join(fixture.root, "validation", "cases", "waveform.preview.json"),
      serializeStoredModelPreview(invalid_preview),
    )

    await expect(
      preflightModelPublicationUi({
        accepted_bundle: fixture.root,
        plan,
        projection: fixture.projection,
        fresh: true,
      }),
    ).rejects.toThrow(/primary response comparison series/)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})
