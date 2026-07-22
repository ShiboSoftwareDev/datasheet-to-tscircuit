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

const modelSourceOne = ".subckt TEST IN OUT\nR1 IN OUT 1k\n.ends TEST\n"
const modelSourceTwo = ".subckt TEST IN OUT\nR1 IN OUT 2k\n.ends TEST\n"

function verifiedCircuit(
  model_source: string,
  probe_name: string,
  component_id: string,
  voltage_levels: number[],
) {
  return [
    { type: "source_component", source_component_id: "dut", name: "DUT" },
    { type: "source_port", source_port_id: "dut_in", source_component_id: "dut", name: "IN" },
    { type: "source_port", source_port_id: "dut_out", source_component_id: "dut", name: "OUT" },
    {
      type: "simulation_spice_subcircuit",
      source_component_id: "dut",
      subcircuit_source: model_source,
      spice_pin_to_source_port_map: { IN: "dut_in", OUT: "dut_out" },
    },
    { type: "simulation_voltage_probe", name: probe_name, signal_input_source_port_id: "dut_out" },
    { type: "source_component", source_component_id: component_id },
    {
      type: "simulation_transient_voltage_graph",
      name: probe_name,
      timestamps_ms: [0, 1],
      voltage_levels,
    },
  ]
}

test("model previews never expose server benchmark-stub simulations", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-stub-preview-"))
  const model_dir = join(job_dir, "spice")
  const benchmark_dir = join(model_dir, "benchmarks")
  const evidence_dir = join(model_dir, "evidence", "curves")
  const output_dir = join(job_dir, "dist", "spice", "benchmarks", "startup")
  await Promise.all([
    mkdir(benchmark_dir, { recursive: true }),
    mkdir(evidence_dir, { recursive: true }),
    mkdir(output_dir, { recursive: true }),
  ])
  await Promise.all([
    Bun.write(join(benchmark_dir, "startup.circuit.tsx"), "export default () => <board />\n"),
    Bun.write(join(evidence_dir, "startup.csv"), "x,y\n0,0\n1,3.3\n"),
    Bun.write(
      join(model_dir, "benchmarks.json"),
      JSON.stringify({
        version: 1,
        benchmarks: [
          {
            id: "startup",
            title: "Startup",
            reference_file: "evidence/curves/startup.csv",
            simulation: {
              kind: "transient_voltage",
              x_axis: "time_ms",
              probe_name: "RESULT",
              dut_spice_node: "OUT",
            },
          },
        ],
      }),
    ),
    Bun.write(
      join(output_dir, "circuit.json"),
      JSON.stringify(
        verifiedCircuit(
          ".SUBCKT SERVER_BENCHMARK_STUB IN OUT\nR1 IN OUT 1G\n.ENDS SERVER_BENCHMARK_STUB\n",
          "RESULT",
          "stub",
          [0, 1e-10],
        ),
      ),
    ),
  ])

  const preview = await loadModelSelectedPreview({ model_dir, benchmark_id: "startup" })
  expect(preview?.circuit_preview?.build_status).toBe("source_ready")
  expect(preview?.circuit_preview?.circuit_json).toBeUndefined()
  expect(preview?.reference_preview?.result_points).toBeUndefined()

  await rm(job_dir, { recursive: true, force: true })
})

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
    Bun.write(join(model_dir, "model.lib"), modelSourceOne),
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
            simulation: {
              kind: "transient_voltage",
              x_axis: "time_ms",
              probe_name: "RESULT",
              dut_spice_node: "OUT",
            },
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
            simulation: {
              kind: "transient_voltage",
              x_axis: "time_ms",
              probe_name: "RESULT",
              dut_spice_node: "OUT",
            },
          },
        ],
      }),
    ),
  ])
  await Promise.all([
    Bun.write(
      transfer_output,
      JSON.stringify(verifiedCircuit(modelSourceOne, "RESULT", "transfer-revision-one", [0, 0.9])),
    ),
    Bun.write(
      output_output,
      JSON.stringify(verifiedCircuit(modelSourceOne, "RESULT", "output-revision-one", [1.1, 2.1])),
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
  expect(model_run?.reference_preview?.matches_reference).toBe(true)
  expect(model_run?.preview_options.map((option) => option.benchmark_id)).toEqual(["output", "transfer"])

  const output_mtime_before = (await stat(output_output)).mtimeMs
  const selected_workspace_preview = await loadModelSelectedPreview({
    model_dir,
    benchmark_id: "output",
  })
  expect(selected_workspace_preview?.circuit_preview?.snapshot_origin).toBe("workspace")
  expect((await stat(output_output)).mtimeMs).toBe(output_mtime_before)
  expect(selected_workspace_preview?.reference_preview?.result_points?.[1]).toEqual({ x: 1, y: 2.1 })
  expect(selected_workspace_preview?.reference_preview?.result_status).toBe("unverified")
  expect(selected_workspace_preview?.reference_preview?.result_origin).toBe("workspace")
  expect(selected_workspace_preview?.reference_preview?.normalized_rmse).toBeCloseTo(0.1)
  expect(selected_workspace_preview?.reference_preview?.normalized_max_error).toBeCloseTo(0.1)
  expect(selected_workspace_preview?.reference_preview?.matches_reference).toBe(false)
  expect(selected_workspace_preview?.reference_preview?.updated_at).toBe(
    selected_workspace_preview?.circuit_preview?.updated_at,
  )

  const output_verification = await verifySimulationBenchmark({ model_dir, benchmark_id: "output" })
  await writeSimulationValidationReport(model_dir, [transfer_verification, output_verification])
  const selected_verified_preview = await loadModelSelectedPreview({
    model_dir,
    benchmark_id: "output",
  })
  expect(selected_verified_preview?.circuit_preview?.snapshot_origin).toBe("server_validation")
  expect(selected_verified_preview?.reference_preview?.result_points?.[1]).toEqual({ x: 1, y: 2.1 })
  expect(selected_verified_preview?.reference_preview?.result_status).toBe("verified")
  expect(selected_verified_preview?.reference_preview?.result_origin).toBe("server_validation")
  expect(selected_verified_preview?.reference_preview?.updated_at).toBe(
    selected_verified_preview?.circuit_preview?.updated_at,
  )

  await Bun.write(
    join(benchmark_dir, "transfer.circuit.tsx"),
    'export default () => <board><resistor name="R1" resistance="2k" /></board>\n',
  )
  const stale_transfer_preview = await loadModelSelectedPreview({
    model_dir,
    benchmark_id: "transfer",
  })
  const unchanged_output_preview = await loadModelSelectedPreview({
    model_dir,
    benchmark_id: "output",
  })
  expect(stale_transfer_preview?.circuit_preview?.is_stale).toBe(true)
  expect(stale_transfer_preview?.reference_preview?.is_stale).toBe(true)
  expect(stale_transfer_preview?.reference_preview?.result_status).toBe("deprecated")
  expect(unchanged_output_preview?.reference_preview?.is_stale).toBe(false)
  expect(unchanged_output_preview?.reference_preview?.result_status).toBe("verified")
  await Bun.write(join(benchmark_dir, "transfer.circuit.tsx"), "export default () => <board />\n")

  await writeSimulationValidationReport(model_dir, [
    transfer_verification,
    {
      benchmark_id: "output",
      passed: false,
      status: "building",
      generated_at: new Date().toISOString(),
    },
  ])
  const selected_building_preview = await loadModelSelectedPreview({
    model_dir,
    benchmark_id: "output",
  })
  expect(selected_building_preview?.circuit_preview?.build_status).toBe("building")

  await writeSimulationValidationReport(model_dir, [
    transfer_verification,
    {
      benchmark_id: "output",
      passed: false,
      status: "failed",
      generated_at: new Date().toISOString(),
      error_message: "Could not identify connected source for VoltageProbe",
    },
  ])
  const selected_failed_preview = await loadModelSelectedPreview({
    model_dir,
    benchmark_id: "output",
  })
  expect(selected_failed_preview?.circuit_preview?.build_status).toBe("failed")
  expect(selected_failed_preview?.circuit_preview?.error_message).toContain("VoltageProbe")

  await rm(output_output, { force: true })
  await writeSimulationValidationReport(model_dir, [transfer_verification])
  const durable_output = join(model_dir, "validation-artifacts", "output", "runs", "default", "circuit.json")
  await mkdir(join(durable_output, ".."), { recursive: true })
  await Bun.write(
    durable_output,
    JSON.stringify(verifiedCircuit(modelSourceOne, "RESULT", "output-durable-run", [1, 2])),
  )
  const selected_durable_preview = await loadModelSelectedPreview({
    model_dir,
    benchmark_id: "output",
  })
  expect(selected_durable_preview?.circuit_preview?.snapshot_origin).toBe("workspace")
  expect(
    selected_durable_preview?.circuit_preview?.circuit_json?.some(
      (element) => (element as { source_component_id?: string }).source_component_id === "output-durable-run",
    ),
  ).toBe(true)

  await Bun.write(join(model_dir, "model.lib"), modelSourceTwo)
  await monitor.sync()
  expect(store.getModelRun("model_1")?.circuit_preview?.is_stale).toBe(true)
  expect(store.getModelRun("model_1")?.reference_preview?.is_stale).toBe(true)

  await Bun.sleep(5)
  await Bun.write(
    transfer_output,
    JSON.stringify(verifiedCircuit(modelSourceTwo, "RESULT", "transfer-revision-two", [0, 1])),
  )
  await monitor.sync()
  const refreshed = store.getModelRun("model_1")?.circuit_preview
  expect(refreshed?.snapshot_origin).toBe("workspace")
  expect(refreshed?.is_stale).toBe(false)
  expect(
    refreshed?.circuit_json?.some(
      (element) =>
        (element as { source_component_id?: string }).source_component_id === "transfer-revision-two",
    ),
  ).toBe(true)
  const refreshed_reference = store.getModelRun("model_1")?.reference_preview
  expect(refreshed_reference?.result_points?.[1]).toEqual({ x: 1, y: 1 })
  expect(refreshed_reference?.result_status).toBe("unverified")
  expect(refreshed_reference?.result_origin).toBe("workspace")
  expect(refreshed_reference?.updated_at).toBe(refreshed?.updated_at)

  monitor.stop()
  await rm(job_dir, { recursive: true, force: true })
})

test("model previews expose every channel from a multi-channel benchmark figure", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-multi-channel-preview-"))
  const model_dir = join(job_dir, "spice")
  const output_dir = join(job_dir, "dist", "spice", "benchmarks", "startup-sequence")
  try {
    await Promise.all([
      mkdir(join(model_dir, "benchmarks"), { recursive: true }),
      mkdir(join(model_dir, "evidence", "curves", "startup-sequence"), { recursive: true }),
      mkdir(output_dir, { recursive: true }),
    ])
    await Promise.all([
      Bun.write(
        join(model_dir, "benchmarks", "startup-sequence.circuit.tsx"),
        "export default () => <board />\n",
      ),
      Bun.write(
        join(model_dir, "benchmarks.json"),
        JSON.stringify({
          version: 2,
          benchmarks: [
            {
              id: "startup-sequence",
              title: "Startup sequence",
              x_scale: "linear",
              series: [
                {
                  id: "vout",
                  title: "Output voltage",
                  role: "response",
                  quantity: "voltage",
                  unit: "V",
                  reference_file: "evidence/curves/startup-sequence/vout.csv",
                  simulation: {
                    kind: "transient_voltage",
                    x_axis: "time_ms",
                    probe_name: "RESULT_VOUT",
                    dut_spice_node: "OUT",
                  },
                },
                {
                  id: "pg",
                  title: "Power-good response",
                  role: "response",
                  quantity: "voltage",
                  unit: "V",
                  reference_file: "evidence/curves/startup-sequence/pg.csv",
                  simulation: {
                    kind: "transient_voltage",
                    x_axis: "time_ms",
                    probe_name: "RESULT_PG",
                    dut_spice_node: "PG",
                  },
                },
                {
                  id: "vin",
                  title: "Input-voltage stimulus",
                  role: "stimulus",
                  quantity: "voltage",
                  unit: "V",
                  reference_file: "evidence/curves/startup-sequence/vin.csv",
                  simulation: {
                    kind: "transient_voltage",
                    x_axis: "time_ms",
                    probe_name: "STIMULUS_VIN",
                  },
                },
              ],
            },
          ],
        }),
      ),
      Bun.write(
        join(model_dir, "evidence", "curves", "startup-sequence", "vout.csv"),
        "x,y\n0,0\n1,1\n2,2\n",
      ),
      Bun.write(join(model_dir, "evidence", "curves", "startup-sequence", "pg.csv"), "x,y\n0,0\n1,0\n2,5\n"),
      Bun.write(join(model_dir, "evidence", "curves", "startup-sequence", "vin.csv"), "x,y\n0,0\n1,5\n2,5\n"),
      Bun.write(
        join(output_dir, "circuit.json"),
        JSON.stringify([
          {
            type: "simulation_transient_voltage_graph",
            name: "RESULT_VOUT",
            timestamps_ms: [0, 1, 2],
            voltage_levels: [0, 1, 2],
          },
          {
            type: "simulation_transient_voltage_graph",
            name: "RESULT_PG",
            timestamps_ms: [0, 1, 2],
            voltage_levels: [0, 0, 5],
          },
          {
            type: "simulation_transient_voltage_graph",
            name: "STIMULUS_VIN",
            timestamps_ms: [0, 1, 2],
            voltage_levels: [0, 5, 5],
          },
        ]),
      ),
    ])

    const selected = await loadModelSelectedPreview({
      model_dir,
      benchmark_id: "startup-sequence",
    })
    expect(selected?.reference_preview?.series?.map((series) => series.series_id)).toEqual([
      "vout",
      "pg",
      "vin",
    ])
    expect(selected?.reference_preview?.series?.map((series) => series.result_points?.[2]?.y)).toEqual([
      2, 5, 5,
    ])
    expect(selected?.reference_preview?.reference_points[2]).toEqual({ x: 2, y: 2 })
  } finally {
    await rm(job_dir, { recursive: true, force: true })
  }
})
