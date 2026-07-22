import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assertCanonicalDutSimulation,
  getAllCircuitErrors,
  getCircuitBuildDiagnostics,
  getVerifiedSimulationArtifact,
  getVerifiedResultFile,
  getVerifiedResultFiles,
  hasCompleteVerifiedSimulationReport,
  verifyPartialSimulationBenchmark,
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

test("circuit diagnostics treat semantic source errors as failures even when a build exits zero", () => {
  const diagnostics = getCircuitBuildDiagnostics([
    {
      type: "source_failed_to_create_component_error",
      message:
        'Invalid props for analogsimulation "SIM": simulationType Details: Props: { "simulationType": "transient" }',
    },
    {
      type: "source_failed_to_create_component_error",
      message:
        'Invalid props for analogsimulation "SIM": simulationType Details: Props: { "simulationType": "transient" }',
    },
  ])

  expect(diagnostics.source_errors).toEqual(['Invalid props for analogsimulation "SIM": simulationType'])
  expect(diagnostics.simulation_errors).toEqual([])
})

test("clean artifact validation reports every unique Circuit JSON error type", () => {
  const errors = getAllCircuitErrors([
    { type: "pcb_pad_pad_clearance_error", message: "C1 overlaps U1" },
    { type: "pcb_pad_pad_clearance_error", message: "C1 overlaps U1" },
    { type: "source_failed_to_create_component_error", message: "Invalid footprint" },
    { type: "source_component", source_component_id: "part", name: "U1" },
  ])

  expect(errors).toEqual([
    "pcb_pad_pad_clearance_error: C1 overlaps U1",
    "source_failed_to_create_component_error: Invalid footprint",
  ])
})

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
            x_axis: "time_ms",
            probe_name: "VOUT",
            dut_spice_node: "OUT",
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

  const manifest = JSON.parse(await Bun.file(join(model_dir, "benchmarks.json")).text())
  manifest.benchmarks[0].simulation.dut_spice_node = "IN"
  await Bun.write(join(model_dir, "benchmarks.json"), JSON.stringify(manifest))
  const directly_driven = verifiedCircuit("VOUT", [
    {
      type: "simulation_voltage_source",
      simulation_voltage_source_id: "stimulus",
      is_dc_source: true,
      positive_source_port_id: "stimulus_positive",
      negative_source_net_id: "ground",
      voltage: 1,
    },
    {
      type: "source_trace",
      connected_source_port_ids: ["stimulus_positive", "dut_in"],
      connected_source_net_ids: [],
    },
    {
      type: "simulation_transient_voltage_graph",
      name: "VOUT",
      timestamps_ms: [0, 1],
      voltage_levels: [0, 1],
    },
  ])
  ;(directly_driven[4] as { signal_input_source_port_id: string }).signal_input_source_port_id = "dut_in"
  await Bun.write(join(circuit_dir, "circuit.json"), JSON.stringify(directly_driven))
  const bypassed = await verifySimulationBenchmark({ model_dir, benchmark_id: "transient" })
  expect(bypassed.error_message).toContain("tied directly to an independent voltage source")
  manifest.benchmarks[0].simulation.dut_spice_node = "OUT"
  await Bun.write(join(model_dir, "benchmarks.json"), JSON.stringify(manifest))

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

test("a transient simulation publishes its complete waveform immediately", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-transient-waveform-"))
  const model_dir = join(job_dir, "spice")
  const output_dir = join(job_dir, "outputs")
  await Promise.all([
    mkdir(join(model_dir, "benchmarks"), { recursive: true }),
    mkdir(output_dir, { recursive: true }),
  ])
  await Bun.write(join(model_dir, "benchmarks", "waveform.circuit.tsx"), "export default () => <board />\n")
  await Bun.write(join(model_dir, "model.lib"), modelSource)
  await Bun.write(
    join(model_dir, "benchmarks.json"),
    JSON.stringify({
      version: 1,
      benchmarks: [
        {
          id: "waveform",
          simulation: {
            kind: "transient_voltage",
            x_axis: "time_ms",
            probe_name: "RESULT",
            dut_spice_node: "OUT",
          },
        },
      ],
    }),
  )
  const output = join(output_dir, "waveform.json")
  await Bun.write(
    output,
    JSON.stringify(
      verifiedCircuit("RESULT", [
        {
          type: "simulation_transient_voltage_graph",
          name: "RESULT",
          timestamps_ms: [0, 0.5, 1],
          voltage_levels: [0, 2, 4],
        },
      ]),
    ),
  )
  const partial = await verifyPartialSimulationBenchmark({
    model_dir,
    benchmark_id: "waveform",
    circuit_json_paths: [{ path: output }],
  })
  await writeSimulationValidationReport(model_dir, [partial])
  const partial_artifact = await getVerifiedSimulationArtifact(model_dir, "waveform")
  expect(partial.status).toBe("building")
  expect(partial_artifact?.status).toBe("building")
  expect(partial_artifact?.result_file).toBe("results/partial/waveform.csv")
  expect(partial_artifact?.result_text).toBe("x,y\n0,0\n0.5,2\n1,4\n")
  const result = await verifySimulationBenchmark({
    model_dir,
    benchmark_id: "waveform",
    circuit_json_paths: [{ path: output }],
  })
  expect(result.passed).toBe(true)
  expect(await Bun.file(join(model_dir, "results", "verified", "waveform.csv")).text()).toBe(
    "x,y\n0,0\n0.5,2\n1,4\n",
  )
  await rm(job_dir, { recursive: true, force: true })
})

test("non-transient simulation definitions are rejected", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-static-curve-"))
  const model_dir = join(job_dir, "spice")
  await mkdir(join(model_dir, "benchmarks"), { recursive: true })
  await mkdir(join(job_dir, "dist", "spice", "benchmarks", "old"), { recursive: true })
  await Bun.write(join(model_dir, "model.lib"), modelSource)
  await Bun.write(
    join(model_dir, "benchmarks.json"),
    JSON.stringify({
      benchmarks: [{ id: "old", simulation: { kind: "static_curve" } }],
    }),
  )
  await Bun.write(join(model_dir, "benchmarks", "old.circuit.tsx"), "export default () => <board />\n")
  await Bun.write(join(job_dir, "dist", "spice", "benchmarks", "old", "circuit.json"), "[]")
  const result = await verifySimulationBenchmark({ model_dir, benchmark_id: "old" })
  expect(result.error_message).toContain('must be "transient_voltage"')
  await rm(job_dir, { recursive: true, force: true })
})

test("one multi-channel simulator run is split into every declared series artifact", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-multi-channel-validation-"))
  const model_dir = join(job_dir, "spice")
  const circuit_dir = join(job_dir, "dist", "spice", "benchmarks", "startup-sequence")
  const multi_model_source = ".subckt TEST IN OUT PG\nR1 IN OUT 1k\nR2 OUT PG 1k\n.ends TEST\n"
  try {
    await Promise.all([
      mkdir(join(model_dir, "benchmarks"), { recursive: true }),
      mkdir(circuit_dir, { recursive: true }),
    ])
    await Promise.all([
      Bun.write(join(model_dir, "model.lib"), multi_model_source),
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
              series: [
                {
                  id: "vout",
                  role: "response",
                  simulation: {
                    kind: "transient_voltage",
                    x_axis: "time_ms",
                    probe_name: "RESULT_VOUT",
                    dut_spice_node: "OUT",
                  },
                },
                {
                  id: "pg",
                  role: "response",
                  simulation: {
                    kind: "transient_voltage",
                    x_axis: "time_ms",
                    probe_name: "RESULT_PG",
                    dut_spice_node: "PG",
                  },
                },
                {
                  id: "vin",
                  role: "stimulus",
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
    ])
    const circuit = [
      { type: "source_component", source_component_id: "dut", name: "DUT" },
      { type: "source_port", source_port_id: "dut_in", source_component_id: "dut", name: "IN" },
      { type: "source_port", source_port_id: "dut_out", source_component_id: "dut", name: "OUT" },
      { type: "source_port", source_port_id: "dut_pg", source_component_id: "dut", name: "PG" },
      {
        type: "simulation_spice_subcircuit",
        source_component_id: "dut",
        subcircuit_source: multi_model_source,
        spice_pin_to_source_port_map: { IN: "dut_in", OUT: "dut_out", PG: "dut_pg" },
      },
      { type: "simulation_voltage_probe", name: "RESULT_VOUT", signal_input_source_port_id: "dut_out" },
      { type: "simulation_voltage_probe", name: "RESULT_PG", signal_input_source_port_id: "dut_pg" },
      { type: "simulation_voltage_probe", name: "STIMULUS_VIN", signal_input_source_port_id: "dut_in" },
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
    ]
    await Bun.write(join(circuit_dir, "circuit.json"), JSON.stringify(circuit))

    const verification = await verifySimulationBenchmark({
      model_dir,
      benchmark_id: "startup-sequence",
    })
    expect(verification.passed).toBe(true)
    expect(verification.verified_result_files?.map((series) => series.series_id)).toEqual([
      "vout",
      "pg",
      "vin",
    ])
    await writeSimulationValidationReport(model_dir, [verification])
    expect(await getVerifiedResultFiles(model_dir, "startup-sequence")).toEqual({
      vout: "results/verified/startup-sequence/vout.csv",
      pg: "results/verified/startup-sequence/pg.csv",
      vin: "results/verified/startup-sequence/vin.csv",
    })
    expect((await getVerifiedSimulationArtifact(model_dir, "startup-sequence"))?.result_texts).toEqual({
      vout: "x,y\n0,0\n1,1\n2,2\n",
      pg: "x,y\n0,0\n1,0\n2,5\n",
      vin: "x,y\n0,0\n1,5\n2,5\n",
    })
    expect(await Bun.file(join(model_dir, "results", "verified", "startup-sequence", "vin.csv")).text()).toBe(
      "x,y\n0,0\n1,5\n2,5\n",
    )
  } finally {
    await rm(job_dir, { recursive: true, force: true })
  }
})

test("current validation rejects a voltage-forced DUT pin and verifies the physical sense path", () => {
  const physical_model = ".subckt TEST IN L1\nRPATH IN L1 1k\n.ends TEST\n"
  const circuit = [
    { type: "source_component", source_component_id: "dut", name: "DUT" },
    { type: "source_port", source_port_id: "dut_in", source_component_id: "dut", name: "IN" },
    { type: "source_port", source_port_id: "dut_l1", source_component_id: "dut", name: "L1" },
    {
      type: "simulation_spice_subcircuit",
      source_component_id: "dut",
      subcircuit_source: physical_model,
      spice_pin_to_source_port_map: { IN: "dut_in", L1: "dut_l1" },
    },
    {
      type: "source_component",
      source_component_id: "sense",
      name: "R_IL_SENSE",
      ftype: "simple_resistor",
      resistance: 0.01,
    },
    {
      type: "source_port",
      source_port_id: "sense_1",
      source_component_id: "sense",
      name: "pin1",
    },
    {
      type: "source_port",
      source_port_id: "sense_2",
      source_component_id: "sense",
      name: "pin2",
    },
    {
      type: "source_trace",
      connected_source_port_ids: ["dut_l1", "sense_1"],
      connected_source_net_ids: [],
    },
    {
      type: "simulation_voltage_probe",
      name: "RESULT_IL",
      signal_input_source_port_id: "sense_1",
      reference_input_source_port_id: "sense_2",
    },
  ] as any

  expect(() =>
    assertCanonicalDutSimulation({
      circuit_json: circuit,
      model_source: physical_model,
      probe_name: "RESULT_IL",
      dut_spice_node: "L1",
      sense_resistor: "R_IL_SENSE",
      scale: 100,
      unit: "A",
    }),
  ).not.toThrow()
  expect(() =>
    assertCanonicalDutSimulation({
      circuit_json: circuit,
      model_source: physical_model,
      probe_name: "RESULT_IL",
      dut_spice_node: "L1",
      sense_resistor: "R_IL_SENSE",
      scale: 1,
      unit: "A",
    }),
  ).toThrow("simulation.scale must equal 100")

  const forced_model = ".subckt TEST IN L1\nB_L1 L1 0 V={V(IN)}\n.ends TEST\n"
  circuit[3].subcircuit_source = forced_model
  expect(() =>
    assertCanonicalDutSimulation({
      circuit_json: circuit,
      model_source: forced_model,
      probe_name: "RESULT_IL",
      dut_spice_node: "L1",
      sense_resistor: "R_IL_SENSE",
      scale: 100,
      unit: "A",
    }),
  ).toThrow("forced directly by an internal voltage source")
})
