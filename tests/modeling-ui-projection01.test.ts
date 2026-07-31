import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  projectModelCircuitPreview,
  projectModelUi,
  renderValidationCaseTsx,
} from "@/server/modeling/ui-projection"
import { loadStoredModelPreview } from "@/server/modeling/ui-projection-storage"
import type { ValidationPlan, ValidationRunResult } from "@/server/spice-validation"
import type { ModelManifest, ModelSelectedPreview } from "@/shared/job-types"

const manifest: ModelManifest = {
  version: 1,
  part_number: "GENERIC-2PIN",
  dialect: "portable",
  entry_name: "GENERIC_2PIN",
  model_file: "model.lib",
  revision: "abc123",
  simulator: "ngspice",
  generated_at: "2026-07-31T10:00:00.000Z",
  pins: [
    { component_pin: "pin1", spice_node: "IN" },
    { component_pin: "pin2", spice_node: "OUT" },
  ],
}

const plan: ValidationPlan = {
  version: 1,
  model: { entry_name: "GENERIC_2PIN", pins: ["IN", "OUT"] },
  cases: [
    {
      id: "transfer",
      title: "Transfer curve",
      requirement_ids: ["transfer_behavior"],
      nets: [],
      fixtures: [
        {
          id: "input",
          type: "voltage_source",
          positive: "dut.IN",
          negative: "gnd",
          dc_volts: 0,
        },
        {
          id: "load",
          type: "resistor",
          positive: "dut.OUT",
          negative: "gnd",
          resistance_ohms: 1_000,
        },
      ],
      analysis: { type: "dc_sweep", source_id: "input", start: 0, stop: 2, step: 1 },
      observations: [
        {
          id: "output_voltage",
          requirement_id: "transfer_behavior",
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
              { x: 1, y: 1 },
              { x: 2, y: 2 },
            ],
          },
          evidence: {
            page: 8,
            image: "evidence/fig-4.png",
            metadata: { x_quantity: "Input voltage", x_unit: "V" },
          },
        },
      ],
    },
    {
      id: "supply_current",
      requirement_ids: ["supply_current_limit"],
      nets: [],
      fixtures: [
        {
          id: "supply",
          type: "voltage_source",
          positive: "dut.IN",
          negative: "gnd",
          dc_volts: 5,
        },
        {
          id: "load",
          type: "resistor",
          positive: "dut.OUT",
          negative: "gnd",
          resistance_ohms: 10_000,
        },
      ],
      analysis: { type: "operating_point" },
      observations: [
        {
          id: "input_current",
          requirement_id: "supply_current_limit",
          type: "current",
          element_id: "supply",
          unit: "A",
          scale: "linear",
          reference: { type: "bounds", max: 0.001 },
        },
      ],
    },
  ],
}

const result: ValidationRunResult = {
  version: 1,
  passed: false,
  hashes: { plan_sha256: "plan", model_sha256: "model", manifest_sha256: "manifest" },
  cases: [
    {
      case_id: "transfer",
      status: "passed",
      analysis: "dc_sweep",
      series: [
        {
          observation_id: "output_voltage",
          type: "voltage",
          unit: "V",
          scale: "linear",
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1.01 },
            { x: 2, y: 2 },
          ],
          passed: true,
          metrics: {
            sample_count: 3,
            normalized_rmse: 0.003,
            normalized_max_error: 0.005,
          },
          errors: [],
        },
      ],
      errors: [],
      elapsed_ms: 12,
      netlist_sha256: "transfer-netlist",
      raw_sha256: "transfer-raw",
    },
    {
      case_id: "supply_current",
      status: "failed",
      analysis: "operating_point",
      series: [
        {
          observation_id: "input_current",
          type: "current",
          unit: "A",
          scale: "linear",
          points: [{ x: 0, y: 0.002 }],
          passed: false,
          metrics: {
            sample_count: 1,
            normalized_rmse: 1,
            normalized_max_error: 1,
          },
          errors: [
            {
              kind: "comparison",
              code: "bounds_exceeded",
              message: "Current exceeds the documented limit",
            },
          ],
        },
      ],
      errors: [],
      elapsed_ms: 7,
      netlist_sha256: "current-netlist",
      raw_sha256: "current-raw",
    },
  ],
  errors: [],
}

test("new validation artifacts project deterministically into the existing model UI DTOs", () => {
  const projection = projectModelUi({
    plan,
    result,
    manifest,
    model_source: ".SUBCKT GENERIC_2PIN IN OUT\nR1 IN OUT 1k\n.ENDS GENERIC_2PIN\n",
    model_card: "# Generic transfer model\n\nA portable linear model.",
    updated_at: "2026-07-31T11:00:00.000Z",
    circuit_json_by_case: { transfer: [] },
  })

  expect(projection.validation.benchmark_count).toBe(2)
  expect(projection.validation.passing_count).toBe(1)
  expect(projection.validation.critical_count).toBe(2)
  expect(projection.validation.all_critical_passed).toBe(false)
  expect(projection.validation.score).toBeCloseTo(0.5015)
  expect(projection.validation.worst_normalized_error).toBe(1)
  expect(projection.validation.benchmarks[1]?.series?.[0]?.error_message ?? "").toContain("documented limit")

  expect(projection.preview_options).toEqual([
    {
      benchmark_id: "transfer",
      title: "Transfer curve",
      circuit_file: "validation/cases/transfer.circuit.tsx",
      reference_file: "evidence/fig-4.png",
      result_file: "validation-results.json",
    },
    {
      benchmark_id: "supply_current",
      title: "Supply Current",
      circuit_file: "validation/cases/supply_current.circuit.tsx",
      reference_file: "validation-plan.json",
      result_file: "validation-results.json",
    },
  ])

  const transfer = projection.selected_previews.transfer
  expect(transfer?.reference_preview).toMatchObject({
    benchmark_id: "transfer",
    source_file: "evidence/fig-4.png",
    x_axis_label: "Input voltage",
    x_axis_unit: "V",
    y_axis_label: "Voltage",
    y_axis_unit: "V",
    result_status: "verified",
    result_origin: "server_validation",
    matches_reference: true,
  })
  expect(transfer?.reference_preview?.reference_points[1]).toEqual({ x: 1, y: 1 })
  expect(transfer?.reference_preview?.result_points?.[1]).toEqual({ x: 1, y: 1.01 })
  expect(transfer?.circuit_preview?.build_status).toBe("source_ready")
  expect(transfer?.circuit_preview?.snapshot_origin).toBeUndefined()
  expect(transfer?.circuit_preview?.error_message).toContain("does not support dc_sweep")

  const source = transfer?.circuit_preview?.code ?? ""
  expect(source).toContain("Requirements: transfer_behavior")
  expect(source).toContain('spicePinMapping={{\n  "IN": "pin1",\n  "OUT": "pin2"\n}}')
  expect(source).toContain('<voltageprobe name="probe_output_voltage"')
  expect(source).toContain(".SUBCKT GENERIC_2PIN IN OUT")
  expect(source).not.toContain(".measure")
  expect(() => new Bun.Transpiler({ loader: "tsx" }).transformSync(source)).not.toThrow()

  const current_reference = projection.selected_previews.supply_current?.reference_preview
  expect(current_reference?.reference_points).toEqual([])
  expect(current_reference?.reference_bounds).toEqual({ max: 0.001 })
  expect(current_reference?.result_points).toEqual([{ x: 0, y: 0.002 }])
  expect(current_reference?.result_status).toBe("failed")
  expect(current_reference?.matches_reference).toBe(false)
})

test("faithful transient TSX includes exact voltage PULSE timing, probes, and analysis", () => {
  const validation_case: ValidationPlan["cases"][number] = {
    id: "pulse_response",
    requirement_ids: ["pulse_response"],
    nets: [],
    fixtures: [
      {
        id: "input",
        type: "voltage_source",
        positive: "dut.IN",
        negative: "gnd",
        dc_volts: 0,
        pulse: {
          low: 0,
          high: 3.3,
          delay: 0.0002,
          rise: 0.00001,
          fall: 0.00002,
          width: 0.001,
          period: 0.002,
        },
      },
      {
        id: "load",
        type: "resistor",
        positive: "dut.OUT",
        negative: "gnd",
        resistance_ohms: 1_000,
      },
    ],
    analysis: { type: "transient", step: 0.00001, stop: 0.004, start: 0.0001 },
    observations: [
      {
        id: "output_voltage",
        requirement_id: "pulse_response",
        type: "voltage",
        positive: "dut.OUT",
        negative: "gnd",
        unit: "V",
        scale: "linear",
        reference: { type: "target", target: 3.3, tolerance: 0.1 },
      },
      {
        id: "load_current",
        requirement_id: "pulse_response",
        type: "current",
        element_id: "load",
        unit: "A",
        scale: "linear",
        reference: { type: "bounds", max: 0.01 },
      },
    ],
  }
  const source = renderValidationCaseTsx({
    validation_case,
    manifest,
    model_source: ".SUBCKT GENERIC_2PIN IN OUT\nR1 IN OUT 1k\n.ENDS GENERIC_2PIN\n",
    model_card: "# Pulse model",
  })

  expect(source).toContain(
    '<voltagesource name="input" voltage="3.3V" waveShape="square" pulseDelay="0.0002s" riseTime="0.00001s" fallTime="0.00002s" pulseWidth="0.001s" period="0.002s" />',
  )
  expect(source).toContain(
    '<analogsimulation name="validation" duration="0.004s" timePerStep="0.00001s" startTime="0.0001s" spiceEngine="ngspice" graphIndependentAxes />',
  )
  expect(source).toContain('<voltageprobe name="probe_output_voltage" graphDisplayName="output_voltage"')
  expect(source).toContain('<ammeter name="probe_load_current" graphDisplayName="load_current"')
  expect(source).toContain('"type": "transient"')
  expect(source).toContain('"requirement_id": "pulse_response"')
  expect(() => new Bun.Transpiler({ loader: "tsx" }).transformSync(source)).not.toThrow()

  const preview = projectModelCircuitPreview({
    validation_case,
    manifest,
    model_source: ".SUBCKT GENERIC_2PIN IN OUT\nR1 IN OUT 1k\n.ENDS GENERIC_2PIN\n",
    model_card: "# Pulse model",
    updated_at: "2026-07-31T11:00:00.000Z",
    circuit_json: [],
  })
  expect(preview.build_status).toBe("ready")
  expect(preview.snapshot_origin).toBe("server_validation")
})

test("unsupported current PULSE previews retain the exact contract without faking an analog run", () => {
  const validation_case: ValidationPlan["cases"][number] = {
    id: "current_pulse",
    requirement_ids: ["pulse_response"],
    nets: [],
    fixtures: [
      {
        id: "drive",
        type: "current_source",
        positive: "dut.IN",
        negative: "gnd",
        dc_amps: 0,
        pulse: { low: 0, high: 0.01, delay: 0.1, rise: 0.01, fall: 0.02, width: 0.2, period: 1 },
      },
      {
        id: "load",
        type: "resistor",
        positive: "dut.OUT",
        negative: "gnd",
        resistance_ohms: 1_000,
      },
    ],
    analysis: { type: "transient", step: 0.01, stop: 1 },
    observations: [
      {
        id: "output_voltage",
        requirement_id: "pulse_response",
        type: "voltage",
        positive: "dut.OUT",
        negative: "gnd",
        unit: "V",
        scale: "linear",
        reference: { type: "target", target: 1, tolerance: 0.1 },
      },
    ],
  }
  const preview = projectModelCircuitPreview({
    validation_case,
    manifest,
    model_source: ".SUBCKT GENERIC_2PIN IN OUT\nR1 IN OUT 1k\n.ENDS GENERIC_2PIN\n",
    model_card: "# Current pulse model",
    updated_at: "2026-07-31T11:00:00.000Z",
    circuit_json: [],
  })

  expect(preview.build_status).toBe("source_ready")
  expect(preview.circuit_json).toBeUndefined()
  expect(preview.error_message).toContain("currentsource does not expose exact PULSE")
  expect(preview.code).toContain('"delay": 0.1')
  expect(preview.code).not.toContain("<analogsimulation")
  expect(preview.code).not.toContain('waveShape="square"')
})

test("cancelled cases are not presented as verified comparisons", () => {
  const transfer_result = result.cases[0]
  if (!transfer_result) throw new Error("transfer result fixture is missing")
  const cancelled: ValidationRunResult = {
    ...result,
    cases: [
      {
        ...transfer_result,
        status: "cancelled",
        errors: [{ kind: "cancelled", code: "aborted", message: "Validation was cancelled" }],
      },
    ],
  }
  const preview = projectModelUi({
    plan,
    result: cancelled,
    manifest,
    model_source: ".SUBCKT GENERIC_2PIN IN OUT\nR1 IN OUT 1k\n.ENDS GENERIC_2PIN\n",
    model_card: "# Generic transfer model",
    updated_at: "2026-07-31T11:00:00.000Z",
  }).selected_previews.transfer?.reference_preview

  expect(preview?.result_status).toBe("cancelled")
  expect(preview?.matches_reference).toBeUndefined()
})

test("stored previews are loaded from their per-case files", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "model-preview-storage-"))
  const cases_dir = join(model_dir, "validation", "cases")
  await mkdir(cases_dir, { recursive: true })
  const selected_preview: ModelSelectedPreview = {
    reference_preview: {
      title: "Direct case preview",
      source_file: "validation-plan.json",
      x_scale: "linear",
      y_scale: "linear",
      reference_points: [],
      updated_at: "2026-07-31T11:00:00.000Z",
    },
  }
  await Promise.all([
    Bun.write(join(cases_dir, "transfer.preview.json"), JSON.stringify(selected_preview)),
    Bun.write(join(cases_dir, "transfer-wide.preview.json"), JSON.stringify(selected_preview)),
    Bun.write(
      join(model_dir, "model-ui.json"),
      JSON.stringify({ selected_previews: { transfer: { reference_preview: { title: "stale" } } } }),
    ),
  ])

  expect(await loadStoredModelPreview({ job_id: "preview-job", model_dir, case_id: "transfer" })).toEqual(
    selected_preview,
  )
  expect(
    await loadStoredModelPreview({ job_id: "preview-job", model_dir, case_id: "transfer-wide" }),
  ).toEqual(selected_preview)
  expect(
    await loadStoredModelPreview({ job_id: "preview-job", model_dir, case_id: "../model-ui" }),
  ).toBeUndefined()
  await rm(model_dir, { recursive: true, force: true })
})

test("TSX comments cannot be terminated by model-card text", () => {
  const validation_case = plan.cases[0]
  if (!validation_case) throw new Error("transfer validation case fixture is missing")
  const source = renderValidationCaseTsx({
    validation_case,
    manifest,
    model_source: ".SUBCKT GENERIC_2PIN IN OUT\n.ENDS\n",
    model_card: "# title */ injected",
  })
  expect(source).toContain("Model card: title * / injected")
  expect(source.match(/\*\//g)).toHaveLength(1)
})
