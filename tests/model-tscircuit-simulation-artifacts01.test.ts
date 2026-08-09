import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import {
  readTscircuitSimulationArtifacts,
  writeTscircuitSimulationArtifacts,
} from "@/server/model-workflow/tscircuit-simulation-artifacts"
import { createModelManifest, type GeneratedModel } from "@/server/modeling"
import type { ValidationPlan } from "@/server/spice-validation"

const model_interface = {
  version: 1 as const,
  part_number: "TSCIRCUIT-RESULT",
  entry_name: "TSCIRCUIT_RESULT",
  pins: [
    {
      physical_pin: "1",
      component_pin: "pin1",
      source_port_id: "source_port_out",
      spice_node: "OUT",
      labels: ["OUT"],
      role: "output",
    },
  ],
}
const model_source = ".SUBCKT TSCIRCUIT_RESULT OUT\nR1 OUT 0 1k\n.ENDS TSCIRCUIT_RESULT\n"
const generated: GeneratedModel = {
  source: model_source,
  card: "# tscircuit result fixture\n",
  manifest: createModelManifest({ model_interface, model_source, simulator: "ngspice" }),
}
const plan: ValidationPlan = {
  version: 1,
  model: { entry_name: "TSCIRCUIT_RESULT", pins: ["OUT"] },
  cases: [
    {
      id: "startup",
      requirement_ids: ["startup"],
      nets: [],
      fixtures: [],
      analysis: { type: "transient", step: 0.001, stop: 0.002 },
      observations: [
        {
          id: "output_voltage",
          requirement_id: "startup",
          type: "voltage",
          positive: "dut.OUT",
          negative: "gnd",
          unit: "V",
          scale: "linear",
          reference: {
            type: "curve",
            tolerance: 0.01,
            points: [
              { x: 0, y: 0 },
              { x: 0.001, y: 1 },
              { x: 0.002, y: 2 },
            ],
          },
        },
      ],
    },
  ],
}

function circuitJson(): AnyCircuitElement[] {
  return [
    {
      type: "simulation_experiment",
      simulation_experiment_id: "experiment_1",
      experiment_type: "spice_transient_analysis",
    },
    {
      type: "simulation_transient_voltage_graph",
      simulation_transient_voltage_graph_id: "graph_1",
      simulation_experiment_id: "experiment_1",
      source_probe_id: "probe_1",
      name: "output_voltage",
      timestamps_ms: [0, 1, 2],
      voltage_levels: [0, 1, 2],
      time_per_step: 1,
      start_time_ms: 0,
      end_time_ms: 2,
    },
  ] as unknown as AnyCircuitElement[]
}

test("tscircuit simulation artifacts retain raw Circuit JSON without comparison state", async () => {
  const simulation_dir = await mkdtemp(join(tmpdir(), "tscircuit-simulation-artifacts-"))
  try {
    const receipt_path = await writeTscircuitSimulationArtifacts({
      simulation_dir,
      plan,
      generated,
      simulations: {
        circuit_json_by_case: { startup: circuitJson() },
        circuit_build_errors_by_case: {},
        simulation_errors_by_case: {},
      },
    })
    const receipt = JSON.parse(await readFile(receipt_path, "utf8")) as Record<string, unknown>
    expect(Object.keys(receipt).sort()).toEqual(["cases", "hashes", "version"])
    expect(JSON.stringify(receipt)).not.toMatch(/passed|comparison|repair_feedback|failing_case_ids/)

    const restored = await readTscircuitSimulationArtifacts({ receipt_path, plan, generated })
    expect(restored.circuit_json_by_case.startup).toEqual(circuitJson())
    expect(restored.circuit_build_errors_by_case.startup).toBeUndefined()
    expect(restored.simulation_errors_by_case.startup).toBeUndefined()
  } finally {
    await rm(simulation_dir, { recursive: true, force: true })
  }
})

test("tscircuit simulation artifacts reject changed waveform data", async () => {
  const simulation_dir = await mkdtemp(join(tmpdir(), "tscircuit-simulation-tamper-"))
  try {
    const receipt_path = await writeTscircuitSimulationArtifacts({
      simulation_dir,
      plan,
      generated,
      simulations: {
        circuit_json_by_case: { startup: circuitJson() },
        circuit_build_errors_by_case: {},
        simulation_errors_by_case: {},
      },
    })
    const changed = circuitJson()
    const graph = changed[1] as AnyCircuitElement & { voltage_levels: number[] }
    graph.voltage_levels = [0, 9, 9]
    await Bun.write(
      join(simulation_dir, "cases", "startup.circuit.json"),
      `${JSON.stringify(changed, null, 2)}\n`,
    )

    await expect(readTscircuitSimulationArtifacts({ receipt_path, plan, generated })).rejects.toThrow(
      /does not match its tscircuit simulation receipt/,
    )
  } finally {
    await rm(simulation_dir, { recursive: true, force: true })
  }
})
