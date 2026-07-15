import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadModelSelectedPreview, startModelArtifactMonitor } from "@/server/model-artifact-monitor"
import { ModelRunStore } from "@/server/model-run-store"
import {
  verifySimulationBenchmark,
  writeSimulationValidationReport,
} from "@/server/model-simulation-validator"

test("model previews read persisted Circuit JSON and never rerun TSX on selection", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-artifacts-"))
  const model_dir = join(job_dir, "spice")
  const benchmark_dir = join(model_dir, "benchmarks")
  const evidence_dir = join(model_dir, "evidence", "curves")
  const transfer_output = join(job_dir, "dist", "spice", "benchmarks", "transfer", "circuit.json")
  const output_output = join(job_dir, "dist", "spice", "benchmarks", "output", "circuit.json")
  await Promise.all([
    mkdir(benchmark_dir, { recursive: true }),
    mkdir(evidence_dir, { recursive: true }),
    mkdir(join(job_dir, "dist", "spice", "benchmarks", "transfer"), { recursive: true }),
    mkdir(join(job_dir, "dist", "spice", "benchmarks", "output"), { recursive: true }),
  ])
  await Promise.all([
    Bun.write(join(benchmark_dir, "transfer.circuit.tsx"), "export default () => <board />\n"),
    Bun.write(join(benchmark_dir, "output.circuit.tsx"), "export default () => <board />\n"),
    Bun.write(join(evidence_dir, "transfer.csv"), "x,y\n0,0\n1,1\n"),
    Bun.write(join(evidence_dir, "output.csv"), "x,y\n0,1\n1,2\n"),
    Bun.write(join(model_dir, "model.lib"), "revision-one"),
    Bun.write(join(model_dir, "component-with-model.circuit.tsx"), "export default () => <chip />\n"),
    Bun.write(join(model_dir, "component.circuit.tsx"), "export default () => <chip />\n"),
    Bun.write(
      join(model_dir, "benchmarks.json"),
      JSON.stringify({
        version: 1,
        locked_at: new Date().toISOString(),
        benchmarks: [
          {
            id: "transfer",
            title: "Transfer curve",
            source: { page: 3 },
            critical: true,
            weight: 1,
            tolerance: 0.1,
            x_scale: "linear",
            y_scale: "linear",
            reference_file: "evidence/curves/transfer.csv",
            result_file: "results/champion/transfer.csv",
            simulation: { kind: "transient_voltage", probe_name: "RESULT" },
          },
          {
            id: "output",
            title: "Output response",
            source: { page: 4 },
            critical: false,
            weight: 1,
            tolerance: 0.1,
            x_scale: "linear",
            y_scale: "linear",
            reference_file: "evidence/curves/output.csv",
            result_file: "results/champion/output.csv",
            simulation: { kind: "transient_voltage", probe_name: "RESULT" },
          },
        ],
      }),
    ),
  ])
  await Promise.all([
    Bun.write(
      transfer_output,
      JSON.stringify([
        { type: "source_component", source_component_id: "transfer-revision-one" },
        {
          type: "simulation_transient_voltage_graph",
          name: "RESULT",
          timestamps_ms: [0, 1],
          voltage_levels: [0, 0.9],
        },
      ]),
    ),
    Bun.write(
      output_output,
      JSON.stringify([
        { type: "source_component", source_component_id: "output-revision-one" },
        {
          type: "simulation_transient_voltage_graph",
          name: "RESULT",
          timestamps_ms: [0, 1],
          voltage_levels: [1.1, 2.1],
        },
      ]),
    ),
  ])

  const store = new ModelRunStore()
  store.createModelRun({
    model_run_id: "model_1",
    job_id: "job_1",
    model_dir,
    effort_multiplier: 1,
    base_effort_ms: 1_000,
  })
  store.updateProgress("model_1", {
    sequence: 1,
    phase: "simulating",
    message: "Running transfer",
    updated_at: new Date().toISOString(),
    benchmark: { current: "transfer", completed: 0, total: 1 },
  })
  const monitor = startModelArtifactMonitor({
    model_run_id: "model_1",
    model_dir,
    model_run_store: store,
    interval_ms: 20,
  })

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Saved preview did not load")), 3_000)
    const unsubscribe = store.subscribe("model_1", (event) => {
      if (event.event_type !== "log" && event.model_run.circuit_preview?.build_status === "ready") {
        clearTimeout(timeout)
        unsubscribe?.()
        resolve()
      }
    })
  })
  const transfer_verification = await verifySimulationBenchmark({
    model_dir,
    benchmark_id: "transfer",
  })
  await writeSimulationValidationReport(model_dir, [transfer_verification])
  await monitor.sync()
  const model_run = store.getModelRun("model_1")
  expect(model_run?.circuit_preview?.source_file).toBe("benchmarks/transfer.circuit.tsx")
  expect(model_run?.circuit_preview?.snapshot_origin).toBe("server_validation")
  expect(model_run?.reference_preview?.title).toBe("Transfer curve")
  expect(model_run?.reference_preview?.result_points?.[1]).toEqual({ x: 1, y: 0.9 })
  expect(model_run?.preview_options.map((option) => option.benchmark_id)).toEqual(["output", "transfer"])

  const output_mtime_before = (await stat(output_output)).mtimeMs
  const selected_workspace_preview = await loadModelSelectedPreview({
    model_dir,
    benchmark_id: "output",
  })
  expect(selected_workspace_preview?.circuit_preview?.snapshot_origin).toBe("workspace")
  expect((await stat(output_output)).mtimeMs).toBe(output_mtime_before)
  expect(selected_workspace_preview?.reference_preview?.result_points).toBeUndefined()

  const output_verification = await verifySimulationBenchmark({ model_dir, benchmark_id: "output" })
  await writeSimulationValidationReport(model_dir, [transfer_verification, output_verification])
  const selected_verified_preview = await loadModelSelectedPreview({
    model_dir,
    benchmark_id: "output",
  })
  expect(selected_verified_preview?.circuit_preview?.snapshot_origin).toBe("server_validation")
  expect(selected_verified_preview?.reference_preview?.result_points?.[1]).toEqual({ x: 1, y: 2.1 })

  await Bun.write(join(model_dir, "model.lib"), "revision-two")
  await monitor.sync()
  expect(store.getModelRun("model_1")?.circuit_preview?.is_stale).toBe(true)
  expect(store.getModelRun("model_1")?.reference_preview?.is_stale).toBe(true)

  await Bun.sleep(5)
  await Bun.write(
    transfer_output,
    JSON.stringify([
      { type: "source_component", source_component_id: "transfer-revision-two" },
      {
        type: "simulation_transient_voltage_graph",
        name: "RESULT",
        timestamps_ms: [0, 1],
        voltage_levels: [0, 1],
      },
    ]),
  )
  await monitor.sync()
  const refreshed = store.getModelRun("model_1")?.circuit_preview
  expect(refreshed?.snapshot_origin).toBe("workspace")
  expect(refreshed?.is_stale).toBe(false)
  expect(
    (refreshed?.circuit_json?.[0] as { source_component_id?: string } | undefined)?.source_component_id,
  ).toBe("transfer-revision-two")

  monitor.stop()
  await rm(job_dir, { recursive: true, force: true })
})
