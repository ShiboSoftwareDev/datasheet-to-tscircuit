import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getVerifiedSimulationArtifact,
  getVerifiedResultFile,
  hasCompleteVerifiedSimulationReport,
  verifySimulationBenchmark,
  writeSimulationValidationReport,
} from "@/server/model-simulation-validator"

const modelSource = ".subckt TEST IN OUT\nR1 IN OUT 1k\n.ends TEST\n"

function verifiedCircuit(probe_name: string, extra: Array<Record<string, unknown>>) {
  return [
    { type: "source_component", source_component_id: "dut", name: "DUT" },
    { type: "source_port", source_port_id: "dut_in", source_component_id: "dut", name: "IN" },
    { type: "source_port", source_port_id: "dut_out", source_component_id: "dut", name: "OUT" },
    {
      type: "simulation_spice_subcircuit",
      source_component_id: "dut",
      subcircuit_source: modelSource,
      spice_pin_to_source_port_map: { IN: "dut_in", OUT: "dut_out" },
    },
    { type: "simulation_voltage_probe", name: probe_name, signal_input_source_port_id: "dut_out" },
    ...extra,
  ]
}

test("simulation verification rejects solver errors and hashes extracted simulator curves", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-simulation-validation-"))
  const model_dir = join(job_dir, "spice")
  const circuit_dir = join(job_dir, "dist", "spice", "benchmarks", "transient")
  await Promise.all([
    mkdir(join(model_dir, "benchmarks"), { recursive: true }),
    mkdir(circuit_dir, { recursive: true }),
  ])
  await Bun.write(join(model_dir, "model.lib"), modelSource)
  await Bun.write(join(model_dir, "benchmarks", "transient.circuit.tsx"), "export default () => <board />\n")
  await Bun.write(
    join(model_dir, "benchmarks.json"),
    JSON.stringify({
      version: 1,
      locked_at: new Date().toISOString(),
      benchmarks: [
        {
          id: "transient",
          simulation: {
            kind: "transient_voltage",
            probe_name: "VOUT",
            scale: 2,
            offset: 1,
          },
        },
      ],
    }),
  )
  await Bun.write(
    join(circuit_dir, "circuit.json"),
    JSON.stringify(
      verifiedCircuit("VOUT", [
        {
          type: "simulation_unknown_experiment_error",
          message: "Singular matrix (real)",
        },
      ]),
    ),
  )

  const failed = await verifySimulationBenchmark({ model_dir, benchmark_id: "transient" })
  expect(failed.passed).toBe(false)
  expect(failed.error_message).toContain("Singular matrix")
  expect(
    await Bun.file(join(job_dir, ".model-validation", "benchmarks", "transient", "circuit.json")).exists(),
  ).toBe(true)

  const incomplete_mapping = verifiedCircuit("VOUT", [
    {
      type: "simulation_transient_voltage_graph",
      name: "VOUT",
      timestamps_ms: [0, 1],
      voltage_levels: [0, 1],
    },
  ])
  const incomplete_subcircuit = incomplete_mapping[3] as {
    spice_pin_to_source_port_map: Record<string, string>
  }
  incomplete_subcircuit.spice_pin_to_source_port_map = {
    IN: "dut_in",
  }
  await Bun.write(join(circuit_dir, "circuit.json"), JSON.stringify(incomplete_mapping))
  const incomplete = await verifySimulationBenchmark({ model_dir, benchmark_id: "transient" })
  expect(incomplete.error_message).toContain("cover every .SUBCKT pin")

  await Bun.write(
    join(circuit_dir, "circuit.json"),
    JSON.stringify(
      verifiedCircuit("VOUT", [
        {
          type: "pcb_missing_footprint_error",
          message: "No footprint specified for a simulation-only load",
        },
        {
          type: "simulation_transient_voltage_graph",
          name: "VOUT",
          timestamps_ms: [0, 0.5, 1],
          voltage_levels: [0, 1, 2],
        },
      ]),
    ),
  )
  const passed = await verifySimulationBenchmark({ model_dir, benchmark_id: "transient" })
  expect(passed.passed).toBe(true)
  expect(await Bun.file(join(model_dir, "results", "verified", "transient.csv")).text()).toBe(
    "x,y\n0,1\n0.5,3\n1,5\n",
  )
  await writeSimulationValidationReport(model_dir, [passed])
  expect(await hasCompleteVerifiedSimulationReport(model_dir)).toBe(true)
  expect(await getVerifiedResultFile(model_dir, "transient")).toBe("results/verified/transient.csv")
  expect(
    (await getVerifiedSimulationArtifact(model_dir, "transient"))?.circuit_json.some(
      (element) => element.type === "simulation_transient_voltage_graph",
    ),
  ).toBe(true)

  await Bun.write(join(model_dir, "results", "verified", "transient.csv"), "x,y\n0,999\n1,999\n")
  expect(await getVerifiedResultFile(model_dir, "transient")).toBe("results/verified/transient.csv")

  await Bun.write(join(job_dir, ".model-validation", "results", "transient.csv"), "x,y\n0,999\n1,999\n")
  expect(await getVerifiedResultFile(model_dir, "transient")).toBeUndefined()

  await Bun.write(join(model_dir, "model.lib"), modelSource.replace("1k", "2k"))
  expect(await hasCompleteVerifiedSimulationReport(model_dir)).toBe(false)

  await rm(job_dir, { recursive: true, force: true })
})

test("parameter sweeps reuse one circuit and combine separately persisted runs", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-parameter-sweep-"))
  const model_dir = join(job_dir, "spice")
  const output_dir = join(job_dir, "outputs")
  await Promise.all([
    mkdir(join(model_dir, "benchmarks"), { recursive: true }),
    mkdir(output_dir, { recursive: true }),
  ])
  await Bun.write(join(model_dir, "benchmarks", "sweep.circuit.tsx"), "export default () => <board />\n")
  await Bun.write(join(model_dir, "model.lib"), modelSource)
  await Bun.write(
    join(model_dir, "benchmarks.json"),
    JSON.stringify({
      version: 1,
      benchmarks: [
        {
          id: "sweep",
          simulation: {
            kind: "parameter_sweep",
            probe_name: "RESULT",
            reducer: "last",
            points: [
              { x: 0, props: { sweepValue: 0 } },
              { x: 1, props: { sweepValue: 1 } },
            ],
          },
        },
      ],
    }),
  )
  const make = (value: number) =>
    JSON.stringify(
      verifiedCircuit("RESULT", [
        {
          type: "simulation_transient_voltage_graph",
          name: "RESULT",
          timestamps_ms: [0, 1],
          voltage_levels: [0, value],
        },
      ]),
    )
  const first = join(output_dir, "point-000.json")
  const second = join(output_dir, "point-001.json")
  await Bun.write(first, make(2))
  await Bun.write(second, make(4))
  const result = await verifySimulationBenchmark({
    model_dir,
    benchmark_id: "sweep",
    circuit_json_paths: [
      { path: first, x: 0 },
      { path: second, x: 1 },
    ],
  })
  expect(result.passed).toBe(true)
  expect(await Bun.file(join(model_dir, "results", "verified", "sweep.csv")).text()).toBe("x,y\n0,2\n1,4\n")
  await rm(job_dir, { recursive: true, force: true })
})

test("legacy probe sweeps are rejected with a migration message", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-legacy-sweep-"))
  const model_dir = join(job_dir, "spice")
  await mkdir(join(model_dir, "benchmarks"), { recursive: true })
  await mkdir(join(job_dir, "dist", "spice", "benchmarks", "old"), { recursive: true })
  await Bun.write(join(model_dir, "model.lib"), modelSource)
  await Bun.write(
    join(model_dir, "benchmarks.json"),
    JSON.stringify({
      benchmarks: [{ id: "old", simulation: { kind: "probe_sweep", points: [{ x: 0 }, { x: 1 }] } }],
    }),
  )
  await Bun.write(join(model_dir, "benchmarks", "old.circuit.tsx"), "export default () => <board />\n")
  await Bun.write(join(job_dir, "dist", "spice", "benchmarks", "old", "circuit.json"), "[]")
  const result = await verifySimulationBenchmark({ model_dir, benchmark_id: "old" })
  expect(result.error_message).toContain("use parameter_sweep")
  await rm(job_dir, { recursive: true, force: true })
})
