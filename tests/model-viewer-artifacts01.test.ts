import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import {
  readVerifiedViewerCircuitJson,
  writeViewerValidationArtifacts,
} from "@/server/model-workflow/viewer-validation-artifacts"
import { createModelManifest, type GeneratedModel } from "@/server/modeling"
import type { ValidationPlan } from "@/server/spice-validation"

const model_interface = {
  version: 1 as const,
  part_number: "VIEWER-PROVENANCE",
  entry_name: "VIEWER_PROVENANCE",
  pins: [
    {
      physical_pin: "1",
      component_pin: "pin1",
      source_port_id: "source_port_1",
      spice_node: "OUT",
      labels: ["OUT"],
      role: "output",
    },
  ],
}
const model_source = ".SUBCKT VIEWER_PROVENANCE OUT\nR1 OUT 0 1k\n.ENDS VIEWER_PROVENANCE\n"
const generated: GeneratedModel = {
  source: model_source,
  card: "# Viewer provenance\n",
  manifest: createModelManifest({ model_interface, model_source, simulator: "ngspice" }),
}
const plan: ValidationPlan = {
  version: 1,
  model: { entry_name: "VIEWER_PROVENANCE", pins: ["OUT"] },
  cases: [
    {
      id: "startup",
      requirement_ids: ["startup"],
      nets: [],
      fixtures: [],
      analysis: { type: "transient", step: 0.001, stop: 0.002 },
      observations: [
        {
          id: "VOUT",
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
      type: "source_component",
      source_component_id: "dut",
      name: "DUT",
      manufacturer_part_number: generated.manifest.part_number,
    },
    {
      type: "source_port",
      source_port_id: "dut_out",
      source_component_id: "dut",
      name: "OUT",
      port_hints: ["pin1", "OUT"],
    },
    {
      type: "simulation_spice_subcircuit",
      simulation_spice_subcircuit_id: "dut_model",
      source_component_id: "dut",
      spice_pin_to_source_port_map: { OUT: "dut_out" },
      subcircuit_source: model_source,
    },
    {
      type: "simulation_experiment",
      simulation_experiment_id: "experiment_1",
      experiment_type: "spice_transient_analysis",
    },
    {
      type: "simulation_voltage_probe",
      simulation_voltage_probe_id: "probe_1",
      name: "probe_VOUT",
      signal_input_source_port_id: "dut_out",
    },
    {
      type: "simulation_transient_voltage_graph",
      simulation_transient_voltage_graph_id: "graph_1",
      simulation_experiment_id: "experiment_1",
      source_probe_id: "probe_1",
      name: "probe_VOUT",
      timestamps_ms: [0, 1, 2],
      voltage_levels: [0, 1, 2],
      time_per_step: 1,
      start_time_ms: 0,
      end_time_ms: 2,
    },
  ] as AnyCircuitElement[]
}

test("viewer artifacts bind retained Circuit JSON to immutable model inputs", async () => {
  const validation_dir = await mkdtemp(join(tmpdir(), "viewer-artifacts-"))
  try {
    await writeViewerValidationArtifacts({
      validation_dir,
      plan,
      generated,
      circuit_json_by_case: { startup: circuitJson() },
    })
    const verified = await readVerifiedViewerCircuitJson({ validation_dir, plan, generated })
    expect(verified.startup).toHaveLength(6)

    const altered = circuitJson()
    const graph = altered.find(({ type }) => type === "simulation_transient_voltage_graph") as
      | (AnyCircuitElement & { voltage_levels: number[] })
      | undefined
    if (graph) graph.voltage_levels = [0, 9, 9]
    await Bun.write(
      join(validation_dir, "cases", "startup.circuit.json"),
      `${JSON.stringify(altered, null, 2)}\n`,
    )
    await expect(readVerifiedViewerCircuitJson({ validation_dir, plan, generated })).rejects.toThrow(
      /does not match its viewer-validation receipt/,
    )
  } finally {
    await rm(validation_dir, { recursive: true, force: true })
  }
})

test("a perfect synthetic graph without the generated DUT model is rejected", async () => {
  const validation_dir = await mkdtemp(join(tmpdir(), "viewer-artifacts-forged-"))
  try {
    const forged = circuitJson().filter(
      ({ type }) => !["source_component", "source_port", "simulation_spice_subcircuit"].includes(type),
    )
    await writeViewerValidationArtifacts({
      validation_dir,
      plan,
      generated,
      circuit_json_by_case: { startup: forged },
    })
    await expect(readVerifiedViewerCircuitJson({ validation_dir, plan, generated })).rejects.toThrow(
      /unique DUT/,
    )
  } finally {
    await rm(validation_dir, { recursive: true, force: true })
  }
})
