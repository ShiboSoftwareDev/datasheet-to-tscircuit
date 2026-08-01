import { expect, test } from "bun:test"
import { BunProcessRunner } from "@/server/infrastructure/process"
import { buildValidationCircuitPreviews } from "@/server/model-workflow/validation-circuit-previews"
import { createModelManifest, projectModelCircuitPreview, type GeneratedModel } from "@/server/modeling"
import type { ValidationPlan } from "@/server/spice-validation"

const tsci_path = Bun.which("tsci")
const testWithTsci = tsci_path ? test : test.skip

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
      id: "output-loading",
      title: "Output loading",
      requirement_ids: ["output_loading"],
      nets: [],
      fixtures: [
        {
          id: "RLOAD",
          type: "resistor",
          positive: "dut.OUT",
          negative: "gnd",
          resistance_ohms: 1_000,
        },
      ],
      analysis: { type: "operating_point" },
      observations: [
        {
          id: "VOUT",
          requirement_id: "output_loading",
          type: "voltage",
          positive: "dut.OUT",
          negative: "gnd",
          unit: "V",
          scale: "linear",
          reference: { type: "target", target: 0, tolerance: 0.01 },
        },
      ],
    },
  ],
}

testWithTsci("operating-point validation TSX builds a schematic Circuit JSON snapshot", async () => {
  const build = await buildValidationCircuitPreviews({
    model_dir: process.cwd(),
    plan,
    generated,
    tsci_bin: tsci_path ?? "tsci",
    process_runner: new BunProcessRunner(),
    signal: new AbortController().signal,
    append: () => undefined,
  })
  const circuit_json = build.circuit_json_by_case["output-loading"]
  expect(circuit_json?.length).toBeGreaterThan(0)

  const preview = projectModelCircuitPreview({
    validation_case: plan.cases[0]!,
    manifest: generated.manifest,
    model_source: generated.source,
    model_card: generated.card,
    updated_at: new Date().toISOString(),
    circuit_json,
  })
  expect(preview.build_status).toBe("ready")
  expect(preview.circuit_json?.length).toBeGreaterThan(0)
  expect(preview.error_message).toContain("operating_point")
})
