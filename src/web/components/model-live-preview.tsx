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

function curvePath(input: {
  points: ModelCurvePoint[]
  x_scale: "linear" | "log"
  y_scale: "linear" | "log"
  x_min: number
  x_max: number
  y_min: number
  y_max: number
}): string {
  const width = 592
  const height = 292
  return input.points
    .flatMap((point) => {
      const scaled_x = scaledValue(point.x, input.x_scale)
      const scaled_y = scaledValue(point.y, input.y_scale)
      if (scaled_x === undefined || scaled_y === undefined) return []
      const x = 38 + ((scaled_x - input.x_min) / Math.max(1e-12, input.x_max - input.x_min)) * width
      const y = 14 + (1 - (scaled_y - input.y_min) / Math.max(1e-12, input.y_max - input.y_min)) * height
      return [`${x.toFixed(2)},${y.toFixed(2)}`]
    })
    .join(" ")
}

function formatAxisValue(value: number): string {
  const magnitude = Math.abs(value)
  if ((magnitude > 0 && magnitude < 0.001) || magnitude >= 10_000) return value.toExponential(1)
  return Number(value.toPrecision(4)).toString()
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

function ReferenceGraph({ preview }: { preview?: ModelReferencePreview }) {
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
  const scaled_x = all_points.flatMap((point) => {
    const value = scaledValue(point.x, preview.x_scale)
    return value === undefined ? [] : [value]
  })
  const scaled_y = all_points.flatMap((point) => {
    const value = scaledValue(point.y, preview.y_scale)
    return value === undefined ? [] : [value]
  })
  const x_min = scaled_x.length > 0 ? Math.min(...scaled_x) : 0
  const x_max = scaled_x.length > 0 ? Math.max(...scaled_x) : 1
  const y_min = scaled_y.length > 0 ? Math.min(...scaled_y) : 0
  const y_max = scaled_y.length > 0 ? Math.max(...scaled_y) : 1
  const reference_path = curvePath({
    points: preview.reference_points,
    x_scale: preview.x_scale,
    y_scale: preview.y_scale,
    x_min,
    x_max,
    y_min,
    y_max,
  })
  const result_path = preview.result_points
    ? curvePath({
        points: preview.result_points,
        x_scale: preview.x_scale,
        y_scale: preview.y_scale,
        x_min,
        x_max,
        y_min,
        y_max,
      })
    : undefined
  const displayed_x_min = preview.x_scale === "log" ? 10 ** x_min : x_min
  const displayed_x_max = preview.x_scale === "log" ? 10 ** x_max : x_max
  const displayed_y_min = preview.y_scale === "log" ? 10 ** y_min : y_min
  const displayed_y_max = preview.y_scale === "log" ? 10 ** y_max : y_max
  const comparison_is_deprecated = preview.result_status === "deprecated" || preview.is_stale
  const comparison_is_unverified = preview.result_status === "unverified"
  const scale_disparity = getComparisonScaleDisparity(preview.reference_points, preview.result_points)
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
      {comparison_is_deprecated && preview.result_points && (
        <div className="model-comparison-warning" role="status">
          <AlertTriangle size={13} />
          <span>
            <strong>Deprecated comparison</strong>
            This curve was built from an earlier source; the automatic run will replace it.
          </span>
        </div>
      )}
      {scale_disparity && (
        <div className="model-scale-note" role="status">
          <AlertTriangle size={13} />
          <span>
            <strong>Different vertical scales</strong>
            The Analog Simulation tab auto-scales the model-only waveform. This comparison uses one shared
            y-axis: reference {formatAxisValue(scale_disparity.reference_min)}–
            {formatAxisValue(scale_disparity.reference_max)} V, model{" "}
            {formatAxisValue(scale_disparity.result_min)}–{formatAxisValue(scale_disparity.result_max)} V.
          </span>
        </div>
      )}
      <div className="reference-graph-content">
        <svg viewBox="0 0 650 340" role="img" aria-label={`${preview.title} reference curve`}>
          <g className="reference-grid">
            {[0, 1, 2, 3, 4].map((tick) => (
              <line key={`horizontal-${tick}`} x1="38" x2="630" y1={14 + tick * 73} y2={14 + tick * 73} />
            ))}
            {[0, 1, 2, 3, 4].map((tick) => (
              <line key={`vertical-${tick}`} x1={38 + tick * 148} x2={38 + tick * 148} y1="14" y2="306" />
            ))}
          </g>
          <polyline className="reference-line" points={reference_path} />
          {result_path && (
            <polyline
              className={`result-line${comparison_is_unverified ? " result-line-unverified" : ""}${preview.result_status === "partial" ? " result-line-partial" : ""}${comparison_is_deprecated ? " result-line-deprecated" : ""}`}
              points={result_path}
            />
          )}
          <g className="reference-axis-labels">
            <text x="38" y="328" textAnchor="start">
              {formatAxisValue(displayed_x_min)}
            </text>
            <text x="630" y="328" textAnchor="end">
              {formatAxisValue(displayed_x_max)}
            </text>
            <text x="30" y="21" textAnchor="end">
              {formatAxisValue(displayed_y_max)}
            </text>
            <text x="30" y="309" textAnchor="end">
              {formatAxisValue(displayed_y_min)}
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
      {preview?.matches_reference === false && (
        <div className="model-reference-mismatch-warning" role="status">
          <AlertTriangle size={14} />
          <span>
            <strong>Doesn’t match the reference</strong>
            The current graph is outside the benchmark tolerance.
          </span>
        </div>
      )}
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
          <a
            className="model-datasheet-reference-image"
            href={image_url}
            target="_blank"
            rel="noreferrer"
            title="Open the full datasheet graph reference"
          >
            <img
              key={image_url}
              src={image_url}
              alt={`Datasheet graph reference for ${preview?.title ?? resolved_benchmark_id}`}
              onError={() => setImageFailed(true)}
            />
          </a>
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
