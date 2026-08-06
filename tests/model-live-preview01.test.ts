import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ModelCircuitPreview } from "@/shared/job-types"
import {
  collectModelPreviewLoadResults,
  getComparisonScaleDisparity,
  getGraphAxisLayout,
  getModelPreviewBundleScopeKey,
  getRunframeCircuitJson,
  hasRunnableAnalogPreviewBundle,
  hasRunnableAnalogSimulation,
  MODEL_ANALOG_ONLY_TABS,
  MODEL_SCHEMATIC_CODE_TABS,
  ModelLivePreview,
  ReferenceGraph,
} from "@/web/components/model-live-preview"

const previous_circuit_json: NonNullable<ModelCircuitPreview["circuit_json"]> = []
const live_circuit_json: NonNullable<ModelCircuitPreview["circuit_json"]> = []

test("the code tab keeps a stable Circuit JSON reference while live previews update", () => {
  expect(
    getRunframeCircuitJson({
      active_tab: "code",
      live_circuit_json,
      code_tab_circuit_json: previous_circuit_json,
    }),
  ).toBe(previous_circuit_json)
  expect(
    getRunframeCircuitJson({
      active_tab: "analog_simulation",
      live_circuit_json,
      code_tab_circuit_json: previous_circuit_json,
    }),
  ).toBe(live_circuit_json)
  expect(
    getRunframeCircuitJson({
      active_tab: "schematic",
      live_circuit_json,
      code_tab_circuit_json: previous_circuit_json,
    }),
  ).toBe(live_circuit_json)
})

test("the code tab uses live Circuit JSON until it has captured a snapshot", () => {
  expect(
    getRunframeCircuitJson({
      active_tab: "code",
      live_circuit_json: live_circuit_json as ModelCircuitPreview["circuit_json"],
      code_tab_circuit_json: undefined,
    }),
  ).toBe(live_circuit_json)
})

test("the TSX area separates schematic/code from graph-only analog simulation", () => {
  expect(MODEL_SCHEMATIC_CODE_TABS).toEqual(["code", "schematic"])
  expect(MODEL_ANALOG_ONLY_TABS).toEqual(["analog_simulation"])
  expect(MODEL_ANALOG_ONLY_TABS).not.toContain("schematic")
})

test("the analog viewer requires a completed tscircuit transient waveform", () => {
  const schematic_only: ModelCircuitPreview = {
    source_file: "validation/cases/operating-point.circuit.tsx",
    code: "export default () => <board />",
    build_status: "ready",
    updated_at: "2026-08-01T00:00:00.000Z",
    analysis_type: "operating_point",
    analog_simulation_status: "unsupported",
    circuit_json: [
      { type: "source_component", source_component_id: "source_component_1", name: "DUT" },
    ] as ModelCircuitPreview["circuit_json"],
  }
  const transient: ModelCircuitPreview = {
    ...schematic_only,
    analysis_type: "transient",
    analog_simulation_status: "available",
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
    ] as ModelCircuitPreview["circuit_json"],
  }
  const unsupported_current = {
    ...transient,
    circuit_json: [
      transient.circuit_json![0],
      {
        type: "simulation_transient_current_graph",
        simulation_transient_current_graph_id: "current_graph_1",
        simulation_experiment_id: "experiment_1",
        timestamps_ms: [0, 1],
        current_levels: [0, 1],
      },
    ] as ModelCircuitPreview["circuit_json"],
  }

  expect(hasRunnableAnalogSimulation(schematic_only)).toBe(false)
  expect(hasRunnableAnalogSimulation(transient)).toBe(true)
  expect(hasRunnableAnalogSimulation(unsupported_current)).toBe(false)
  expect(
    hasRunnableAnalogSimulation({
      ...transient,
      circuit_json: [
        ...transient.circuit_json!,
        {
          type: "simulation_transient_current_graph",
          simulation_transient_current_graph_id: "hidden_current_graph",
          simulation_experiment_id: "experiment_1",
          timestamps_ms: [0, 1],
          current_levels: [0, 1],
          time_per_step: 1,
          start_time_ms: 0,
          end_time_ms: 1,
        },
      ] as ModelCircuitPreview["circuit_json"],
    }),
  ).toBe(false)
  expect(
    hasRunnableAnalogSimulation({
      ...transient,
      circuit_json: [
        ...transient.circuit_json!,
        {
          type: "simulation_transient_voltage_graph",
          simulation_transient_voltage_graph_id: "unbound_graph",
          simulation_experiment_id: "experiment_1",
          source_probe_id: "unknown_probe",
          timestamps_ms: [0, 1],
          voltage_levels: [0, 1],
          time_per_step: 1,
          start_time_ms: 0,
          end_time_ms: 1,
        },
      ] as ModelCircuitPreview["circuit_json"],
    }),
  ).toBe(false)
  expect(
    hasRunnableAnalogSimulation({
      ...transient,
      circuit_json: [
        ...transient.circuit_json!,
        {
          type: "simulation_experiment",
          simulation_experiment_id: "hidden_operating_point",
          name: "hidden",
          experiment_type: "spice_dc_operating_point",
        },
      ] as ModelCircuitPreview["circuit_json"],
    }),
  ).toBe(false)
  expect(hasRunnableAnalogSimulation({ ...transient, analog_simulation_status: "failed" })).toBe(false)
  expect(hasRunnableAnalogSimulation({ ...transient, analog_simulation_status: undefined })).toBe(false)
  expect(hasRunnableAnalogSimulation({ ...transient, analysis_type: undefined })).toBe(false)
})

test("analog rendering requires one atomic TSX, reference, and viewer-result bundle", () => {
  const circuit_preview: ModelCircuitPreview = {
    source_file: "validation/cases/output.circuit.tsx",
    code: "export default () => <board />",
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
    ] as ModelCircuitPreview["circuit_json"],
  }
  const reference_preview = {
    benchmark_id: "output",
    title: "Output",
    source_file: "evidence/output.png",
    x_axis_label: "time",
    x_axis_unit: "s",
    y_axis_unit: "V",
    x_scale: "linear" as const,
    y_scale: "linear" as const,
    reference_kind: "curve" as const,
    reference_points: [
      { x: 0, y: 0 },
      { x: 0.001, y: 1 },
    ],
    result_points: [
      { x: 0, y: 0 },
      { x: 0.001, y: 1 },
    ],
    series: [
      {
        series_id: "output",
        title: "Output",
        role: "response" as const,
        quantity: "voltage",
        unit: "V",
        source_file: "evidence/output.png",
        y_scale: "linear" as const,
        reference_kind: "curve" as const,
        reference_points: [
          { x: 0, y: 0 },
          { x: 0.001, y: 1 },
        ],
        result_points: [
          { x: 0, y: 0 },
          { x: 0.001, y: 1 },
        ],
        matches_reference: true,
      },
    ],
    result_status: "verified" as const,
    result_origin: "tscircuit_viewer" as const,
    matches_reference: true,
    updated_at: "2026-08-01T00:00:00.000Z",
  }

  expect(hasRunnableAnalogPreviewBundle({ circuit_preview })).toBe(false)
  expect(hasRunnableAnalogPreviewBundle({ reference_preview })).toBe(false)
  expect(hasRunnableAnalogPreviewBundle({ circuit_preview, reference_preview })).toBe(true)
  expect(
    hasRunnableAnalogPreviewBundle({
      circuit_preview,
      reference_preview: { ...reference_preview, result_points: undefined },
    }),
  ).toBe(false)
})

test("preview cache identity includes job, generation, revision, and case set and failures evict old data", () => {
  const base = {
    job_id: "job-a",
    preview_generation: "generation-a",
    model_revision: "revision-a",
    preview_option_key: "output",
  }
  const scope = getModelPreviewBundleScopeKey(base)
  expect(getModelPreviewBundleScopeKey({ ...base, job_id: "job-b" })).not.toBe(scope)
  expect(getModelPreviewBundleScopeKey({ ...base, preview_generation: "generation-b" })).not.toBe(scope)
  expect(getModelPreviewBundleScopeKey({ ...base, model_revision: "revision-b" })).not.toBe(scope)
  expect(getModelPreviewBundleScopeKey({ ...base, preview_option_key: "startup" })).not.toBe(scope)

  const old_preview = collectModelPreviewLoadResults([
    {
      benchmark_id: "output",
      preview: {
        reference_preview: {
          title: "Old result",
          source_file: "evidence/old.png",
          x_scale: "linear",
          y_scale: "linear",
          reference_points: [],
          updated_at: "2026-08-01T00:00:00.000Z",
        },
      },
    },
  ])
  expect(old_preview.previews.output).toBeDefined()
  const failed_refresh = collectModelPreviewLoadResults([
    { benchmark_id: "output", error: "Candidate preview output is invalid" },
  ])
  expect(failed_refresh.previews.output).toBeUndefined()
  expect(failed_refresh.errors.output).toContain("invalid")
})

test("operating-point artifacts are shown as specification checks, never fake graph matches", () => {
  const html = renderToStaticMarkup(
    createElement(ModelLivePreview, {
      job_id: "run94",
      is_complete: true,
      preview_options: [],
      circuit_preview: {
        source_file: "validation/cases/input-loading.circuit.tsx",
        code: "export default () => <board />",
        build_status: "ready",
        updated_at: "2026-08-01T00:00:00.000Z",
        analysis_type: "operating_point",
        analog_simulation_status: "unsupported",
        circuit_json: [
          { type: "source_component", source_component_id: "source_component_1", name: "DUT" },
        ] as ModelCircuitPreview["circuit_json"],
      },
      reference_preview: {
        benchmark_id: "input-loading",
        title: "Input loading",
        source_file: "evidence/source-page-5.png",
        reference_kind: "bounds",
        x_axis_label: "Operating point",
        x_scale: "linear",
        y_scale: "linear",
        reference_points: [],
        reference_bounds: { max: 0.0001 },
        result_points: [{ x: 0, y: 0.00005 }],
        normalized_rmse: 0,
        normalized_max_error: 0,
        matches_reference: true,
        result_status: "verified",
        updated_at: "2026-08-01T00:00:00.000Z",
      },
    }),
  )

  expect(html).toContain("Specification checks")
  expect(html).toContain("Within datasheet limits")
  expect(html).toContain("Datasheet specification reference")
  expect(html).not.toContain("Reference graph comparison")
  expect(html).not.toContain("NRMSE")
  expect(html).not.toContain("Peak error")
  expect(html).not.toContain("Matches reference")
  expect(html).toContain("model-analog-only-runframe")
  expect(html).toContain("Waiting for analog simulation")
})

test("a source-ready benchmark does not claim an automatic Circuit JSON simulation", () => {
  const html = renderToStaticMarkup(
    createElement(ModelLivePreview, {
      job_id: "job_1",
      is_complete: true,
      preview_options: [],
      circuit_preview: {
        source_file: "validation/cases/transfer.circuit.tsx",
        code: "export default () => <board />",
        build_status: "source_ready",
        updated_at: "2026-07-31T00:00:00.000Z",
      },
    }),
  )

  expect(html).toContain("Benchmark TSX is source-ready")
  expect(html).toContain("No Circuit JSON snapshot is stored for this benchmark")
  expect(html).toContain("analog viewer appears only after tscircuit stores a completed transient waveform")
  expect(html).not.toContain("automatically runs one preview point")
})

test("comparison graphs identify independently auto-scaled waveforms", () => {
  expect(
    getComparisonScaleDisparity(
      [
        { x: 0, y: 0 },
        { x: 1, y: 3.3 },
      ],
      [
        { x: 0, y: 7.3e-13 },
        { x: 1, y: 2.15e-10 },
      ],
    ),
  ).toEqual({ reference_min: 0, reference_max: 3.3, result_min: 7.3e-13, result_max: 2.15e-10 })
  expect(
    getComparisonScaleDisparity(
      [
        { x: 0, y: 0 },
        { x: 1, y: 3.3 },
      ],
      [
        { x: 0, y: 0.1 },
        { x: 1, y: 3.2 },
      ],
    ),
  ).toBeUndefined()
})

test("graph axes use useful linear and logarithmic ticks", () => {
  const linear_axis = getGraphAxisLayout([-0.8, 3.2], "linear")
  expect(linear_axis.ticks.map((tick) => tick.value)).toContain(0)
  expect(linear_axis.ticks.length).toBeGreaterThanOrEqual(4)
  expect(linear_axis.min).toBeLessThanOrEqual(-0.8)
  expect(linear_axis.max).toBeGreaterThanOrEqual(3.2)

  const log_axis = getGraphAxisLayout([0.1, 100], "log")
  expect(log_axis.ticks.map((tick) => tick.label)).toEqual(["0.1", "1", "10", "100"])
})

test("reference graphs label both axes with units and intermediate ticks", () => {
  const html = renderToStaticMarkup(
    createElement(ReferenceGraph, {
      preview: {
        title: "Transfer curve",
        source_file: "evidence/curves/transfer.csv",
        reference_kind: "curve",
        x_axis_label: "Time",
        x_axis_unit: "ms",
        y_axis_label: "Voltage",
        y_axis_unit: "V",
        x_scale: "linear",
        y_scale: "linear",
        reference_points: [
          { x: 0, y: -1 },
          { x: 1, y: 1 },
          { x: 2, y: 3 },
        ],
        updated_at: "2026-07-22T00:00:00.000Z",
      },
    }),
  )

  expect(html).toContain("Time (ms)")
  expect(html).toContain("Voltage (V)")
  expect(html).toContain('class="reference-axis-ticks"')
  expect(html.match(/reference-axis-tick-x/g)?.length).toBeGreaterThanOrEqual(4)
  expect(html.match(/reference-axis-tick-y/g)?.length).toBeGreaterThanOrEqual(4)
})

test("bounds render as a specification card instead of a fake graph", () => {
  const html = renderToStaticMarkup(
    createElement(ReferenceGraph, {
      preview: {
        title: "Supply current limit",
        source_file: "validation-plan.json",
        x_axis_label: "Operating point",
        y_axis_label: "Current",
        y_axis_unit: "A",
        x_scale: "linear",
        y_scale: "linear",
        reference_points: [],
        reference_bounds: { min: 0.0001, max: 0.001 },
        result_points: [{ x: 0, y: 0.0005 }],
        updated_at: "2026-07-31T00:00:00.000Z",
      },
    }),
  )

  expect(html).toContain('class="model-specification-check"')
  expect(html).toContain("Minimum")
  expect(html).toContain("Maximum")
  expect(html).toContain("Observed result")
  expect(html).not.toContain("<svg")
})

test("singleton targets render as values instead of graph markers", () => {
  const html = renderToStaticMarkup(
    createElement(ReferenceGraph, {
      preview: {
        title: "Quiescent current operating point",
        source_file: "validation-plan.json",
        x_axis_label: "Operating point",
        y_axis_label: "Current",
        y_axis_unit: "A",
        x_scale: "linear",
        y_scale: "linear",
        reference_points: [{ x: 0, y: 0.00064 }],
        result_points: [{ x: 0, y: 0.00063 }],
        result_status: "verified",
        updated_at: "2026-08-01T00:00:00.000Z",
      },
    }),
  )

  expect(html).toContain("Datasheet target")
  expect(html).toContain("Observed result")
  expect(html).not.toContain("<circle")
  expect(html).not.toContain("<svg")
})

test("a singleton result remains visible in a bounds specification card", () => {
  const html = renderToStaticMarkup(
    createElement(ReferenceGraph, {
      preview: {
        title: "Input loading operating point",
        source_file: "validation-plan.json",
        x_axis_label: "Operating point",
        y_axis_label: "Current",
        y_axis_unit: "A",
        x_scale: "linear",
        y_scale: "linear",
        reference_points: [],
        reference_bounds: { min: 0, max: 0.0001 },
        result_points: [{ x: 0, y: 0.000085 }],
        result_status: "verified",
        updated_at: "2026-08-01T00:00:00.000Z",
      },
    }),
  )

  expect(html).toContain("Minimum")
  expect(html).toContain("Maximum")
  expect(html).toContain("Observed result")
  expect(html).not.toContain("<circle")
})

test("failed and cancelled server cases are never labelled as verified", () => {
  const failed_html = renderToStaticMarkup(
    createElement(ReferenceGraph, {
      preview: {
        title: "Failed transfer",
        source_file: "validation-plan.json",
        result_status: "failed",
        result_origin: "server_validation",
        x_scale: "linear",
        y_scale: "linear",
        reference_points: [{ x: 0, y: 0 }],
        result_points: [{ x: 0, y: 1 }],
        updated_at: "2026-07-31T00:00:00.000Z",
      },
    }),
  )
  const cancelled_html = renderToStaticMarkup(
    createElement(ModelLivePreview, {
      job_id: "job_1",
      is_complete: true,
      preview_options: [],
      reference_preview: {
        title: "Cancelled transfer",
        source_file: "validation-plan.json",
        result_status: "cancelled",
        result_origin: "server_validation",
        x_scale: "linear",
        y_scale: "linear",
        reference_points: [{ x: 0, y: 0 }],
        result_points: [{ x: 0, y: 1 }],
        updated_at: "2026-07-31T00:00:00.000Z",
      },
    }),
  )
  const cancelled_without_waveform = renderToStaticMarkup(
    createElement(ReferenceGraph, {
      preview: {
        title: "Cancelled transfer",
        source_file: "validation-plan.json",
        result_status: "cancelled",
        result_origin: "server_validation",
        x_scale: "linear",
        y_scale: "linear",
        reference_points: [{ x: 0, y: 0 }],
        updated_at: "2026-07-31T00:00:00.000Z",
      },
    }),
  )

  expect(failed_html).toContain("Server validation · failed")
  expect(failed_html).not.toContain("Server-verified model")
  expect(cancelled_html).toContain("Server validation · cancelled")
  expect(cancelled_html).toContain("Validation cancelled")
  expect(cancelled_html).not.toContain("Server-verified model")
  expect(cancelled_without_waveform).toContain("server specification check was cancelled")
  expect(cancelled_without_waveform).not.toContain("pending verification")
})

test("multi-series reference graphs keep a complete plot and legend in each panel", () => {
  const html = renderToStaticMarkup(
    createElement(ReferenceGraph, {
      preview: {
        title: "Transient response",
        source_file: "evidence/curves/transient.csv",
        x_axis_label: "Time",
        x_axis_unit: "ms",
        x_scale: "linear",
        y_scale: "linear",
        reference_points: [],
        series: [
          {
            series_id: "bus",
            title: "BUS Voltage",
            role: "stimulus",
            quantity: "voltage",
            unit: "V",
            source_file: "evidence/curves/transient-bus.csv",
            y_scale: "linear",
            reference_kind: "curve",
            reference_points: [
              { x: 0, y: 0 },
              { x: 0.1, y: 1 },
            ],
          },
          {
            series_id: "alert",
            title: "ALERT",
            role: "response",
            quantity: "voltage",
            unit: "V",
            source_file: "evidence/curves/transient-alert.csv",
            y_scale: "linear",
            reference_kind: "curve",
            reference_points: [
              { x: 0, y: 3.3 },
              { x: 0.1, y: 0 },
            ],
          },
        ],
        updated_at: "2026-07-22T00:00:00.000Z",
      },
    }),
  )

  expect(html.match(/class="model-reference-series-panel"/g)).toHaveLength(2)
  expect(html.match(/Time \(ms\)/g)).toHaveLength(4)
  expect(html.match(/Voltage \(V\)/g)).toHaveLength(4)
  expect(html.match(/class="reference-legend"/g)).toHaveLength(2)
})

test("the comparison header shows metrics and tolerance status", () => {
  const html = renderToStaticMarkup(
    createElement(ModelLivePreview, {
      job_id: "job_1",
      is_complete: true,
      preview_options: [],
      reference_preview: {
        benchmark_id: "transfer",
        title: "Transfer curve",
        source_file: "evidence/curves/transfer.csv",
        reference_kind: "curve",
        x_axis_label: "Time",
        x_axis_unit: "ms",
        x_scale: "linear",
        y_scale: "linear",
        reference_points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        result_points: [
          { x: 0, y: 0 },
          { x: 1, y: 2 },
        ],
        normalized_rmse: 0.4,
        normalized_max_error: 0.75,
        matches_reference: false,
        updated_at: "2026-07-22T00:00:00.000Z",
      },
    }),
  )

  expect(html).toContain('class="model-comparison-summary"')
  expect(html).toContain("<span>NRMSE</span><strong>40.0%</strong>")
  expect(html).toContain("<span>Peak error</span><strong>75.0%</strong>")
  expect(html).toContain("Outside curve tolerance")
  expect(html).not.toContain("model-reference-mismatch-warning")
})

test("the comparison header warns when its Circuit JSON graph is deprecated", () => {
  const html = renderToStaticMarkup(
    createElement(ModelLivePreview, {
      job_id: "job_1",
      is_complete: true,
      preview_options: [],
      reference_preview: {
        benchmark_id: "transfer",
        title: "Transfer curve",
        source_file: "evidence/curves/transfer.csv",
        result_file: "results/transfer.csv",
        result_status: "deprecated",
        x_scale: "linear",
        y_scale: "linear",
        reference_points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        result_points: [
          { x: 0, y: 0 },
          { x: 1, y: 0.8 },
        ],
        normalized_rmse: 0.2,
        matches_reference: false,
        updated_at: "2026-07-22T00:00:00.000Z",
      },
    }),
  )

  expect(html).toContain("Circuit JSON graph deprecated")
  expect(html).toContain(
    'title="The plotted Circuit JSON result comes from an earlier source than the reference comparison."',
  )
  expect(html).not.toContain("model-comparison-warning")
})

test("the datasheet image stays visible above a separate reference graph strip", () => {
  const html = renderToStaticMarkup(
    createElement(ModelLivePreview, {
      job_id: "job_1",
      is_complete: true,
      preview_generation: "candidate-preview-generation-01",
      model_revision: "a1b2c3d4e5f60718",
      reference_preview: {
        benchmark_id: "transfer",
        title: "Transfer curve",
        source_file: "evidence/curves/transfer.csv",
        x_scale: "linear",
        y_scale: "linear",
        reference_points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        updated_at: "2026-07-22T00:00:00.000Z",
      },
      preview_options: [
        {
          benchmark_id: "transfer",
          title: "Transfer curve",
          circuit_file: "benchmarks/transfer.circuit.tsx",
        },
      ],
    }),
  )

  expect(html).toContain('<img class="model-datasheet-reference-image"')
  expect(html).toContain("preview_generation=candidate-preview-generation-01")
  expect(html).toContain("model_revision=a1b2c3d4e5f60718")
  expect(html).not.toContain("generation=2026-07-22T00%3A00%3A00.000Z")
  expect(html).not.toContain('<a class="model-datasheet-reference-image"')
  expect(html).not.toContain("Open the full datasheet graph reference")
  expect(html).not.toContain('class="reference-view-tabs"')
  expect(html).toContain('class="model-reference-graphs-card"')
  expect(html.indexOf('class="model-circuit-preview')).toBeLessThan(
    html.indexOf('class="model-reference-graphs-card"'),
  )
  expect(html.indexOf('class="model-reference-card')).toBeLessThan(
    html.indexOf('class="model-reference-graphs-card"'),
  )
})

test("benchmark previews render every graph without a selector", () => {
  const html = renderToStaticMarkup(
    createElement(ModelLivePreview, {
      job_id: "job_1",
      is_complete: true,
      preview_options: [
        {
          benchmark_id: "line-wide",
          title: "Line transient",
          circuit_file: "benchmarks/line-wide.circuit.tsx",
        },
        {
          benchmark_id: "line-full",
          title: "Line transient",
          circuit_file: "benchmarks/line-full.circuit.tsx",
        },
        {
          benchmark_id: "startup",
          title: "Startup",
          circuit_file: "benchmarks/startup.circuit.tsx",
        },
      ],
    }),
  )

  expect(html).not.toContain('aria-label="Select benchmark graph"')
  expect(html).not.toContain("Showing one of")
  expect(html.match(/model-preview-workspace/g)).toHaveLength(3)
})

test("found references use the normal workspace with both TSX views and an empty comparison", () => {
  const html = renderToStaticMarkup(
    createElement(ModelLivePreview, {
      job_id: "job_1",
      local_run_id: "local_1",
      is_complete: true,
      preview_options: [],
      found_references: [
        {
          reference_id: "load-transient",
          title: "Figure 10-21. Load transient",
          source_file: "evidence/load-transient.png",
          page: 21,
          figure: "Figure 10-21",
          x_axis_label: "Time",
          x_axis_unit: "s",
          updated_at: "2026-08-06T00:00:00.000Z",
        },
      ],
    }),
  )

  expect(html.match(/model-preview-workspace/g)).toHaveLength(1)
  expect(html).toContain("Waiting for benchmark TSX")
  expect(html).toContain("Waiting for analog simulation")
  expect(html).toContain("Reference graph comparison")
  expect(html).toContain("Waiting for digitized evidence")
  expect(html).toContain(
    "/api/model-run/found-reference-image?job_id=job_1&amp;reference_id=load-transient&amp;local_run_id=local_1",
  )
  expect(html).toContain('class="model-datasheet-reference-image"')
})
