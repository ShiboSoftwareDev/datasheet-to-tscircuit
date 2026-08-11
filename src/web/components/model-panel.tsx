import * as Dialog from "@radix-ui/react-dialog"
import {
  CheckCircle2,
  Clock3,
  Download,
  FileCode2,
  FlaskConical,
  LoaderCircle,
  Plus,
  RotateCcw,
  Square,
  Terminal,
  X,
} from "lucide-react"
import { useEffect, useState } from "react"
import type { Job, ModelRun, ModelRunStatus } from "@/shared/job-types"
import {
  getModelPipelineElapsedTime,
  getModelPipelineProgress,
  getModelRepairElapsedTime,
  isModelRunPaused,
} from "@/shared/model-run-status"
import { isRetainedAcceptedWarning } from "@/shared/model-warnings"
import { getModelRunFileUrl } from "../api"
import type { useModelRun } from "../use-model-run"
import { AgentLogViewer } from "./agent-log-viewer"
import { ModelLivePreview } from "./model-live-preview"

const STATUS_COPY: Record<ModelRunStatus, string> = {
  queued: "Queued",
  setting_up: "Preparing model",
  waiting_for_component: "Waiting for component",
  running: "Building model",
  validating: "Validating model",
  cancelling: "Stopping",
  cancelled: "Stopped",
  complete: "Validated",
  unsupported: "Not simulatable",
  timed_out: "Repair time exhausted",
  failed: "Failed",
}

function getStatusCopy(model_run: ModelRun): string {
  if (isModelRunPaused(model_run)) return "Paused"
  if (model_run.status === "complete" && (model_run.warnings?.length ?? 0) > 0) {
    return "Available with warnings"
  }
  if (
    model_run.status === "complete" &&
    (model_run.validation?.scope?.quality === "scalar_only" ||
      (model_run.validation?.scope?.documented_only_requirement_count ?? 0) > 0)
  ) {
    return "Validated · limited scope"
  }
  if (model_run.status === "timed_out" && model_run.error_message?.toLowerCase().includes("no output")) {
    return "Timed out"
  }
  return STATUS_COPY[model_run.status]
}

function formatDuration(milliseconds: number): string {
  const total_seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(total_seconds / 3600)
  const minutes = Math.floor((total_seconds % 3600) / 60)
  const seconds = total_seconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`
}

export function getModelMatchMetrics(model_run: ModelRun): {
  match_score?: number
  normalized_rmse?: number
} {
  const has_retained_accepted_metrics =
    model_run.validation?.artifact_state !== "candidate" &&
    (model_run.warnings ?? []).some(isRetainedAcceptedWarning)
  const has_scoped_validation_without_curve_metrics =
    model_run.validation?.scope !== undefined && model_run.validation.curve_score === undefined
  const normalized_rmse =
    has_retained_accepted_metrics || has_scoped_validation_without_curve_metrics
      ? undefined
      : model_run.validation?.curve_score !== undefined
        ? model_run.validation.curve_score
        : model_run.validation?.score !== undefined
          ? model_run.validation.score
          : model_run.is_complete
            ? undefined
            : model_run.progress?.champion?.score
  return {
    normalized_rmse,
    match_score: normalized_rmse === undefined ? undefined : Math.max(0, Math.min(1, 1 - normalized_rmse)),
  }
}

function formatModelMetric(value: number | undefined, model_run: ModelRun): string {
  if (value !== undefined) return `${(value * 100).toFixed(1)}%`
  if (model_run.is_complete && (model_run.warnings?.length ?? 0) > 0) return "Unverified"
  if (model_run.is_complete) return "N/A"
  return model_run.has_errors ? "Unavailable" : "Pending"
}

export function getModelHeaderStats(model_run: ModelRun): Array<{
  label: string
  value: string
  title: string
  class_name: string
}> {
  const scope = model_run.validation?.scope
  if (scope && model_run.validation?.curve_score === undefined) {
    return [
      {
        label: "Checks",
        value: `${model_run.validation?.passing_count ?? 0}/${model_run.validation?.benchmark_count ?? 0}`,
        title: "Server-owned validation cases that passed",
        class_name: "model-match-stat",
      },
      {
        label: "Samples",
        value: String(scope.validated_sample_count),
        title: "Numeric simulator samples checked; no reference curve was validated",
        class_name: "model-error-stat",
      },
    ]
  }

  const metrics = getModelMatchMetrics(model_run)
  return [
    {
      label: "Match",
      value: formatModelMetric(metrics.match_score, model_run),
      title: "Derived as 100% minus the weighted normalized RMSE",
      class_name: "model-match-stat",
    },
    {
      label: "NRMSE",
      value: formatModelMetric(metrics.normalized_rmse, model_run),
      title: "Weighted normalized root mean square error",
      class_name: "model-error-stat",
    },
  ]
}

function ModelSourceDialog({ model_run, local_run_id }: { model_run: ModelRun; local_run_id?: string }) {
  const development_model = model_run.development_model
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button type="button" disabled={!development_model}>
          <FileCode2 size={14} /> {development_model ? "View development model" : "Development model pending"}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="model-dialog-overlay" />
        <Dialog.Content className="model-dialog-content">
          <header>
            <div>
              <Dialog.Title>Development SPICE model</Dialog.Title>
              <Dialog.Description>
                model.lib
                {development_model?.manifest.dialect ? ` · ${development_model.manifest.dialect}` : ""}
              </Dialog.Description>
            </div>
            <div className="model-dialog-actions">
              <a href={getModelRunFileUrl(model_run.job_id, "development_model", local_run_id)}>
                <Download size={14} /> Download
              </a>
              <Dialog.Close asChild>
                <button type="button" aria-label="Close model dialog" title="Close model dialog">
                  <X size={16} />
                </button>
              </Dialog.Close>
            </div>
          </header>
          <pre className="model-source-code">
            <code>{development_model?.model_source}</code>
          </pre>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function ModelAgentLogs({
  model_run_state,
  on_close,
}: {
  model_run_state: ReturnType<typeof useModelRun>
  on_close: () => void
}) {
  const { model_run, is_loading, is_cancelling, error_message, cancel, local_run_id, is_read_only } =
    model_run_state
  const is_running = Boolean(model_run && !model_run.is_complete)
  const empty_message = is_loading
    ? "Loading the SPICE model agent…"
    : error_message
      ? error_message
      : "No SPICE model run is available yet."

  return (
    <section className="workspace-card logs-card" aria-label="SPICE model agent logs">
      <header className="card-toolbar dark-toolbar">
        <div className="toolbar-title">
          <Terminal size={16} />
          <span>SPICE model agent</span>
        </div>
        <div className="toolbar-actions">
          {is_running && !is_read_only && (
            <span className="run-indicator">
              <i /> {is_cancelling ? "STOPPING…" : "RUNNING"}
            </span>
          )}
          {is_running && !is_read_only && (
            <button className="stop-run-button" type="button" disabled={is_cancelling} onClick={cancel}>
              <Square size={9} fill="currentColor" />
              {is_cancelling ? "Stopping…" : "Stop run"}
            </button>
          )}
          {model_run && (
            <a
              className="toolbar-icon-link"
              href={getModelRunFileUrl(model_run.job_id, "log", local_run_id)}
              aria-label="Download complete SPICE model log"
            >
              <Download size={15} />
            </a>
          )}
          <button
            className="terminal-close-button"
            type="button"
            aria-label="Close agent terminal"
            title="Close agent terminal"
            onClick={on_close}
          >
            <X size={18} />
          </button>
        </div>
      </header>
      <AgentLogViewer
        className="terminal-window"
        empty_message={empty_message}
        is_running={is_running}
        logs={model_run?.logs ?? []}
      />
    </section>
  )
}

export function ModelPanel({
  job,
  model_run_state,
}: {
  job: Job
  model_run_state: ReturnType<typeof useModelRun>
}) {
  const {
    model_run,
    is_loading,
    is_starting,
    is_extending,
    is_cancelling,
    is_retrying,
    error_message,
    start,
    extend,
    cancel,
    retry,
    local_run_id,
    is_read_only,
  } = model_run_state
  const [effort, setEffort] = useState(1)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if ((!model_run?.segment_started_at && !model_run?.repair_started_at) || model_run.is_complete) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [model_run])

  if (is_loading) {
    return (
      <section className="model-empty-state">
        <LoaderCircle className="spin" size={26} /> Loading model run…
      </section>
    )
  }

  if (!model_run) {
    if (is_read_only) {
      return (
        <section className="model-empty-state">
          <FlaskConical size={26} /> This Local run has no SPICE model output.
        </section>
      )
    }
    return (
      <section className="model-start-card">
        <span className="eyebrow">
          <FlaskConical size={14} /> SPICE model generator · tscircuit validation
        </span>
        <h2>Build and validate a simulation model.</h2>
        <p>
          A typed pipeline characterizes the datasheet, designs a declarative fixture plan, generates the
          model, and validates it with server-owned tscircuit simulations. The component interface, test plan,
          scoring, and publication stay server-owned.
        </p>
        <fieldset className="effort-picker" aria-label="Modeling effort">
          {[1, 2, 4, 8].map((value) => (
            <button
              className={effort === value ? "selected" : ""}
              type="button"
              key={value}
              onClick={() => setEffort(value)}
            >
              <strong>{value}×</strong>
              <small>{value * 30} min repair</small>
            </button>
          ))}
        </fieldset>
        {error_message && (
          <p className="form-error" role="alert">
            {error_message}
          </p>
        )}
        <button
          className="primary-button model-start-button"
          type="button"
          disabled={is_starting}
          onClick={() => start(effort)}
        >
          {is_starting ? (
            <>
              <LoaderCircle className="spin" size={17} /> Starting model run…
            </>
          ) : (
            <>
              <FlaskConical size={17} /> Create SPICE model
            </>
          )}
        </button>
      </section>
    )
  }

  const elapsed_time = getModelPipelineElapsedTime(model_run, now)
  const repair_time = getModelRepairElapsedTime(model_run, now)
  const stage_progress = getModelPipelineProgress(model_run)
  const progress = stage_progress.total > 0 ? (stage_progress.completed / stage_progress.total) * 100 : 0
  const is_running = !model_run.is_complete
  const is_restartable = model_run.is_complete
  const is_waiting = model_run.status === "queued" || model_run.status === "waiting_for_component"
  const header_stats = getModelHeaderStats(model_run)
  const is_paused = isModelRunPaused(model_run)

  return (
    <div className="model-workspace">
      <section className={`model-run-header model-status-${is_paused ? "paused" : model_run.status}`}>
        <div className="model-header-copy">
          <div className="model-header-title-row">
            <h2>{model_run.manifest?.part_number ?? job.file_name.replace(/\.pdf$/i, "")}</h2>
            <span className="model-status-label">
              {is_running && model_run.status !== "cancelling" ? (
                <LoaderCircle className="spin" size={14} />
              ) : model_run.status === "complete" && !is_paused ? (
                <CheckCircle2 size={14} />
              ) : (
                <FlaskConical size={14} />
              )}
              {getStatusCopy(model_run)}
            </span>
          </div>
        </div>

        <section className="model-header-stats" aria-label="Current model statistics">
          {header_stats.map((stat) => (
            <div className={`model-header-stat ${stat.class_name}`} title={stat.title} key={stat.label}>
              <span>{stat.label}</span>
              <strong>{stat.value}</strong>
            </div>
          ))}
        </section>

        <div className="model-header-actions">
          <ModelSourceDialog model_run={model_run} local_run_id={local_run_id} />
          {is_restartable && !is_read_only && (
            <button type="button" disabled={is_retrying} onClick={retry}>
              {is_retrying ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}
              {is_retrying ? "Restarting…" : "Restart SPICE generation"}
            </button>
          )}
          {!is_read_only && (
            <button
              type="button"
              disabled={
                is_extending ||
                model_run.effort_multiplier >= 8 ||
                model_run.status === "validating" ||
                model_run.status === "cancelling"
              }
              onClick={() => extend(1)}
            >
              {is_extending ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />} Add 1× effort
            </button>
          )}
          {is_running && !is_read_only && (
            <button className="model-stop-button" type="button" disabled={is_cancelling} onClick={cancel}>
              <Square size={9} fill="currentColor" /> {is_cancelling ? "Stopping…" : "Stop"}
            </button>
          )}
        </div>

        <div className="model-header-progress">
          <div className="model-progress-copy">
            <span>
              <Clock3 size={14} />
              {is_waiting ? "Waiting to start" : `${formatDuration(elapsed_time)} total`}
            </span>
            <span>
              {stage_progress.completed}/{stage_progress.total || 8} stages ·{" "}
              {formatDuration(repair_time.elapsed)} / {formatDuration(repair_time.budget)} repair
              {model_run.iteration > 0 && ` · repair ${model_run.iteration}`}
            </span>
          </div>
          <div className="model-progress-track">
            <i style={{ width: `${progress}%` }} />
          </div>
        </div>
      </section>

      {error_message && (
        <p className="form-error" role="alert">
          {error_message}
        </p>
      )}

      <ModelLivePreview
        job_id={job.job_id}
        local_run_id={local_run_id}
        is_complete={model_run.is_complete}
        circuit_preview={model_run.circuit_preview}
        reference_preview={model_run.reference_preview}
        preview_options={model_run.preview_options}
        found_references={model_run.found_references ?? []}
        preview_generation={model_run.validation?.preview_generation}
        model_revision={model_run.validation?.model_revision}
      />
    </div>
  )
}
