import type { TabId } from "@tscircuit/runframe"
import {
  Activity,
  AlertTriangle,
  ChartLine,
  Check,
  Clipboard,
  Code2,
  FileImage,
  FlaskConical,
  ImageOff,
  LoaderCircle,
} from "lucide-react"
import { lazy, Suspense, useEffect, useMemo, useState } from "react"
import type {
  ModelCircuitPreview as ModelCircuitPreviewData,
  ModelCurvePoint,
  ModelPreviewOption,
  ModelReferencePreview,
  ModelSelectedPreview,
} from "@/shared/job-types"
import { getModelReferenceImageUrl, getModelSelectedPreview } from "../api"

const CircuitJsonPreview = lazy(async () => {
  const runframe_module = await import("@tscircuit/runframe")
  return { default: runframe_module.CircuitJsonPreview }
})

function ModelCode({ preview }: { preview: ModelCircuitPreviewData }) {
  const [is_copied, setIsCopied] = useState(false)
  const copyCode = async () => {
    await navigator.clipboard.writeText(preview.code)
    setIsCopied(true)
    window.setTimeout(() => setIsCopied(false), 1_500)
  }
  return (
    <div className="code-tab-content model-code-content">
      <header className="card-toolbar">
        <div className="toolbar-title">
          <Code2 size={16} />
          <span>{preview.source_file}</span>
        </div>
        <div className="code-actions">
          <button type="button" onClick={copyCode}>
            {is_copied ? <Check size={14} /> : <Clipboard size={14} />}
            {is_copied ? "Copied" : "Copy"}
          </button>
        </div>
      </header>
      <pre>
        <code>{preview.code}</code>
      </pre>
    </div>
  )
}

function CircuitPlaceholder({ preview }: { preview?: ModelCircuitPreviewData }) {
  const title =
    preview?.build_status === "building"
      ? "Building circuit"
      : preview?.build_status === "failed"
        ? "Circuit build failed"
        : preview
          ? "Waiting for a saved circuit run"
          : "Waiting for benchmark TSX"
  return (
    <div className="model-preview-placeholder">
      {preview?.build_status === "building" ? (
        <LoaderCircle className="spin" size={25} />
      ) : (
        <FlaskConical size={25} />
      )}
      <strong>{title}</strong>
      <p>
        {preview?.error_message ??
          (preview?.build_status === "building"
            ? "tsci is building this benchmark. The viewer will use the first persisted Circuit JSON output."
            : preview
              ? "The source is ready. The server automatically runs one preview point per benchmark when a model checkpoint enters validation; the viewer appears from the first persisted result."
              : "This appears as soon as the agent writes its first benchmark circuit.")}
      </p>
      {preview?.code && (
        <pre>
          <code>{preview.code}</code>
        </pre>
      )}
    </div>
  )
}

export function getRunframeCircuitJson(input: {
  active_tab: TabId
  live_circuit_json: ModelCircuitPreviewData["circuit_json"]
  code_tab_circuit_json: ModelCircuitPreviewData["circuit_json"]
}): ModelCircuitPreviewData["circuit_json"] {
  const { active_tab, live_circuit_json, code_tab_circuit_json } = input
  return active_tab === "code" && code_tab_circuit_json !== undefined
    ? code_tab_circuit_json
    : live_circuit_json
}

function ModelCircuitPreview({ preview }: { preview?: ModelCircuitPreviewData }) {
  const [active_tab, setActiveTab] = useState<TabId>("analog_simulation")
  // Runframe leaves Code whenever the Circuit JSON prop changes. Keep the snapshot
  // that was visible on entry, then reveal the newest live data on a visual tab.
  const [code_tab_circuit_json, setCodeTabCircuitJson] = useState(preview?.circuit_json)
  const runframe_circuit_json = getRunframeCircuitJson({
    active_tab,
    live_circuit_json: preview?.circuit_json,
    code_tab_circuit_json,
  })

  const handleActiveTabChange = (tab: TabId) => {
    if (tab === "code") setCodeTabCircuitJson(preview?.circuit_json)
    setActiveTab(tab)
  }

  return (
    <section className="model-preview-pane model-circuit-preview" aria-label="Live model circuit preview">
      <div className="model-runframe-shell">
        {preview?.circuit_json && preview.error_message && (
          <p className="model-preview-build-error" role="alert">
            {preview.error_message}
          </p>
        )}
        {!preview || !runframe_circuit_json ? (
          <CircuitPlaceholder preview={preview} />
        ) : (
          <Suspense fallback={<CircuitPlaceholder preview={preview} />}>
            <CircuitJsonPreview
              circuitJson={runframe_circuit_json}
              code={preview.code}
              showCodeTab
              codeTabContent={<ModelCode preview={preview} />}
              onActiveTabChange={handleActiveTabChange}
              availableTabs={["code", "schematic", "analog_simulation"]}
              defaultActiveTab="analog_simulation"
              defaultTab="analog_simulation"
              showJsonTab={false}
              hideSchematicInAnalogSimulation
              showRenderLogTab={false}
              showFileMenu={false}
              allowSelectingVersion={false}
              isWebEmbedded
              projectName={preview.source_file.replace(/\.circuit\.tsx$/i, "")}
            />
          </Suspense>
        )}
      </div>
    </section>
  )
}

function scaledValue(value: number, scale: "linear" | "log"): number | undefined {
  if (scale === "log") return value > 0 ? Math.log10(value) : undefined
  return value
}

const GRAPH_LEFT = 64
const GRAPH_RIGHT = 636
const GRAPH_TOP = 16
const GRAPH_BOTTOM = 310

function formatAxisValue(value: number): string {
  if (Math.abs(value) < 1e-12) return "0"
  const exponent = Math.floor(Math.log10(Math.abs(value)))
  if (exponent >= 4 || exponent <= -3) {
    const engineering_exponent = Math.floor(exponent / 3) * 3
    const mantissa = value / 10 ** engineering_exponent
    return `${Number(mantissa.toPrecision(3))}e${engineering_exponent}`
  }
  return Number(value.toPrecision(4)).toString()
}

function niceLinearStep(raw_step: number): number {
  if (!Number.isFinite(raw_step) || raw_step <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(raw_step))
  const fraction = raw_step / magnitude
  const nice_fraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10
  return nice_fraction * magnitude
}

export interface GraphAxisLayout {
  min: number
  max: number
  ticks: Array<{ scaled_value: number; value: number; label: string }>
}

export function getGraphAxisLayout(
  values: number[],
  scale: "linear" | "log",
  target_tick_count = 5,
): GraphAxisLayout {
  const scaled_values = values.flatMap((value) => {
    const scaled = scaledValue(value, scale)
    return scaled === undefined || !Number.isFinite(scaled) ? [] : [scaled]
  })
  let data_min = scaled_values.length > 0 ? Math.min(...scaled_values) : 0
  let data_max = scaled_values.length > 0 ? Math.max(...scaled_values) : 1

  if (data_min === data_max) {
    const padding = scale === "log" ? 0.5 : Math.max(Math.abs(data_min) * 0.1, 1)
    data_min -= padding
    data_max += padding
  }

  if (scale === "log") {
    const span = data_max - data_min
    if (span >= 1) {
      const raw_step = span / Math.max(1, target_tick_count - 1)
      const step = Math.max(1, Math.ceil(raw_step))
      const min = Math.floor(data_min / step) * step
      const max = Math.ceil(data_max / step) * step
      const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, index) => {
        const scaled_value = min + index * step
        const value = 10 ** scaled_value
        return { scaled_value, value, label: formatAxisValue(value) }
      })
      return { min, max, ticks }
    }

    const min = data_min
    const max = data_max
    const ticks = Array.from({ length: target_tick_count }, (_, index) => {
      const scaled_value = min + (index / Math.max(1, target_tick_count - 1)) * (max - min)
      const value = 10 ** scaled_value
      return { scaled_value, value, label: formatAxisValue(value) }
    })
    return { min, max, ticks }
  }

  const step = niceLinearStep((data_max - data_min) / Math.max(1, target_tick_count - 1))
  const min = Math.floor(data_min / step) * step
  const max = Math.ceil(data_max / step) * step
  const tick_count = Math.round((max - min) / step) + 1
  const ticks = Array.from({ length: tick_count }, (_, index) => {
    const scaled_value = min + index * step
    const value = Math.abs(scaled_value) < step * 1e-9 ? 0 : scaled_value
    return { scaled_value: value, value, label: formatAxisValue(value) }
  })
  return { min, max, ticks }
}

function curvePath(input: {
  points: ModelCurvePoint[]
  x_scale: "linear" | "log"
  y_scale: "linear" | "log"
  x_min: number
  x_max: number
  y_min: number
  y_max: number
}): string {
  const width = GRAPH_RIGHT - GRAPH_LEFT
  const height = GRAPH_BOTTOM - GRAPH_TOP
  return input.points
    .flatMap((point) => {
      const scaled_x = scaledValue(point.x, input.x_scale)
      const scaled_y = scaledValue(point.y, input.y_scale)
      if (scaled_x === undefined || scaled_y === undefined) return []
      const x = GRAPH_LEFT + ((scaled_x - input.x_min) / Math.max(1e-12, input.x_max - input.x_min)) * width
      const y =
        GRAPH_TOP + (1 - (scaled_y - input.y_min) / Math.max(1e-12, input.y_max - input.y_min)) * height
      return [`${x.toFixed(2)},${y.toFixed(2)}`]
    })
    .join(" ")
}

function graphCoordinate(value: number, min: number, max: number, start: number, end: number): number {
  return start + ((value - min) / Math.max(1e-12, max - min)) * (end - start)
}

function formatAxisTitle(label: string | undefined, unit: string | undefined, fallback: string): string {
  const resolved_label = label?.trim() || fallback
  return unit?.trim() ? `${resolved_label} (${unit.trim()})` : resolved_label
}

function formatQuantityLabel(quantity: string): string {
  return quantity
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

export function getComparisonScaleDisparity(
  reference_points: ModelCurvePoint[],
  result_points: ModelCurvePoint[] | undefined,
): { reference_min: number; reference_max: number; result_min: number; result_max: number } | undefined {
  if (!result_points?.length || reference_points.length === 0) return undefined
  const reference_values = reference_points.map((point) => point.y)
  const result_values = result_points.map((point) => point.y)
  const reference_min = Math.min(...reference_values)
  const reference_max = Math.max(...reference_values)
  const result_min = Math.min(...result_values)
  const result_max = Math.max(...result_values)
  const reference_magnitude = Math.max(Math.abs(reference_min), Math.abs(reference_max))
  const result_magnitude = Math.max(Math.abs(result_min), Math.abs(result_max))
  const smaller_magnitude = Math.min(reference_magnitude, result_magnitude)
  const larger_magnitude = Math.max(reference_magnitude, result_magnitude)
  if (larger_magnitude === 0 || (smaller_magnitude > 0 && larger_magnitude / smaller_magnitude < 100)) {
    return undefined
  }
  return { reference_min, reference_max, result_min, result_max }
}

export function ReferenceGraph({ preview }: { preview?: ModelReferencePreview }) {
  if (!preview) {
    return (
      <div className="model-reference-empty">
        <FlaskConical size={25} />
        <strong>Waiting for digitized evidence</strong>
        <p>The first numeric datasheet curve will appear here while setup is still running.</p>
      </div>
    )
  }

  if (preview.series && preview.series.length > 1) {
    return (
      <div className="model-reference-series-stack">
        {preview.series.map((series) => (
          <section className="model-reference-series-panel" key={series.series_id}>
            <header>
              <strong>{series.title}</strong>
              <span>
                {series.role === "response" ? "DUT response" : "Harness stimulus"} · {series.unit}
              </span>
            </header>
            <ReferenceGraph
              preview={{
                ...preview,
                title: `${preview.title}: ${series.title}`,
                source_file: series.source_file,
                result_file: series.result_file,
                y_axis_label: formatQuantityLabel(series.quantity),
                y_axis_unit: series.unit,
                y_scale: series.y_scale,
                reference_points: series.reference_points,
                result_points: series.result_points,
                series: undefined,
              }}
            />
          </section>
        ))}
      </div>
    )
  }

  const all_points = [...preview.reference_points, ...(preview.result_points ?? [])]
  const x_axis = getGraphAxisLayout(
    all_points.map((point) => point.x),
    preview.x_scale,
  )
  const y_axis = getGraphAxisLayout(
    all_points.map((point) => point.y),
    preview.y_scale,
  )
  const reference_path = curvePath({
    points: preview.reference_points,
    x_scale: preview.x_scale,
    y_scale: preview.y_scale,
    x_min: x_axis.min,
    x_max: x_axis.max,
    y_min: y_axis.min,
    y_max: y_axis.max,
  })
  const result_path = preview.result_points
    ? curvePath({
        points: preview.result_points,
        x_scale: preview.x_scale,
        y_scale: preview.y_scale,
        x_min: x_axis.min,
        x_max: x_axis.max,
        y_min: y_axis.min,
        y_max: y_axis.max,
      })
    : undefined
  const comparison_is_deprecated = preview.result_status === "deprecated" || preview.is_stale
  const comparison_is_unverified = preview.result_status === "unverified"
  const scale_disparity = getComparisonScaleDisparity(preview.reference_points, preview.result_points)
  const primary_series = preview.series?.find((series) => series.role === "response") ?? preview.series?.[0]
  const resolved_y_axis_label =
    preview.y_axis_label ?? (primary_series ? formatQuantityLabel(primary_series.quantity) : undefined)
  const resolved_y_axis_unit = preview.y_axis_unit ?? primary_series?.unit
  const x_axis_title = formatAxisTitle(preview.x_axis_label ?? "Time", preview.x_axis_unit ?? "ms", "Time")
  const y_axis_title = formatAxisTitle(resolved_y_axis_label, resolved_y_axis_unit, "Value")
  const y_axis_unit = resolved_y_axis_unit?.trim() ? ` ${resolved_y_axis_unit.trim()}` : ""
  const result_label = comparison_is_deprecated
    ? "Previous model result · deprecated"
    : comparison_is_unverified
      ? preview.result_origin === "workspace"
        ? "Agent run · unverified"
        : "Simulation run · unverified"
      : preview.result_status === "partial"
        ? "Server validation · in progress"
        : "Server-verified model"

  return (
    <div className="model-reference-plot">
      {scale_disparity && (
        <div className="model-scale-note" role="status">
          <AlertTriangle size={13} />
          <span>
            <strong>Different vertical scales</strong>
            The Analog Simulation tab auto-scales the model-only waveform. This comparison uses one shared
            y-axis: reference {formatAxisValue(scale_disparity.reference_min)}–
            {formatAxisValue(scale_disparity.reference_max)}
            {y_axis_unit}, model {formatAxisValue(scale_disparity.result_min)}–
            {formatAxisValue(scale_disparity.result_max)}
            {y_axis_unit}.
          </span>
        </div>
      )}
      <div className="reference-graph-content">
        <svg
          viewBox="0 0 650 366"
          role="img"
          aria-label={`${preview.title} comparison graph; ${x_axis_title}; ${y_axis_title}`}
        >
          <g className="reference-grid">
            {y_axis.ticks.map((tick) => {
              const y = graphCoordinate(tick.scaled_value, y_axis.min, y_axis.max, GRAPH_BOTTOM, GRAPH_TOP)
              return (
                <line
                  key={`horizontal-${tick.scaled_value}`}
                  x1={GRAPH_LEFT}
                  x2={GRAPH_RIGHT}
                  y1={y}
                  y2={y}
                />
              )
            })}
            {x_axis.ticks.map((tick) => {
              const x = graphCoordinate(tick.scaled_value, x_axis.min, x_axis.max, GRAPH_LEFT, GRAPH_RIGHT)
              return (
                <line key={`vertical-${tick.scaled_value}`} x1={x} x2={x} y1={GRAPH_TOP} y2={GRAPH_BOTTOM} />
              )
            })}
          </g>
          <g className="reference-axes">
            <line x1={GRAPH_LEFT} x2={GRAPH_LEFT} y1={GRAPH_TOP} y2={GRAPH_BOTTOM} />
            <line x1={GRAPH_LEFT} x2={GRAPH_RIGHT} y1={GRAPH_BOTTOM} y2={GRAPH_BOTTOM} />
          </g>
          <polyline className="reference-line" points={reference_path} />
          {result_path && (
            <polyline
              className={`result-line${comparison_is_unverified ? " result-line-unverified" : ""}${preview.result_status === "partial" ? " result-line-partial" : ""}${comparison_is_deprecated ? " result-line-deprecated" : ""}`}
              points={result_path}
            />
          )}
          <g className="reference-axis-ticks">
            {y_axis.ticks.map((tick) => (
              <text
                className="reference-axis-tick reference-axis-tick-y"
                key={`y-label-${tick.scaled_value}`}
                x={GRAPH_LEFT - 8}
                y={graphCoordinate(tick.scaled_value, y_axis.min, y_axis.max, GRAPH_BOTTOM, GRAPH_TOP) + 3}
                textAnchor="end"
              >
                {tick.label}
              </text>
            ))}
            {x_axis.ticks.map((tick, index) => (
              <text
                className="reference-axis-tick reference-axis-tick-x"
                key={`x-label-${tick.scaled_value}`}
                x={graphCoordinate(tick.scaled_value, x_axis.min, x_axis.max, GRAPH_LEFT, GRAPH_RIGHT)}
                y={GRAPH_BOTTOM + 18}
                textAnchor={index === 0 ? "start" : index === x_axis.ticks.length - 1 ? "end" : "middle"}
              >
                {tick.label}
              </text>
            ))}
          </g>
          <g className="reference-axis-titles">
            <text x={(GRAPH_LEFT + GRAPH_RIGHT) / 2} y="357" textAnchor="middle">
              {x_axis_title}
            </text>
            <text
              x="14"
              y={(GRAPH_TOP + GRAPH_BOTTOM) / 2}
              textAnchor="middle"
              transform={`rotate(-90 14 ${(GRAPH_TOP + GRAPH_BOTTOM) / 2})`}
            >
              {y_axis_title}
            </text>
          </g>
        </svg>
        <div className="reference-legend">
          <span className="reference-series">
            <i /> Datasheet reference
          </span>
          {preview.result_points && (
            <span
              className={`result-series${comparison_is_unverified ? " unverified" : ""}${comparison_is_deprecated ? " deprecated" : ""}`}
            >
              <i />
              {result_label}
            </span>
          )}
          {!preview.result_points && (
            <span className="model-result-pending">Model result pending verification</span>
          )}
        </div>
      </div>
    </div>
  )
}

type ModelReferenceView = "reference_graph" | "datasheet_reference"

function ComparisonSummary({ preview }: { preview?: ModelReferencePreview }) {
  if (!preview) return null

  const comparison_is_deprecated = preview.result_status === "deprecated" || preview.is_stale
  const has_summary =
    preview.normalized_rmse !== undefined ||
    preview.normalized_max_error !== undefined ||
    comparison_is_deprecated ||
    preview.matches_reference !== undefined
  if (!has_summary) return null

  return (
    <div className="model-comparison-summary" aria-label="Comparison statistics">
      {preview.normalized_rmse !== undefined && (
        <span className="model-comparison-metric">
          <span>NRMSE</span>
          <strong>{(preview.normalized_rmse * 100).toFixed(1)}%</strong>
        </span>
      )}
      {preview.normalized_max_error !== undefined && (
        <span className="model-comparison-metric">
          <span>Peak error</span>
          <strong>{(preview.normalized_max_error * 100).toFixed(1)}%</strong>
        </span>
      )}
      {comparison_is_deprecated ? (
        <span
          className="model-comparison-state is-deprecated"
          role="status"
          title="The plotted Circuit JSON result comes from an earlier source than the reference comparison."
        >
          <AlertTriangle size={12} />
          Circuit JSON graph deprecated
        </span>
      ) : preview.matches_reference === false ? (
        <span className="model-comparison-state is-mismatch" role="status">
          <AlertTriangle size={12} />
          Outside tolerance
        </span>
      ) : preview.matches_reference === true ? (
        <span className="model-comparison-state is-match" role="status">
          <Check size={12} />
          Matches reference
        </span>
      ) : null}
    </div>
  )
}

function ModelReferencePane({
  job_id,
  benchmark_id,
  preview,
}: {
  job_id: string
  benchmark_id: string
  preview?: ModelReferencePreview
}) {
  const [active_view, setActiveView] = useState<ModelReferenceView>("datasheet_reference")
  const [image_failed, setImageFailed] = useState(false)
  const resolved_benchmark_id = preview?.benchmark_id ?? benchmark_id
  const image_url =
    resolved_benchmark_id === "live" ? undefined : getModelReferenceImageUrl(job_id, resolved_benchmark_id)

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry the image when its URL or preview revision changes
  useEffect(() => setImageFailed(false), [image_url, preview?.updated_at])

  return (
    <section className="model-preview-pane model-reference-card" aria-label="SPICE benchmark reference">
      <header className="model-reference-toolbar">
        <div className="reference-view-tabs" role="tablist" aria-label="SPICE reference view">
          <button
            className={active_view === "reference_graph" ? "active" : ""}
            type="button"
            role="tab"
            aria-selected={active_view === "reference_graph"}
            onClick={() => setActiveView("reference_graph")}
          >
            <ChartLine size={14} /> Reference graphs
          </button>
          <button
            className={active_view === "datasheet_reference" ? "active" : ""}
            type="button"
            role="tab"
            aria-selected={active_view === "datasheet_reference"}
            onClick={() => {
              setImageFailed(false)
              setActiveView("datasheet_reference")
            }}
          >
            <FileImage size={14} /> Datasheet reference
          </button>
        </div>
      </header>
      <div className="model-reference-content">
        {active_view === "reference_graph" ? (
          <ReferenceGraph preview={preview} />
        ) : !image_url || image_failed ? (
          <div className="model-reference-empty">
            <ImageOff size={25} />
            <strong>Datasheet reference unavailable</strong>
            <p>No retained datasheet graph image is available for this benchmark.</p>
          </div>
        ) : (
          <img
            className="model-datasheet-reference-image"
            key={image_url}
            src={image_url}
            alt={`Datasheet graph reference for ${preview?.title ?? resolved_benchmark_id}`}
            draggable={false}
            onError={() => setImageFailed(true)}
          />
        )}
      </div>
    </section>
  )
}

export function ModelLivePreview({
  job_id,
  is_complete,
  circuit_preview,
  reference_preview,
  preview_options,
}: {
  job_id: string
  is_complete: boolean
  circuit_preview?: ModelCircuitPreviewData
  reference_preview?: ModelReferencePreview
  preview_options: ModelPreviewOption[]
}) {
  const live_benchmark_id = useMemo(() => {
    if (reference_preview?.benchmark_id) return reference_preview.benchmark_id
    const source_name = circuit_preview?.source_file.split("/").at(-1)
    return source_name?.replace(/\.circuit\.tsx$/i, "")
  }, [circuit_preview?.source_file, reference_preview?.benchmark_id])
  const preview_option_key = preview_options.map((option) => option.benchmark_id).join("\u0000")
  const [loaded_previews, setLoadedPreviews] = useState<Record<string, ModelSelectedPreview>>({})
  const [load_errors, setLoadErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    const benchmark_ids = preview_option_key ? preview_option_key.split("\u0000") : []
    if (benchmark_ids.length === 0) {
      setLoadedPreviews({})
      setLoadErrors({})
      return
    }
    let cancelled = false
    let interval: number | undefined
    const load = async () => {
      const results = await Promise.all(
        benchmark_ids.map(async (benchmark_id) => {
          try {
            return { benchmark_id, preview: await getModelSelectedPreview(job_id, benchmark_id) }
          } catch (error) {
            return {
              benchmark_id,
              error: error instanceof Error ? error.message : "Could not load this benchmark preview.",
            }
          }
        }),
      )
      if (cancelled) return
      setLoadedPreviews((current) => {
        const next: Record<string, ModelSelectedPreview> = {}
        for (const result of results) {
          const preview = result.preview
          const current_preview = current[result.benchmark_id]
          if (preview) next[result.benchmark_id] = preview
          else if (current_preview) next[result.benchmark_id] = current_preview
        }
        return next
      })
      const next_errors: Record<string, string> = {}
      for (const result of results) {
        if (result.error) next_errors[result.benchmark_id] = result.error
      }
      setLoadErrors(next_errors)
    }
    void load()
    if (!is_complete) interval = window.setInterval(() => void load(), 2_000)
    return () => {
      cancelled = true
      if (interval !== undefined) window.clearInterval(interval)
    }
  }, [is_complete, job_id, preview_option_key])

  const preview_entries: Array<{ benchmark_id: string; title: string }> =
    preview_options.length > 0
      ? preview_options
      : [
          {
            benchmark_id: live_benchmark_id ?? "live",
            title: reference_preview?.title ?? "Simulation comparison",
          },
        ]

  return (
    <section className="model-preview-list" aria-label="SPICE benchmark comparisons">
      {preview_entries.map((entry) => {
        const loaded = loaded_previews[entry.benchmark_id]
        const can_use_live_preview = entry.benchmark_id === live_benchmark_id || entry.benchmark_id === "live"
        const displayed_circuit =
          loaded?.circuit_preview ?? (can_use_live_preview ? circuit_preview : undefined)
        const displayed_reference =
          loaded?.reference_preview ?? (can_use_live_preview ? reference_preview : undefined)

        return (
          <section
            className="workspace-card model-preview-workspace"
            aria-label={`${entry.title} simulation comparison`}
            key={entry.benchmark_id}
          >
            <header className="card-toolbar model-preview-toolbar">
              <div className="toolbar-title">
                <Activity size={16} />
                <span title={entry.title}>{entry.title}</span>
              </div>
              <ComparisonSummary preview={displayed_reference} />
            </header>
            {load_errors[entry.benchmark_id] && !loaded && (
              <p className="model-preview-load-error" role="alert">
                {load_errors[entry.benchmark_id]}
              </p>
            )}
            <div className="model-preview-grid">
              <ModelCircuitPreview
                key={`${entry.benchmark_id}:${displayed_circuit?.source_file ?? "pending"}`}
                preview={displayed_circuit}
              />
              <ModelReferencePane
                job_id={job_id}
                benchmark_id={entry.benchmark_id}
                preview={displayed_reference}
              />
            </div>
          </section>
        )
      })}
    </section>
  )
}
