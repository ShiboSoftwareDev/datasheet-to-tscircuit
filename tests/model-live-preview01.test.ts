import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ModelCircuitPreview } from "@/shared/job-types"
import {
  getComparisonScaleDisparity,
  getGraphAxisLayout,
  getRunframeCircuitJson,
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
  expect(html).toContain("Outside tolerance")
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

test("the model datasheet reference renders as a non-interactive image", () => {
  const html = renderToStaticMarkup(
    createElement(ModelLivePreview, {
      job_id: "job_1",
      is_complete: true,
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
  expect(html).not.toContain('<a class="model-datasheet-reference-image"')
  expect(html).not.toContain("Open the full datasheet graph reference")
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
