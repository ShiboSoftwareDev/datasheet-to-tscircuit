import * as Dialog from "@radix-ui/react-dialog"
import * as Popover from "@radix-ui/react-popover"
import {
  CheckCircle2,
  ChevronDown,
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
import type { Job, ModelProgressPhase, ModelRun, ModelRunStatus } from "@/shared/job-types"
import { getModelRunFileUrl } from "../api"
import type { useModelRun } from "../use-model-run"
import { AgentLogViewer } from "./agent-log-viewer"
import { ModelLivePreview } from "./model-live-preview"

const STATUS_COPY: Record<ModelRunStatus, string> = {
  queued: "Queued",
  setting_up: "Preparing references",
  waiting_for_component: "Waiting for component",
  running: "Refining model",
  validating: "Validating champion",
  cancelling: "Stopping",
  cancelled: "Stopped",
  complete: "Validated",
  timed_out: "Ran out of iterations",
  failed: "Failed",
}

function getStatusCopy(model_run: ModelRun): string {
  if (model_run.status === "timed_out" && model_run.error_message?.toLowerCase().includes("no output")) {
    return "Timed out"
  }
  return STATUS_COPY[model_run.status]
}

function getProgressPhaseCopy(model_run: ModelRun): string {
  if (
    model_run.progress?.phase === "timed_out" &&
    !model_run.progress.message.toLowerCase().includes("no output")
  ) {
    return "Ran out of iterations"
  }
  return PROGRESS_PHASE_COPY[model_run.progress?.phase ?? "queued"]
}

const PROGRESS_PHASE_COPY: Record<ModelProgressPhase, string> = {
  queued: "Queued",
  extracting_datasheet: "Reading datasheet",
  digitizing_graphs: "Digitizing graphs",
  preparing_benchmarks: "Preparing references",
  waiting_for_component: "Waiting for component",
  locking_benchmarks: "Locking benchmarks",
  building_baseline: "Building baseline",
  simulating: "Simulating",
  scoring: "Scoring",
  refining: "Refining model",
  finalizing: "Finalizing champion",
  validating: "Validating champion",
  complete: "Complete",
  timed_out: "Timed out",
  failed: "Failed",
  cancelled: "Stopped",
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

function getElapsedTime(model_run: ModelRun, now: number): number {
  if (!model_run.segment_started_at) return model_run.elapsed_time_ms
  const segment_start = new Date(model_run.segment_started_at).valueOf()
  return model_run.elapsed_time_ms + (Number.isFinite(segment_start) ? Math.max(0, now - segment_start) : 0)
}

function formatProgressTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return "now"
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export function getModelMatchMetrics(model_run: ModelRun): {
  match_score?: number
  normalized_rmse?: number
} {
  const normalized_rmse = model_run.validation?.score ?? model_run.progress?.champion?.score
  return {
    normalized_rmse,
    match_score: normalized_rmse === undefined ? undefined : Math.max(0, Math.min(1, 1 - normalized_rmse)),
  }
}

function formatModelMetric(value: number | undefined, model_run: ModelRun): string {
  if (value !== undefined) return `${(value * 100).toFixed(1)}%`
  return model_run.has_errors ? "Unavailable" : "Pending"
}

function PreviousTasks({ model_run, current_task }: { model_run: ModelRun; current_task: string }) {
  const history = model_run.progress_history
    .filter((event) => event.sequence !== model_run.progress?.sequence)
    .slice(-8)
    .reverse()

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          className="model-header-stat model-current-task-stat model-history-trigger"
          type="button"
          disabled={history.length === 0}
          title={history.length === 0 ? "No previous tasks" : "Show previous tasks"}
        >
          <span>Current task</span>
          <span className="model-current-task-row">
            <strong title={current_task}>{current_task}</strong>
            <ChevronDown size={18} />
          </span>
          <small>
            {getProgressPhaseCopy(model_run)}
            {model_run.progress ? ` · updated ${formatProgressTime(model_run.progress.updated_at)}` : ""}
          </small>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="model-history-popover" align="start" side="bottom" sideOffset={3}>
          <header>
            <strong>Previous tasks</strong>
            <small>{history.length} recent</small>
          </header>
          <ol>
            {history.map((event) => (
              <li key={`${event.sequence}-${event.updated_at}`}>
                <i />
                <span>
                  <strong>{PROGRESS_PHASE_COPY[event.phase]}</strong>
                  <small>{event.message}</small>
                </span>
                <time dateTime={event.updated_at}>{formatProgressTime(event.updated_at)}</time>
              </li>
            ))}
          </ol>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function ModelSourceDialog({ model_run }: { model_run: ModelRun }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button type="button" disabled={!model_run.model_source}>
          <FileCode2 size={14} /> {model_run.model_source ? "View model" : "Model pending"}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="model-dialog-overlay" />
        <Dialog.Content className="model-dialog-content">
          <header>
            <div>
              <Dialog.Title>SPICE model</Dialog.Title>
              <Dialog.Description>
                model.lib{model_run.manifest?.dialect ? ` · ${model_run.manifest.dialect}` : ""}
              </Dialog.Description>
            </div>
            <div className="model-dialog-actions">
              <a href={getModelRunFileUrl(model_run.job_id, "model")}>
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
            <code>{model_run.model_source}</code>
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
  const { model_run, is_loading, is_cancelling, error_message, cancel } = model_run_state
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
          {is_running && (
            <span className="run-indicator">
              <i /> {is_cancelling ? "STOPPING…" : "RUNNING"}
            </span>
          )}
          {is_running && (
            <button className="stop-run-button" type="button" disabled={is_cancelling} onClick={cancel}>
              <Square size={9} fill="currentColor" />
              {is_cancelling ? "Stopping…" : "Stop run"}
            </button>
          )}
          {model_run && (
            <a
              className="toolbar-icon-link"
              href={getModelRunFileUrl(model_run.job_id, "log")}
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
  } = model_run_state
  const [effort, setEffort] = useState(1)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!model_run?.segment_started_at || model_run.is_complete) return
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
    return (
      <section className="model-start-card">
        <span className="eyebrow">
          <FlaskConical size={14} /> SPICE model generator · ngspice validation
        </span>
        <h2>Build and validate a simulation model.</h2>
        <p>
          Reference extraction starts immediately and runs alongside component generation. When the component
          is ready, a separate untimed pass finalizes the benchmark suite; the server locks it before starting
          the time-budgeted refinement loop.
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
              <small>{value === 1 ? "Baseline time" : `${value}× iteration time`}</small>
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

  const elapsed_time = Math.min(getElapsedTime(model_run, now), model_run.allocated_time_ms)
  const progress =
    model_run.allocated_time_ms > 0 ? Math.min(100, (elapsed_time / model_run.allocated_time_ms) * 100) : 0
  const is_running = !model_run.is_complete
  const is_untimed =
    model_run.status === "queued" ||
    model_run.status === "setting_up" ||
    model_run.status === "waiting_for_component"
  const current_task = model_run.error_message ?? model_run.progress?.message ?? getStatusCopy(model_run)
  const match_metrics = getModelMatchMetrics(model_run)

  return (
    <div className="model-workspace">
      <section className={`model-run-header model-status-${model_run.status}`}>
        <div className="model-header-copy">
          <div className="model-header-title-row">
            <h2>{model_run.manifest?.part_number ?? job.file_name.replace(/\.pdf$/i, "")}</h2>
            <span className="model-status-label">
              {is_running && model_run.status !== "cancelling" ? (
                <LoaderCircle className="spin" size={14} />
              ) : model_run.status === "complete" ? (
                <CheckCircle2 size={14} />
              ) : (
                <FlaskConical size={14} />
              )}
              {getStatusCopy(model_run)}
            </span>
          </div>
        </div>

        <section className="model-header-stats" aria-label="Current model statistics">
          <div
            className="model-header-stat model-match-stat"
            title="Derived as 100% minus the weighted normalized RMSE"
          >
            <span>Match</span>
            <strong>{formatModelMetric(match_metrics.match_score, model_run)}</strong>
          </div>
          <div className="model-header-stat model-error-stat">
            <span>NRMSE</span>
            <strong>{formatModelMetric(match_metrics.normalized_rmse, model_run)}</strong>
          </div>
          <PreviousTasks model_run={model_run} current_task={current_task} />
        </section>

        <div className="model-header-actions">
          <ModelSourceDialog model_run={model_run} />
          {model_run.status === "failed" && (
            <button type="button" disabled={is_retrying} onClick={retry}>
              {is_retrying ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}
              {is_retrying ? "Retrying…" : "Retry failed run"}
            </button>
          )}
          <button
            type="button"
            disabled={is_extending || model_run.status === "validating" || model_run.status === "cancelling"}
            onClick={() => extend(1)}
          >
            {is_extending ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />} Add 1× effort
          </button>
          {is_running && (
            <button className="model-stop-button" type="button" disabled={is_cancelling} onClick={cancel}>
              <Square size={9} fill="currentColor" /> {is_cancelling ? "Stopping…" : "Stop"}
            </button>
          )}
        </div>

        <div className="model-header-progress">
          <div className="model-progress-copy">
            <span>
              <Clock3 size={14} />
              {is_untimed
                ? "Refinement timer not started"
                : `${formatDuration(elapsed_time)} / ${formatDuration(model_run.allocated_time_ms)}`}
            </span>
            <span>
              {model_run.effort_multiplier}× effort
              {!is_untimed && ` · iteration ${model_run.iteration}`}
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
        is_complete={model_run.is_complete}
        circuit_preview={model_run.circuit_preview}
        reference_preview={model_run.reference_preview}
        preview_options={model_run.preview_options}
      />
    </div>
  )
}
