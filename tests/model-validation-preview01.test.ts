import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunProcessRunner } from "@/server/infrastructure/process"
import { TSCIRCUIT_RUNTIME_CONFIG } from "@/server/job-scaffold/tscircuit-runtime-config"
import { buildValidationCircuitPreviews } from "@/server/model-workflow/validation-circuit-previews"
import { createModelManifest, projectModelCircuitPreview, type GeneratedModel } from "@/server/modeling"
import type { ValidationPlan } from "@/server/spice-validation"
import { hasCompletedTransientSimulation } from "@/shared/model-preview-capabilities"

const tsci_path = Bun.which("tsci")
const ngspice_path = Bun.which("ngspice")
const testWithRealSimulation = tsci_path && ngspice_path ? test : test.skip

const model_interface = {
  version: 1 as const,
  part_number: "PREVIEW",
  entry_name: "PREVIEW",
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

const model_source = ".SUBCKT PREVIEW OUT\nR1 OUT 0 1k\n.ENDS PREVIEW\n"
const generated: GeneratedModel = {
  source: model_source,
  card: "# Preview model\n",
  manifest: createModelManifest({ model_interface, model_source, simulator: "ngspice" }),
}

const plan: ValidationPlan = {
  version: 1,
  model: { entry_name: "PREVIEW", pins: ["OUT"] },
  cases: [
    {
      id: "output-transient",
      title: "Output transient",
      requirement_ids: ["output_transient"],
      nets: [],
      fixtures: [
        {
          id: "drive",
          type: "voltage_source",
          positive: "dut.OUT",
          negative: "gnd",
          dc_volts: 0,
          pulse: {
            low: 0,
            high: 1,
            delay: 0.001,
            rise: 0.0001,
            fall: 0.0001,
            width: 0.001,
            period: 0.004,
          },
        },
      ],
      analysis: { type: "transient", step: 0.0001, stop: 0.003 },
      observations: [
        {
          id: "VOUT",
          requirement_id: "output_transient",
          type: "voltage",
          positive: "dut.OUT",
          negative: "gnd",
          unit: "V",
          scale: "linear",
          reference: {
            type: "curve",
            tolerance: 0.15,
            points: [
              { x: 0, y: 0 },
              { x: 0.001, y: 0 },
              { x: 0.0011, y: 1 },
              { x: 0.0021, y: 1 },
              { x: 0.0022, y: 0 },
              { x: 0.003, y: 0 },
            ],
          },
          evidence: {
            page: 1,
            image: "evidence/fig-output-transient.png",
            metadata: { x_quantity: "Time", x_unit: "s" },
          },
        },
      ],
    },
    {
      id: "load-transient",
      title: "Load transient",
      requirement_ids: ["load_transient"],
      nets: [],
      fixtures: [
        {
          id: "load_step",
          type: "current_source",
          positive: "gnd",
          negative: "dut.OUT",
          dc_amps: 0,
          pulse: {
            low: 0,
            high: 0.001,
            delay: 0.001,
            rise: 0.0001,
            fall: 0.0001,
            width: 0.001,
            period: 0.004,
          },
        },
      ],
      analysis: { type: "transient", step: 0.0001, stop: 0.003 },
      observations: [
        {
          id: "VOUT_LOAD",
          requirement_id: "load_transient",
          type: "voltage",
          positive: "dut.OUT",
          negative: "gnd",
          unit: "V",
          scale: "linear",
          reference: {
            type: "curve",
            tolerance: 0.15,
            points: [
              { x: 0, y: 0 },
              { x: 0.001, y: 0 },
              { x: 0.0011, y: 1 },
              { x: 0.0021, y: 1 },
              { x: 0.0022, y: 0 },
              { x: 0.003, y: 0 },
            ],
          },
          evidence: {
            page: 2,
            image: "evidence/fig-load-transient.png",
            metadata: { x_quantity: "Time", x_unit: "s" },
          },
        },
      ],
    },
    {
      id: "current-transient",
      title: "Supply current transient",
      requirement_ids: ["supply_current_transient"],
      nets: ["supply"],
      fixtures: [
        {
          id: "drive_current_case",
          type: "voltage_source",
          positive: "net.supply",
          negative: "gnd",
          dc_volts: 0,
          pulse: {
            low: 0,
            high: 1,
            delay: 0.001,
            rise: 0.0001,
            fall: 0.0001,
            width: 0.001,
            period: 0.004,
          },
        },
        {
          id: "sense",
          type: "resistor",
          positive: "net.supply",
          negative: "dut.OUT",
          resistance_ohms: 1_000,
        },
      ],
      analysis: { type: "transient", step: 0.0001, stop: 0.003 },
      observations: [
        {
          id: "ISUPPLY",
          requirement_id: "supply_current_transient",
          type: "current",
          element_id: "sense",
          unit: "A",
          scale: "linear",
          reference: {
            type: "curve",
            tolerance: 0.15,
            points: [
              { x: 0, y: 0 },
              { x: 0.001, y: 0 },
              { x: 0.0011, y: 0.0005 },
              { x: 0.0021, y: 0.0005 },
              { x: 0.0022, y: 0 },
              { x: 0.003, y: 0 },
            ],
          },
          evidence: {
            page: 3,
            image: "evidence/fig-current-transient.png",
            metadata: { x_quantity: "Time", x_unit: "s" },
          },
        },
      ],
    },
  ],
}

testWithRealSimulation(
  "validation TSX retains real voltage waveforms and rejects unsupported current graphs",
  async () => {
    const model_dir = await mkdtemp(join(tmpdir(), "model-validation-preview-"))
    try {
      await Promise.all([
        Bun.write(join(model_dir, "tscircuit.config.ts"), TSCIRCUIT_RUNTIME_CONFIG),
        Bun.write(join(model_dir, "tscircuit.config.json"), "{}\n"),
      ])
      const build = await buildValidationCircuitPreviews({
        model_dir,
        plan,
        generated,
        tsci_bin: tsci_path ?? "tsci",
        process_runner: new BunProcessRunner(),
        signal: new AbortController().signal,
        append: () => undefined,
      })
      const circuit_json = build.circuit_json_by_case["output-transient"]
      expect(build.errors_by_case["output-transient"]).toBeUndefined()
      expect(build.viewer_validation_by_case["output-transient"]?.passed).toBe(true)
      expect(build.viewer_validation_by_case["output-transient"]?.series[0]?.points.length).toBeGreaterThan(2)
      expect(circuit_json && hasCompletedTransientSimulation(circuit_json)).toBe(true)
      expect(circuit_json?.filter(({ type }) => type === "simulation_experiment")).toHaveLength(1)
      expect(circuit_json?.filter(({ type }) => type === "simulation_transient_voltage_graph")).toHaveLength(
        1,
      )

      const preview = projectModelCircuitPreview({
        validation_case: plan.cases[0]!,
        manifest: generated.manifest,
        model_source: generated.source,
        model_card: generated.card,
        updated_at: new Date().toISOString(),
        circuit_json,
      })
      expect(preview.build_status).toBe("ready")
      expect(preview.analysis_type).toBe("transient")
      expect(preview.analog_simulation_status).toBe("available")
      expect(preview.error_message).toBeUndefined()

      const load_circuit_json = build.circuit_json_by_case["load-transient"]
      expect(build.errors_by_case["load-transient"]).toBeUndefined()
      expect(build.viewer_validation_by_case["load-transient"]?.passed).toBe(true)
      expect(load_circuit_json && hasCompletedTransientSimulation(load_circuit_json)).toBe(true)

      const current_circuit_json = build.circuit_json_by_case["current-transient"]
      expect(build.errors_by_case["current-transient"]).toContain(
        "tscircuit does not currently emit a transient current graph",
      )
      expect(build.circuit_build_errors_by_case["current-transient"]).toBeUndefined()
      expect(build.viewer_validation_by_case["current-transient"]).toBeUndefined()
      expect(current_circuit_json && hasCompletedTransientSimulation(current_circuit_json)).toBe(false)
      expect(
        current_circuit_json?.filter(({ type }) => type === "simulation_transient_current_graph"),
      ).toHaveLength(0)
      expect(current_circuit_json?.filter(({ type }) => type === "simulation_current_probe")).toHaveLength(1)

      const unsupported_preview = projectModelCircuitPreview({
        validation_case: plan.cases[2]!,
        manifest: generated.manifest,
        model_source: generated.source,
        model_card: generated.card,
        updated_at: new Date().toISOString(),
        circuit_json: current_circuit_json,
      })
      expect(unsupported_preview.build_status).toBe("ready")
      expect(unsupported_preview.analog_simulation_status).toBe("unsupported")
      expect(unsupported_preview.circuit_json).toBe(current_circuit_json)
    } finally {
      await rm(model_dir, { recursive: true, force: true })
    }
  },
  30_000,
)
