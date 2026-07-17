import {
  Activity,
  AlertTriangle,
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
} from "lucide-react"
import { useEffect, useState } from "react"
import type { Job, ModelProgressPhase, ModelRun, ModelRunStatus } from "@/shared/job-types"
import { getModelRunFileUrl } from "../api"
import { getChampionValidationCopy } from "../model-validation-copy"
import { useModelRun } from "../use-model-run"
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

function ModelRunLogs({ model_run }: { model_run: ModelRun }) {
  return (
    <section className="model-subcard model-log-card" aria-label="SPICE model agent logs">
      <header>
        <span>
          <Terminal size={15} /> Model agent
        </span>
        <a href={getModelRunFileUrl(model_run.job_id, "log")} aria-label="Download model log">
          <Download size={14} /> Log
        </a>
      </header>
      <AgentLogViewer
        className="model-terminal"
        empty_message="Waiting for the model agent…"
        is_running={!model_run.is_complete}
        logs={model_run.logs}
      />
    </section>
  )
}

function formatProgressTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return "now"
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function LiveProgress({ model_run }: { model_run: ModelRun }) {
  const progress = model_run.progress
  const history = model_run.progress_history.slice(-6).reverse()
  const evidence = progress?.evidence
  const benchmark = progress?.benchmark
  const champion = progress?.champion
  const has_metrics = Boolean(
    progress?.iteration !== undefined ||
      evidence?.pages_reviewed !== undefined ||
      evidence?.graphs_found !== undefined ||
      evidence?.graphs_digitized !== undefined ||
      evidence?.benchmark_drafts !== undefined ||
      benchmark?.completed !== undefined ||
      benchmark?.locked_total !== undefined ||
      champion?.passing !== undefined,
  )

  return (
    <div className="model-live-panel" aria-label="Live model progress">
      {!progress ? (
        <p className="model-muted-copy" aria-live="polite">
          Waiting for the first progress checkpoint…
        </p>
      ) : (
        <div className="model-live-body" aria-live="polite">
          <div className="model-current-progress">
            <span>{getProgressPhaseCopy(model_run)}</span>
            <strong>{progress.message}</strong>
            <small>
              Updated {formatProgressTime(progress.updated_at)} · checkpoint {progress.sequence}
            </small>
          </div>

          {has_metrics && (
            <div className="model-live-metrics">
              {evidence?.pages_reviewed !== undefined && (
                <div>
                  <span>Pages reviewed</span>
                  <strong>{evidence.pages_reviewed}</strong>
                </div>
              )}
              {evidence?.graphs_found !== undefined && (
                <div>
                  <span>Graphs found</span>
                  <strong>{evidence.graphs_found}</strong>
                </div>
              )}
              {evidence?.graphs_digitized !== undefined && (
                <div>
                  <span>Graphs digitized</span>
                  <strong>{evidence.graphs_digitized}</strong>
                </div>
              )}
              {evidence?.benchmark_drafts !== undefined && (
                <div>
                  <span>Benchmark drafts</span>
                  <strong>{evidence.benchmark_drafts}</strong>
                </div>
              )}
              {progress.iteration !== undefined && (
                <div>
                  <span>Iteration</span>
                  <strong>{progress.iteration}</strong>
                </div>
              )}
              {benchmark?.completed !== undefined && (
                <div>
                  <span>Benchmarks run</span>
                  <strong>
                    {benchmark.completed}
                    {benchmark.total !== undefined ? `/${benchmark.total}` : ""}
                  </strong>
                </div>
              )}
              {benchmark?.locked_total !== undefined && (
                <div>
                  <span>Executable benchmarks</span>
                  <strong>
                    {benchmark.locked_total}
                    {benchmark.draft_total !== undefined ? `/${benchmark.draft_total} drafts` : ""}
                  </strong>
                </div>
              )}
              {benchmark?.omitted !== undefined && benchmark.omitted > 0 && (
                <div>
                  <span>Evidence-only drafts</span>
                  <strong>{benchmark.omitted}</strong>
                </div>
              )}
              {champion?.passing !== undefined && (
                <div>
                  <span>Champion validation</span>
                  <strong>{getChampionValidationCopy(model_run.validation)}</strong>
                </div>
              )}
              {champion?.score !== undefined && (
                <div>
                  <span>Weighted error</span>
                  <strong>{(champion.score * 100).toFixed(1)}%</strong>
                </div>
              )}
            </div>
          )}

          {(benchmark?.current || champion?.revision) && (
            <div className="model-live-detail">
              {benchmark?.current && (
                <span>
                  Current benchmark <strong>{benchmark.current}</strong>
                </span>
              )}
              {champion?.revision && (
                <span>
                  Champion <strong>{champion.revision}</strong>
                  {champion.worst_normalized_error !== undefined &&
                    ` · worst error ${(champion.worst_normalized_error * 100).toFixed(1)}%`}
                </span>
              )}
            </div>
          )}

          {history.length > 0 && (
            <ol className="model-progress-history" aria-label="Recent progress checkpoints">
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
          )}
        </div>
      )}
    </div>
  )
}

function ValidationSummary({ model_run }: { model_run: ModelRun }) {
  const validation = model_run.validation
  if (!validation) return null

  return (
    <section className="model-validation-card">
      <header>
        <span>
          <FlaskConical size={15} /> Validation
        </span>
        <strong>
          {validation.passing_count}/{validation.benchmark_count} passing
        </strong>
      </header>
      <div className="benchmark-list">
        {validation.benchmarks.map((benchmark) => (
          <div
            className={`benchmark-row ${benchmark.passed ? "passed" : "failed"}`}
            key={benchmark.benchmark_id}
          >
            {benchmark.passed ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
            <span>
              <strong>{benchmark.title}</strong>
              <small>
                {benchmark.error_message ??
                  `NRMSE ${((benchmark.normalized_rmse ?? 0) * 100).toFixed(1)}% · limit ${(benchmark.tolerance * 100).toFixed(1)}%${benchmark.critical ? " · critical" : ""}`}
              </small>
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function ModelSummaryTabs({ model_run }: { model_run: ModelRun }) {
  const [active_tab, setActiveTab] = useState<"progress" | "model">("progress")

  return (
    <section className="model-subcard model-summary-tabs" aria-label="SPICE model progress and output">
      <header className="model-summary-tabs-header">
        <div className="model-summary-tab-list" role="tablist" aria-label="SPICE model details">
          <button
            id="model-progress-tab"
            className={active_tab === "progress" ? "active" : ""}
            type="button"
            role="tab"
            aria-selected={active_tab === "progress"}
            aria-controls="model-progress-panel"
            onClick={() => setActiveTab("progress")}
          >
            <Activity size={14} /> Progress
          </button>
          <button
            id="model-output-tab"
            className={active_tab === "model" ? "active" : ""}
            type="button"
            role="tab"
            aria-selected={active_tab === "model"}
            aria-controls="model-output-panel"
            onClick={() => setActiveTab("model")}
          >
            <FileCode2 size={14} /> Model
          </button>
        </div>
        {active_tab === "progress" && !model_run.is_complete && (
          <strong className="model-live-indicator">
            <i /> Live
          </strong>
        )}
      </header>

      {active_tab === "progress" ? (
        <div
          id="model-progress-panel"
          className="model-summary-tab-panel"
          role="tabpanel"
          aria-labelledby="model-progress-tab"
        >
          <LiveProgress model_run={model_run} />
          <ValidationSummary model_run={model_run} />
        </div>
      ) : (
        <div
          id="model-output-panel"
          className="model-summary-tab-panel model-output-panel"
          role="tabpanel"
          aria-labelledby="model-output-tab"
        >
          {model_run.model_source ? (
            <>
              <div className="model-output-toolbar">
                <span>model.lib · {model_run.manifest?.dialect}</span>
                <div className="model-downloads">
                  <a href={getModelRunFileUrl(model_run.job_id, "model")}>
                    <Download size={13} /> Model
                  </a>
                  <a href={getModelRunFileUrl(model_run.job_id, "component")}>
                    <Download size={13} /> Component
                  </a>
                  <a href={getModelRunFileUrl(model_run.job_id, "report")}>
                    <Download size={13} /> Report
                  </a>
                  <a href={getModelRunFileUrl(model_run.job_id, "model_card")}>
                    <Download size={13} /> Model card
                  </a>
                </div>
              </div>
              <pre className="model-source-code">
                <code>{model_run.model_source}</code>
              </pre>
            </>
          ) : (
            <div className="model-output-empty">
              <FileCode2 size={24} />
              <strong>Waiting for the first model</strong>
              <p>The generated model source will appear here as soon as the agent saves a candidate.</p>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export function ModelPanel({ job }: { job: Job }) {
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
  } = useModelRun(job.job_id)
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
        <div className="effort-picker" role="group" aria-label="Modeling effort">
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
        </div>
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
          <p>
            {model_run.error_message ??
              "The fixed workflow and benchmark suite are unchanged across effort levels."}
          </p>
        </div>
        <div className="model-header-actions">
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
      </section>

      <section className="model-progress-card">
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
      </section>

      {error_message && (
        <p className="form-error" role="alert">
          {error_message}
        </p>
      )}

      <div className="model-grid">
        <ModelRunLogs model_run={model_run} />
        <ModelSummaryTabs model_run={model_run} />
      </div>

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
