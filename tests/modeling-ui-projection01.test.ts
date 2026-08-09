import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import type { ModelContract } from "@/server/modeling"
import { resolveBenchmarkReferenceImage } from "@/server/modeling/reference-image"
import {
  compactModelPreviewCircuitJson,
  createViewerCaseState,
  projectModelCircuitPreview,
  projectModelReferencePreview,
  projectModelUi,
  projectModelValidationSummary,
  renderValidationCaseTsx,
} from "@/server/modeling/ui-projection"
import {
  loadStoredModelPreview,
  MAX_STORED_MODEL_PREVIEW_BYTES,
  parseStoredModelPreviewBytes,
  serializeStoredModelPreview,
} from "@/server/modeling/ui-projection-storage"
import type { ViewerSimulationValidation } from "@/server/modeling/viewer-simulation"
import type { ValidationPlan, ValidationRunResult } from "@/server/spice-validation"
import type { ModelManifest, ModelSelectedPreview } from "@/shared/job-types"
import { hasCompletedTransientSimulation } from "@/shared/model-preview-capabilities"

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

const contract: ModelContract = {
  version: 1,
  interface: {
    version: 1,
    part_number: manifest.part_number,
    entry_name: manifest.entry_name,
    pins: manifest.pins.map((pin, index) => ({
      physical_pin: String(index + 1),
      component_pin: pin.component_pin,
      source_port_id: `source_port_${index + 1}`,
      spice_node: pin.spice_node,
      labels: [pin.spice_node],
      role: index === 0 ? "input" : "output",
    })),
  },
  characterization: {
    version: 1,
    family: "other",
    strategy: "behavioral",
    requirements: [
      {
        requirement_id: "transfer_behavior",
        title: "Transfer behavior",
        behavior: "Follow the transfer curve",
        analysis: "dc_sweep",
        support: { status: "modeled" },
        conditions: {},
        expected: { unit: "V", min: 0, max: 2 },
        reference_curve: {
          x_quantity: "Input voltage",
          x_unit: "V",
          y_quantity: "Output voltage",
          y_unit: "V",
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
            { x: 2, y: 2 },
          ],
        },
        sources: [{ page: 8, locator: "Figure 4", statement: "Transfer curve" }],
      },
      {
        requirement_id: "supply_current_limit",
        title: "Supply current limit",
        behavior: "Remain below the supply-current limit",
        analysis: "operating_point",
        support: { status: "modeled" },
        conditions: {},
        expected: { unit: "A", max: 0.001 },
        sources: [{ page: 3, locator: "Table 1", statement: "Supply current limit" }],
      },
    ],
    assumptions: [],
    limitations: [],
  },
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
    contract,
    preview_generation: "candidate-preview-generation-01",
  })

  expect(projection.validation.benchmark_count).toBe(2)
  expect(projection.validation.passing_count).toBe(1)
  expect(projection.validation.critical_count).toBe(2)
  expect(projection.validation.all_critical_passed).toBe(false)
  expect(projection.validation.score).toBeCloseTo(0.5015)
  expect(projection.validation.curve_score).toBeCloseTo(0.003)
  expect(projection.validation.curve_worst_normalized_error).toBeCloseTo(0.005)
  expect(projection.validation.scope).toMatchObject({
    curve_observation_count: 1,
    compared_curve_observation_count: 1,
    curve_sample_count: 3,
    quality: "curve_validated",
  })
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
  expect(transfer?.artifact_identity).toEqual({
    preview_generation: "candidate-preview-generation-01",
    model_revision: manifest.revision,
  })
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
  expect(current_reference?.result_status).toBe("verified")
  expect(current_reference?.matches_reference).toBe(false)
})

test("per-graph validation messages do not repeat another graph's aggregate errors", () => {
  const bounded_error = result.cases[1]?.series[0]?.errors[0]
  if (!bounded_error) throw new Error("Expected the bounds fixture error")
  const summary = projectModelValidationSummary(plan, {
    ...result,
    errors: [
      bounded_error,
      {
        kind: "comparison",
        code: "bound_stimulus_insensitive",
        message: "The simulated response does not depend on its stimulus",
      },
    ],
  })

  expect(summary.benchmarks[0]?.error_message).toContain("does not depend on its stimulus")
  expect(summary.benchmarks[0]?.error_message).not.toContain("documented limit")
  expect(summary.benchmarks[1]?.series?.[0]?.error_message).toContain("documented limit")
})

test("a declared curve with no finite result is reported as attempted, not validated", () => {
  const failed_result = structuredClone(result)
  const transfer = failed_result.cases[0]!
  transfer.status = "failed"
  transfer.series[0]!.points = []
  transfer.series[0]!.passed = false
  transfer.series[0]!.metrics = { sample_count: 0 }
  const projection = projectModelUi({
    plan,
    result: failed_result,
    manifest,
    model_source: ".SUBCKT GENERIC_2PIN IN OUT\nR1 IN OUT 1k\n.ENDS GENERIC_2PIN\n",
    model_card: "# Failed curve",
    updated_at: "2026-07-31T11:00:00.000Z",
    contract,
  })

  expect(projection.validation.curve_score).toBeUndefined()
  expect(projection.validation.scope).toMatchObject({
    curve_observation_count: 1,
    compared_curve_observation_count: 0,
    curve_sample_count: 0,
    quality: "curve_attempted",
  })
})

test("a direct ngspice pass cannot make candidate UI verified without a tscircuit waveform", () => {
  const transient_plan: ValidationPlan = {
    version: 1,
    model: plan.model,
    cases: [
      {
        id: "startup",
        requirement_ids: ["startup"],
        nets: [],
        fixtures: [
          {
            id: "input",
            type: "voltage_source",
            positive: "dut.IN",
            negative: "gnd",
            dc_volts: 1,
          },
          {
            id: "load",
            type: "resistor",
            positive: "dut.OUT",
            negative: "gnd",
            resistance_ohms: 1_000,
          },
        ],
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
  const direct_pass: ValidationRunResult = {
    version: 1,
    passed: true,
    hashes: result.hashes,
    cases: [
      {
        case_id: "startup",
        status: "passed",
        analysis: "transient",
        series: [
          {
            observation_id: "VOUT",
            type: "voltage",
            unit: "V",
            scale: "linear",
            points: [
              { x: 0, y: 0 },
              { x: 0.001, y: 1 },
              { x: 0.002, y: 2 },
            ],
            passed: true,
            metrics: { sample_count: 3, normalized_rmse: 0, normalized_max_error: 0 },
            errors: [],
          },
        ],
        errors: [],
        elapsed_ms: 1,
        netlist_sha256: "netlist",
        raw_sha256: "raw",
      },
    ],
    errors: [],
  }
  const transient_model_source = ".SUBCKT GENERIC_2PIN IN OUT\nR1 IN OUT 1k\n.ENDS GENERIC_2PIN\n"
  const project = (circuit_json?: AnyCircuitElement[]) =>
    projectModelUi({
      plan: transient_plan,
      result: direct_pass,
      manifest,
      model_source: transient_model_source,
      model_card: "# Startup",
      updated_at: "2026-08-01T00:00:00.000Z",
      circuit_json_by_case: circuit_json ? { startup: circuit_json } : {},
    })

  const missing = project()
  expect(missing.validation.all_passed).toBe(false)
  expect(missing.validation.passing_count).toBe(0)
  expect(missing.validation.benchmarks[0]?.error_message).toContain("required transient waveform")
  expect(missing.selected_previews.startup?.reference_preview).toMatchObject({
    result_status: "failed",
    result_origin: "tscircuit_viewer",
    result_points: undefined,
    matches_reference: false,
  })

  const mismatched_circuit_json = [
    {
      type: "source_component",
      source_component_id: "dut_1",
      name: "DUT",
      manufacturer_part_number: manifest.part_number,
    },
    {
      type: "source_port",
      source_port_id: "dut_in",
      source_component_id: "dut_1",
      name: "IN",
      port_hints: ["IN", "pin1"],
    },
    {
      type: "source_port",
      source_port_id: "dut_out",
      source_component_id: "dut_1",
      name: "OUT",
      port_hints: ["OUT", "pin2"],
    },
    {
      type: "simulation_spice_subcircuit",
      simulation_spice_subcircuit_id: "dut_model",
      source_component_id: "dut_1",
      spice_pin_to_source_port_map: { IN: "dut_in", OUT: "dut_out" },
      subcircuit_source: transient_model_source,
    },
    {
      type: "source_component",
      source_component_id: "input_component",
      name: "input",
      ftype: "simple_voltage_source",
      voltage: 1,
    },
    {
      type: "source_port",
      source_port_id: "input_pin1",
      source_component_id: "input_component",
      name: "pin1",
      port_hints: ["pin1", "1"],
    },
    {
      type: "source_port",
      source_port_id: "input_pin2",
      source_component_id: "input_component",
      name: "pin2",
      port_hints: ["pin2", "2"],
    },
    {
      type: "source_component",
      source_component_id: "load_component",
      name: "load",
      ftype: "simple_resistor",
      resistance: 1_000,
    },
    {
      type: "source_port",
      source_port_id: "load_pin1",
      source_component_id: "load_component",
      name: "pin1",
      port_hints: ["pin1", "1"],
    },
    {
      type: "source_port",
      source_port_id: "load_pin2",
      source_component_id: "load_component",
      name: "pin2",
      port_hints: ["pin2", "2"],
    },
    {
      type: "source_net",
      source_net_id: "ground",
      name: "GND",
      member_source_group_ids: [],
      is_ground: true,
    },
    {
      type: "source_trace",
      source_trace_id: "input_positive_trace",
      connected_source_port_ids: ["input_pin1", "dut_in"],
      connected_source_net_ids: [],
    },
    {
      type: "source_trace",
      source_trace_id: "input_negative_trace",
      connected_source_port_ids: ["input_pin2"],
      connected_source_net_ids: ["ground"],
    },
    {
      type: "source_trace",
      source_trace_id: "load_positive_trace",
      connected_source_port_ids: ["load_pin1", "dut_out"],
      connected_source_net_ids: [],
    },
    {
      type: "source_trace",
      source_trace_id: "load_negative_trace",
      connected_source_port_ids: ["load_pin2"],
      connected_source_net_ids: ["ground"],
    },
    {
      type: "simulation_experiment",
      simulation_experiment_id: "experiment_1",
      name: "validation",
      experiment_type: "spice_transient_analysis",
      time_per_step: 1,
      start_time_ms: 0,
      end_time_ms: 2,
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
      voltage_levels: [0, 0.1, 0.2],
      time_per_step: 1,
      start_time_ms: 0,
      end_time_ms: 2,
    },
  ] as AnyCircuitElement[]
  const mismatched = project(mismatched_circuit_json)
  expect(mismatched.validation.all_passed).toBe(false)
  expect(mismatched.selected_previews.startup?.reference_preview).toMatchObject({
    result_status: "verified",
    result_origin: "tscircuit_viewer",
    matches_reference: false,
  })
  expect(mismatched.selected_previews.startup?.reference_preview?.result_points).toHaveLength(3)
  expect(mismatched.selected_previews.startup?.circuit_preview).toMatchObject({
    build_status: "ready",
    analog_simulation_status: "available",
  })
  expect(mismatched.selected_previews.startup?.circuit_preview?.circuit_json).toHaveLength(18)

  const transient_case = transient_plan.cases[0]!
  expect(projectModelValidationSummary(transient_plan, direct_pass).all_passed).toBe(false)
  expect(
    projectModelReferencePreview({
      validation_case: transient_case,
      result: direct_pass,
      updated_at: "2026-08-01T00:00:00.000Z",
    }),
  ).toMatchObject({
    result_status: "failed",
    result_origin: "tscircuit_viewer",
    result_points: undefined,
    matches_reference: false,
  })

  const matching_circuit_json = structuredClone(mismatched_circuit_json)
  const matching_graph = matching_circuit_json.find(
    ({ type }) => type === "simulation_transient_voltage_graph",
  ) as (AnyCircuitElement & { voltage_levels: number[] }) | undefined
  if (!matching_graph) throw new Error("matching viewer graph fixture is missing")
  matching_graph.voltage_levels = [0, 1, 2]

  const matched_validation: ViewerSimulationValidation = {
    simulation_valid: true,
    passed: true,
    series: structuredClone(direct_pass.cases[0]!.series),
    errors: [],
  }
  const mismatched_validation = structuredClone(matched_validation)
  mismatched_validation.passed = false
  mismatched_validation.series[0]!.passed = false
  mismatched_validation.series[0]!.points[1]!.y = 0.1
  mismatched_validation.series[0]!.metrics = {
    sample_count: 3,
    normalized_rmse: 0.45,
    normalized_max_error: 0.9,
  }
  mismatched_validation.series[0]!.errors = [
    {
      kind: "comparison",
      code: "curve_mismatch",
      message: "The completed viewer waveform does not match the reference curve",
    },
  ]
  mismatched_validation.errors = [...mismatched_validation.series[0]!.errors]
  const partial_validation: ViewerSimulationValidation = {
    simulation_valid: true,
    passed: true,
    series: [],
    errors: [],
  }
  const projectAuthoritative = (
    viewer_state_by_case: NonNullable<Parameters<typeof projectModelUi>[0]["viewer_state_by_case"]>,
  ) =>
    projectModelUi({
      plan: transient_plan,
      result: direct_pass,
      manifest,
      model_source: transient_model_source,
      model_card: "# Startup",
      updated_at: "2026-08-01T00:00:00.000Z",
      circuit_json_by_case: { startup: matching_circuit_json },
      viewer_state_by_case,
    })
  const outcomes = Object.fromEntries(
    Object.entries({
      empty: projectAuthoritative({}),
      missing: projectAuthoritative({
        startup: { kind: "missing", message: "builder did not retain viewer status" },
      }),
      partial: projectAuthoritative({
        startup: { kind: "matched", validation: partial_validation },
      }),
      mismatched: projectAuthoritative({
        startup: createViewerCaseState({
          validation_case: transient_case,
          validation: mismatched_validation,
        }),
      }),
      matched: projectAuthoritative({
        startup: createViewerCaseState({
          validation_case: transient_case,
          validation: matched_validation,
        }),
      }),
    }).map(([name, projection]) => {
      const selected = projection.selected_previews.startup
      return [
        name,
        {
          all_passed: projection.validation.all_passed,
          result_status: selected?.reference_preview?.result_status,
          result_origin: selected?.reference_preview?.result_origin,
          result_point_count: selected?.reference_preview?.result_points?.length ?? 0,
          matches_reference: selected?.reference_preview?.matches_reference,
          analog_simulation_status: selected?.circuit_preview?.analog_simulation_status,
        },
      ]
    }),
  )
  expect(outcomes).toEqual({
    empty: {
      all_passed: false,
      result_status: "failed",
      result_origin: "tscircuit_viewer",
      result_point_count: 0,
      matches_reference: false,
      analog_simulation_status: "failed",
    },
    missing: {
      all_passed: false,
      result_status: "failed",
      result_origin: "tscircuit_viewer",
      result_point_count: 0,
      matches_reference: false,
      analog_simulation_status: "failed",
    },
    partial: {
      all_passed: false,
      result_status: "failed",
      result_origin: "tscircuit_viewer",
      result_point_count: 0,
      matches_reference: false,
      analog_simulation_status: "failed",
    },
    mismatched: {
      all_passed: false,
      result_status: "verified",
      result_origin: "tscircuit_viewer",
      result_point_count: 3,
      matches_reference: false,
      analog_simulation_status: "available",
    },
    matched: {
      all_passed: true,
      result_status: "verified",
      result_origin: "tscircuit_viewer",
      result_point_count: 3,
      matches_reference: true,
      analog_simulation_status: "available",
    },
  })

  const derived_matched = project(matching_circuit_json)
  expect(derived_matched.validation.all_passed).toBe(true)
  expect(derived_matched.selected_previews.startup?.reference_preview).toMatchObject({
    result_status: "verified",
    result_origin: "tscircuit_viewer",
    matches_reference: true,
  })

  const legacy_empty = projectModelUi({
    plan: transient_plan,
    result: direct_pass,
    manifest,
    model_source: transient_model_source,
    model_card: "# Startup",
    updated_at: "2026-08-01T00:00:00.000Z",
    circuit_json_by_case: { startup: matching_circuit_json },
    viewer_validation_by_case: {},
    viewer_errors_by_case: {},
  })
  expect(legacy_empty.validation.all_passed).toBe(false)
  expect(legacy_empty.selected_previews.startup?.reference_preview).toMatchObject({
    result_status: "failed",
    result_points: undefined,
    matches_reference: false,
  })

  const forged_circuit_json = mismatched.selected_previews.startup!.circuit_preview!.circuit_json!.filter(
    ({ type }) => !["source_component", "source_port", "simulation_spice_subcircuit"].includes(type),
  )
  const forged_graph = forged_circuit_json.find(
    ({ type }) => type === "simulation_transient_voltage_graph",
  ) as (AnyCircuitElement & { voltage_levels: number[] }) | undefined
  if (forged_graph) forged_graph.voltage_levels = [0, 1, 2]
  const forged = projectModelUi({
    plan: transient_plan,
    result: direct_pass,
    manifest,
    model_source: transient_model_source,
    model_card: "# Startup",
    updated_at: "2026-08-01T00:00:00.000Z",
    circuit_json_by_case: { startup: forged_circuit_json },
    viewer_validation_by_case: { startup: undefined },
    viewer_errors_by_case: {
      startup: "viewer_model_provenance_failed: validation graph is not bound to the generated DUT",
    },
  })
  expect(forged.validation.all_passed).toBe(false)
  expect(forged.validation.benchmarks[0]?.error_message).toContain("viewer_model_provenance_failed")
  expect(forged.selected_previews.startup?.reference_preview).toMatchObject({
    result_status: "failed",
    result_origin: "tscircuit_viewer",
    result_points: undefined,
    matches_reference: false,
  })
  expect(forged.selected_previews.startup?.circuit_preview).toMatchObject({
    build_status: "ready",
    analog_simulation_status: "failed",
  })
  expect(forged.selected_previews.startup?.circuit_preview?.circuit_json).toHaveLength(8)
  expect(forged.selected_previews.startup?.circuit_preview?.error_message).toContain(
    "viewer_model_provenance_failed",
  )
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
    ],
  }
  const source = renderValidationCaseTsx({
    validation_case,
    manifest,
    model_source: ".SUBCKT GENERIC_2PIN IN OUT\nR1 IN OUT 1k\n.ENDS GENERIC_2PIN\n",
    model_card: "# Pulse model",
  })

  expect(source).toContain("VDRIVE POS NEG DC 0 PULSE(0 3.3 0.0002 0.00001 0.00002 0.001 0.002)")
  expect(source).toContain('spicePinMapping={{"POS":"pin1","NEG":"pin2"}}')
  expect(source).toContain(
    '<analogsimulation name="validation" duration="0.004s" timePerStep="0.00001s" startTime="0.0001s" spiceEngine="ngspice" graphIndependentAxes />',
  )
  expect(source).toContain('<voltageprobe name="probe_output_voltage" graphDisplayName="output_voltage"')
  expect(source).not.toContain("<ammeter")
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
  expect(preview.build_status).toBe("source_ready")
  expect(preview.snapshot_origin).toBeUndefined()
  expect(preview.circuit_json).toBeUndefined()
})

test("current PULSE previews use an exact harness-local SPICE source", () => {
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
  expect(preview.snapshot_origin).toBeUndefined()
  expect(preview.error_message).toContain("produced no renderable Circuit JSON")
  expect(preview.code).toContain('"delay": 0.1')
  expect(preview.code).toContain("IDRIVE POS NEG DC 0 PULSE(0 0.01 0.1 0.01 0.02 0.2 1)")
  expect(preview.code).toContain("<analogsimulation")
  expect(preview.code).not.toContain('waveShape="square"')
})

test("a TSX build error cannot advertise a partial Circuit JSON snapshot as ready", () => {
  const validation_case = plan.cases[1]!
  const preview = projectModelCircuitPreview({
    validation_case,
    manifest,
    model_source: ".SUBCKT GENERIC_2PIN IN OUT\nR1 IN OUT 1k\n.ENDS GENERIC_2PIN\n",
    model_card: "# Failed preview build",
    updated_at: "2026-07-31T11:00:00.000Z",
    circuit_json: [{ type: "source_component", source_component_id: "partial" }] as AnyCircuitElement[],
    circuit_build_error: "source pin must be connected",
  })

  expect(preview.build_status).toBe("failed")
  expect(preview.circuit_json).toBeUndefined()
  expect(preview.snapshot_origin).toBeUndefined()
  expect(preview.error_message).toContain("source pin must be connected")
  expect(preview.code).toContain("ValidationCasePreview")
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
  const corrupt_generation = "candidate-preview-corrupt-01"
  const corrupt_cases_dir = join(model_dir, "current-previews", corrupt_generation, "cases")
  await Promise.all([mkdir(cases_dir, { recursive: true }), mkdir(corrupt_cases_dir, { recursive: true })])
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
      join(corrupt_cases_dir, "transfer.preview.json"),
      JSON.stringify({ reference_preview: { title: "forged current preview" } }),
    ),
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
  await expect(
    loadStoredModelPreview({
      job_id: "preview-job",
      model_dir,
      case_id: "transfer",
      current_preview_generation: corrupt_generation,
    }),
  ).rejects.toThrow(/current_preview_generation and current_model_revision must be provided together/)
  await expect(
    resolveBenchmarkReferenceImage({
      job_id: "preview-job",
      model_dir,
      benchmark_id: "transfer",
      current_preview_generation: corrupt_generation,
    }),
  ).rejects.toThrow(/current_preview_generation and current_model_revision must be provided together/)
  await expect(
    loadStoredModelPreview({
      job_id: "preview-job",
      model_dir,
      case_id: "transfer",
      current_preview_generation: corrupt_generation,
      current_model_revision: "c".repeat(16),
    }),
  ).rejects.toThrow(/Stored model preview transfer is invalid/)
  await expect(
    loadStoredModelPreview({
      job_id: "preview-job",
      model_dir,
      case_id: "transfer",
      require_accepted_publication: true,
    }),
  ).rejects.toThrow(/publish commit barrier/)
  await rm(model_dir, { recursive: true, force: true })
})

test("accepted-shaped previews compact two 20k-sample graphs below the production read boundary", () => {
  const sample_count = 20_000
  const timestamps_ms = Array.from({ length: sample_count }, (_, index) => index * 0.01)
  const final_timestamp_ms = timestamps_ms[sample_count - 1] ?? 0
  const first_levels = Array.from({ length: sample_count }, (_, index) => Math.sin(index / 200))
  const second_levels = Array.from({ length: sample_count }, (_, index) => Math.cos(index / 300))
  first_levels[1_234] = 25
  second_levels[17_654] = -30
  const compacted = compactModelPreviewCircuitJson([
    {
      type: "simulation_experiment",
      simulation_experiment_id: "experiment_1",
      name: "validation",
      experiment_type: "spice_transient_analysis",
    },
    {
      type: "simulation_voltage_probe",
      simulation_voltage_probe_id: "probe_1",
      name: "probe_first",
    },
    {
      type: "simulation_voltage_probe",
      simulation_voltage_probe_id: "probe_2",
      name: "probe_second",
    },
    {
      type: "simulation_transient_voltage_graph",
      simulation_transient_voltage_graph_id: "graph_1",
      simulation_experiment_id: "experiment_1",
      source_probe_id: "probe_1",
      timestamps_ms,
      voltage_levels: first_levels,
      time_per_step: 0.01,
      start_time_ms: 0,
      end_time_ms: final_timestamp_ms,
    },
    {
      type: "simulation_transient_voltage_graph",
      simulation_transient_voltage_graph_id: "graph_2",
      simulation_experiment_id: "experiment_1",
      source_probe_id: "probe_2",
      timestamps_ms,
      voltage_levels: second_levels,
      time_per_step: 0.01,
      start_time_ms: 0,
      end_time_ms: final_timestamp_ms,
    },
  ] as AnyCircuitElement[])
  const graphs = compacted.filter(
    (element) => element.type === "simulation_transient_voltage_graph",
  ) as Array<AnyCircuitElement & { timestamps_ms: number[]; voltage_levels: number[] }>
  expect(graphs).toHaveLength(2)
  expect(graphs.every(({ timestamps_ms }) => timestamps_ms.length <= 1_000)).toBe(true)
  expect(graphs[0]?.timestamps_ms[0]).toBe(0)
  expect(graphs[0]?.timestamps_ms.at(-1)).toBe(final_timestamp_ms)
  expect(graphs[0]?.voltage_levels).toContain(25)
  expect(graphs[1]?.voltage_levels).toContain(-30)
  expect(hasCompletedTransientSimulation(compacted)).toBe(true)

  const preview: ModelSelectedPreview = {
    artifact_identity: {
      preview_generation: "accepted-preview-generation-01",
      model_revision: "a1b2c3d4e5f60718",
    },
    circuit_preview: {
      source_file: "validation/cases/two_graphs.circuit.tsx",
      code: "export default () => <board />\n",
      build_status: "ready",
      updated_at: "2026-08-01T00:00:00.000Z",
      circuit_json: compacted,
      analysis_type: "transient",
      analog_simulation_status: "available",
      snapshot_origin: "server_validation",
    },
    reference_preview: {
      benchmark_id: "two_graphs",
      title: "Two graph transient",
      source_file: "evidence/figures/two_graphs.png",
      x_axis_label: "time",
      x_axis_unit: "s",
      y_axis_unit: "V",
      x_scale: "linear",
      y_scale: "linear",
      reference_kind: "curve",
      reference_points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      result_points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      series: [
        {
          series_id: "first",
          title: "First response",
          role: "response",
          quantity: "voltage",
          unit: "V",
          source_file: "evidence/figures/two_graphs.png",
          y_scale: "linear",
          reference_kind: "curve",
          reference_points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
          result_points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
          matches_reference: true,
        },
        {
          series_id: "second",
          title: "Second response",
          role: "response",
          quantity: "voltage",
          unit: "V",
          source_file: "evidence/figures/two_graphs.png",
          y_scale: "linear",
          reference_kind: "curve",
          reference_points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
          result_points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
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
  const bytes = new TextEncoder().encode(serializeStoredModelPreview(preview))
  expect(bytes.byteLength).toBeLessThan(MAX_STORED_MODEL_PREVIEW_BYTES)
  expect(parseStoredModelPreviewBytes(bytes)).toEqual(preview)
  expect(parseStoredModelPreviewBytes(bytes, { fresh_accepted: true })).toEqual(preview)

  const stimulus_graph_preview = structuredClone(preview)
  const stimulus_graph_series = stimulus_graph_preview.reference_preview?.series
  if (!stimulus_graph_series?.[1]) throw new Error("two-graph preview fixture is missing its second series")
  stimulus_graph_series[1].role = "stimulus"
  expect(
    parseStoredModelPreviewBytes(
      new TextEncoder().encode(serializeStoredModelPreview(stimulus_graph_preview)),
    ),
  ).toEqual(stimulus_graph_preview)

  const missing_graph_series = structuredClone(stimulus_graph_preview)
  const incomplete_series = missing_graph_series.reference_preview?.series
  if (!incomplete_series) throw new Error("two-graph preview fixture is missing its series")
  incomplete_series.pop()
  expect(() =>
    parseStoredModelPreviewBytes(new TextEncoder().encode(serializeStoredModelPreview(missing_graph_series))),
  ).toThrow(/2 transient graphs for 1 comparison series/)

  const failed_repair_non_time = structuredClone(preview)
  failed_repair_non_time.circuit_preview!.analog_simulation_status = "failed"
  failed_repair_non_time.reference_preview!.x_axis_label = "input voltage"
  expect(() =>
    parseStoredModelPreviewBytes(
      new TextEncoder().encode(serializeStoredModelPreview(failed_repair_non_time)),
    ),
  ).toThrow(/x-axis as time in seconds/)

  const failed_repair_repeated_time = structuredClone(preview)
  failed_repair_repeated_time.circuit_preview!.analog_simulation_status = "failed"
  failed_repair_repeated_time.reference_preview!.reference_points[1]!.x = 0
  expect(() =>
    parseStoredModelPreviewBytes(
      new TextEncoder().encode(serializeStoredModelPreview(failed_repair_repeated_time)),
    ),
  ).toThrow(/strictly increasing time axis/)

  const failed_repair_mismatched_primary = structuredClone(preview)
  failed_repair_mismatched_primary.circuit_preview!.analog_simulation_status = "failed"
  failed_repair_mismatched_primary.reference_preview!.result_points![1]!.y = 2
  expect(() =>
    parseStoredModelPreviewBytes(
      new TextEncoder().encode(serializeStoredModelPreview(failed_repair_mismatched_primary)),
    ),
  ).toThrow(/exactly mirror its primary response series/)

  const failed_viewer_without_curve_kind = structuredClone(preview)
  failed_viewer_without_curve_kind.circuit_preview!.analog_simulation_status = "failed"
  delete failed_viewer_without_curve_kind.reference_preview!.reference_kind
  expect(() =>
    parseStoredModelPreviewBytes(
      new TextEncoder().encode(serializeStoredModelPreview(failed_viewer_without_curve_kind)),
    ),
  ).toThrow(/must be curve for a tscircuit viewer result/)

  const legacy_scalar: ModelSelectedPreview = {
    reference_preview: {
      title: "Legacy scalar limit",
      source_file: "validation-plan.json",
      x_scale: "linear",
      y_scale: "linear",
      reference_kind: "target",
      reference_points: [{ x: 0, y: 3.3 }],
      updated_at: "2026-08-01T00:00:00.000Z",
    },
  }
  expect(
    parseStoredModelPreviewBytes(new TextEncoder().encode(serializeStoredModelPreview(legacy_scalar))),
  ).toEqual(legacy_scalar)

  const missing_identity = structuredClone(preview)
  delete missing_identity.artifact_identity
  expect(() =>
    parseStoredModelPreviewBytes(new TextEncoder().encode(serializeStoredModelPreview(missing_identity)), {
      fresh_accepted: true,
    }),
  ).toThrow(/artifact_identity is required/)

  const mismatched_primary = structuredClone(preview)
  mismatched_primary.reference_preview!.result_points![1]!.y = 2
  expect(() =>
    parseStoredModelPreviewBytes(new TextEncoder().encode(serializeStoredModelPreview(mismatched_primary)), {
      fresh_accepted: true,
    }),
  ).toThrow(/exactly mirror its primary response series/)

  const non_time_axis = structuredClone(preview)
  non_time_axis.reference_preview!.x_axis_label = "input voltage"
  expect(() =>
    parseStoredModelPreviewBytes(new TextEncoder().encode(serializeStoredModelPreview(non_time_axis)), {
      fresh_accepted: true,
    }),
  ).toThrow(/x-axis as time in seconds/)

  const repeated_reference_time = structuredClone(preview)
  repeated_reference_time.reference_preview!.reference_points![1]!.x = 0
  repeated_reference_time.reference_preview!.series![0]!.reference_points[1]!.x = 0
  expect(() =>
    parseStoredModelPreviewBytes(
      new TextEncoder().encode(serializeStoredModelPreview(repeated_reference_time)),
      { fresh_accepted: true },
    ),
  ).toThrow(/strictly increasing time axis/)

  const descending_timestamps = structuredClone(compacted)
  const first_graph = descending_timestamps.find(
    ({ type }) => type === "simulation_transient_voltage_graph",
  ) as (AnyCircuitElement & { timestamps_ms: number[] }) | undefined
  if (!first_graph) throw new Error("compacted graph fixture is missing")
  first_graph.timestamps_ms[1] = first_graph.timestamps_ms[0]!
  expect(hasCompletedTransientSimulation(descending_timestamps)).toBe(false)
})

test("preview graph compaction preserves Circuit JSON identity when it is a no-op", () => {
  const circuit_json = [
    {
      type: "simulation_transient_voltage_graph",
      simulation_transient_voltage_graph_id: "small_graph",
      simulation_experiment_id: "experiment_1",
      timestamps_ms: [0, 1],
      voltage_levels: [0, 1],
      time_per_step: 1,
      start_time_ms: 0,
      end_time_ms: 1,
    },
  ] as AnyCircuitElement[]

  expect(compactModelPreviewCircuitJson(circuit_json)).toBe(circuit_json)
})

test("the production preview parser fails closed above its exact API byte limit", () => {
  const oversized: ModelSelectedPreview = {
    circuit_preview: {
      source_file: "validation/cases/oversized.circuit.tsx",
      code: "x".repeat(MAX_STORED_MODEL_PREVIEW_BYTES),
      build_status: "source_ready",
      updated_at: "2026-08-01T00:00:00.000Z",
    },
  }
  const bytes = new TextEncoder().encode(serializeStoredModelPreview(oversized))
  expect(bytes.byteLength).toBeGreaterThan(MAX_STORED_MODEL_PREVIEW_BYTES)
  expect(() => parseStoredModelPreviewBytes(bytes)).toThrow(/production read limit/)
})

test("the production preview parser rejects forged nested and top-level shapes", () => {
  const timestamp = "2026-08-01T00:00:00.000Z"
  const valid = {
    reference_preview: {
      title: "Reference",
      source_file: "evidence/reference.png",
      x_scale: "linear",
      y_scale: "linear",
      reference_kind: "curve",
      reference_points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      updated_at: timestamp,
    },
  }
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

  expect(() =>
    parseStoredModelPreviewBytes(
      encode({ ...valid, hidden_preview_override: { analog_simulation_status: "available" } }),
    ),
  ).toThrow(/unexpected field hidden_preview_override/)
  expect(() =>
    parseStoredModelPreviewBytes(
      encode({
        reference_preview: {
          ...valid.reference_preview,
          reference_points: [{ x: 0, y: "not-a-number" }],
        },
      }),
    ),
  ).toThrow(/reference_points\[0\]\.y must be finite/)
})

test("an available stored simulation requires its TSX and reference comparison", () => {
  const forged = {
    circuit_preview: {
      source_file: "validation/cases/forged.circuit.tsx",
      code: "",
      build_status: "ready",
      updated_at: "2026-08-01T00:00:00.000Z",
      analysis_type: "transient",
      analog_simulation_status: "available",
      snapshot_origin: "server_validation",
      circuit_json: [
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
          timestamps_ms: [0, 1],
          voltage_levels: [0, 1],
          time_per_step: 1,
          start_time_ms: 0,
          end_time_ms: 1,
        },
      ],
    },
  }

  expect(() => parseStoredModelPreviewBytes(new TextEncoder().encode(JSON.stringify(forged)))).toThrow(
    /non-stale server-validated TSX/,
  )
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

test("validation TSX reserves SPICE ground identity for explicit fixture topology", () => {
  const ground_manifest: ModelManifest = {
    ...manifest,
    pins: [...manifest.pins, { component_pin: "pin3", spice_node: "GND" }],
  }
  const validation_case: ValidationPlan["cases"][number] = {
    ...plan.cases[0]!,
    analysis: { type: "transient", step: 0.001, stop: 0.002 },
    fixtures: [
      ...plan.cases[0]!.fixtures,
      {
        id: "ground_ref",
        type: "voltage_source",
        positive: "dut.GND",
        negative: "gnd",
        dc_volts: 0,
      },
    ],
  }
  const source = renderValidationCaseTsx({
    validation_case,
    manifest: ground_manifest,
    model_source: ".SUBCKT GENERIC_2PIN IN OUT GND\n.ENDS\n",
    model_card: "# Explicit ground fixture",
  })

  expect(source).toContain('"pin3": "DUT_GND"')
  expect(source).toContain('"GND": "pin3"')
  expect(source).toContain('<voltagesource name="ground_ref" voltage="0V" />')
  expect(source).toContain('<trace from=".ground_ref > .pin1" to=".DUT > .pin3" />')
})
