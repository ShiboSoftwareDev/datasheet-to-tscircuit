import type { TabId } from "@tscircuit/runframe"
import { Activity, AlertTriangle, Check, Clipboard, Code2, FlaskConical, LoaderCircle } from "lucide-react"
import { lazy, Suspense, useEffect, useMemo, useState } from "react"
import type {
  ModelCircuitPreview as ModelCircuitPreviewData,
  ModelCurvePoint,
  ModelPreviewOption,
  ModelReferencePreview,
  ModelSelectedPreview,
} from "@/shared/job-types"
import { getModelSelectedPreview } from "../api"

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

export function getRunframeCircuitJson(
  active_tab: TabId,
  live_circuit_json: ModelCircuitPreviewData["circuit_json"],
  code_tab_circuit_json: ModelCircuitPreviewData["circuit_json"],
): ModelCircuitPreviewData["circuit_json"] {
  return active_tab === "code" && code_tab_circuit_json !== undefined
    ? code_tab_circuit_json
    : live_circuit_json
}

function ModelCircuitPreview({ preview }: { preview?: ModelCircuitPreviewData }) {
  const [active_tab, setActiveTab] = useState<TabId>("analog_simulation")
  // Runframe leaves Code whenever the Circuit JSON prop changes. Keep the snapshot
  // that was visible on entry, then reveal the newest live data on a visual tab.
  const [code_tab_circuit_json, setCodeTabCircuitJson] = useState(preview?.circuit_json)
  const runframe_circuit_json = getRunframeCircuitJson(
    active_tab,
    preview?.circuit_json,
    code_tab_circuit_json,
  )

  const handleActiveTabChange = (tab: TabId) => {
    if (tab === "code") setCodeTabCircuitJson(preview?.circuit_json)
    setActiveTab(tab)
  }

  return (
    <section className="workspace-card model-circuit-preview" aria-label="Live model circuit preview">
      <header className="card-toolbar">
        <div className="toolbar-title">
          <Activity size={16} />
          <span>{preview?.source_file ?? "Live benchmark circuit"}</span>
        </div>
        {preview && (
          <small>
            {preview.build_status.replace("_", " ")}
            {preview.snapshot_origin === "server_validation" ? " · verified snapshot" : ""}
            {preview.snapshot_origin === "workspace" ? " · saved workspace run" : ""}
          </small>
        )}
      </header>
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

function ReferenceGraph({ preview }: { preview?: ModelReferencePreview }) {
  if (!preview) {
    return (
      <section className="workspace-card model-reference-card" aria-label="Datasheet reference graph">
        <header className="card-toolbar">
          <div className="toolbar-title">
            <FlaskConical size={16} /> Reference graph
          </div>
        </header>
        <div className="model-reference-empty">
          <FlaskConical size={25} />
          <strong>Waiting for digitized evidence</strong>
          <p>The first numeric datasheet curve will appear here while setup is still running.</p>
        </div>
      </section>
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
    <section className="workspace-card model-reference-card" aria-label="Datasheet reference graph">
      <header className="card-toolbar">
        <div className="toolbar-title">
          <FlaskConical size={16} />
          <span title={preview.title}>{preview.title}</span>
        </div>
        <small>{preview.source_file}</small>
      </header>
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
          <small>
            {preview.x_scale === "log" ? "log x" : "linear x"} ·{" "}
            {preview.y_scale === "log" ? "log y" : "linear y"}
          </small>
        </div>
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
  const [selected_benchmark_id, setSelectedBenchmarkId] = useState<string>()
  const [loaded_preview, setLoadedPreview] = useState<{
    benchmark_id: string
    preview: ModelSelectedPreview
  }>()
  const [is_loading, setIsLoading] = useState(false)
  const [error_message, setErrorMessage] = useState<string>()

  useEffect(() => {
    setSelectedBenchmarkId((current) => {
      if (current && preview_options.some((option) => option.benchmark_id === current)) return current
      if (live_benchmark_id && preview_options.some((option) => option.benchmark_id === live_benchmark_id)) {
        return live_benchmark_id
      }
      return preview_options[0]?.benchmark_id
    })
  }, [live_benchmark_id, preview_options])

  useEffect(() => {
    if (!selected_benchmark_id) return
    let cancelled = false
    let interval: number | undefined
    const load = async () => {
      try {
        setIsLoading(true)
        const preview = await getModelSelectedPreview(job_id, selected_benchmark_id)
        if (cancelled) return
        setLoadedPreview({ benchmark_id: selected_benchmark_id, preview })
        setErrorMessage(undefined)
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : "Could not load this benchmark preview.")
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    void load()
    if (!is_complete) interval = window.setInterval(() => void load(), 2_000)
    return () => {
      cancelled = true
      if (interval !== undefined) window.clearInterval(interval)
    }
  }, [is_complete, job_id, selected_benchmark_id])

  const loaded =
    loaded_preview && loaded_preview.benchmark_id === selected_benchmark_id
      ? loaded_preview.preview
      : undefined
  const can_use_live_preview = !selected_benchmark_id || selected_benchmark_id === live_benchmark_id
  const displayed_circuit = loaded?.circuit_preview ?? (can_use_live_preview ? circuit_preview : undefined)
  const displayed_reference =
    loaded?.reference_preview ?? (can_use_live_preview ? reference_preview : undefined)
  const selected_option = preview_options.find((option) => option.benchmark_id === selected_benchmark_id)

  return (
    <div className="model-preview-workspace">
      <div className="model-preview-selector">
        <label>
          <span>Benchmark circuit</span>
          <select
            value={selected_benchmark_id ?? ""}
            disabled={preview_options.length === 0}
            onChange={(event) => setSelectedBenchmarkId(event.target.value)}
          >
            {preview_options.length === 0 && <option value="">Waiting for circuits…</option>}
            {preview_options.map((option) => (
              <option value={option.benchmark_id} key={option.benchmark_id}>
                {option.title}
              </option>
            ))}
          </select>
        </label>
        <span className="model-selected-reference" title={selected_option?.reference_file}>
          Reference: {selected_option?.reference_file ?? "waiting for digitized evidence"}
        </span>
        {is_loading && <LoaderCircle className="spin model-selector-loader" size={14} />}
        {error_message && <small role="alert">{error_message}</small>}
      </div>
      <div className="model-preview-grid">
        <ModelCircuitPreview
          key={`${selected_benchmark_id ?? "live"}:${displayed_circuit?.source_file ?? "pending"}`}
          preview={displayed_circuit}
        />
        <ReferenceGraph preview={displayed_reference} />
      </div>
    </div>
  )
}
