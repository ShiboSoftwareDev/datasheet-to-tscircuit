import { Bug, CheckCircle2, Circle, CircleAlert, LoaderCircle, Play, RotateCcw, X } from "lucide-react"
import { useState } from "react"
import type { Job, ModelRun, PublicPipelineSnapshot, PublicPipelineStage } from "@/shared/job-types"
import type { LocalRunSummary } from "@/shared/local-run"
import { type DebugPipelineId, type DebugRunMode, PIPELINE_DEBUG_CATALOG } from "@/shared/pipeline-debug"
import { runPipelineDebug } from "../api"

const PIPELINE_STAGE_STATUSES = new Set(["pending", "running", "completed", "skipped", "failed", "cancelled"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function projectLocalPipelineSnapshot(local_run: LocalRunSummary): PublicPipelineSnapshot | undefined {
  const pipeline = PIPELINE_DEBUG_CATALOG.find(({ pipeline_id }) => pipeline_id === local_run.pipeline_id)
  if (!pipeline || !isRecord(local_run.stage_results)) return undefined
  const stage_results: Record<string, PublicPipelineStage> = {}
  for (const stage_id of pipeline.stages) {
    const value = local_run.stage_results[stage_id]
    if (!isRecord(value) || typeof value.status !== "string" || !PIPELINE_STAGE_STATUSES.has(value.status)) {
      continue
    }
    const error = isRecord(value.error) && typeof value.error.message === "string" ? value.error : undefined
    stage_results[stage_id] = {
      stage_id,
      status: value.status as PublicPipelineStage["status"],
      debug_ref: typeof value.debug_ref === "string" ? value.debug_ref : "",
      ...(typeof value.started_at === "string" ? { started_at: value.started_at } : {}),
      ...(typeof value.completed_at === "string" ? { completed_at: value.completed_at } : {}),
      ...(typeof value.duration_ms === "number" ? { duration_ms: value.duration_ms } : {}),
      ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
      ...(error
        ? {
            error: {
              code: typeof error.code === "string" ? error.code : "local_stage_failed",
              message: error.message as string,
              operation: typeof error.operation === "string" ? error.operation : stage_id,
              retryable: error.retryable === true,
              ...(typeof error.hint === "string" ? { hint: error.hint } : {}),
            },
          }
        : {}),
    }
  }
  return {
    pipeline_id: local_run.pipeline_id,
    status: local_run.status,
    sequence: Object.keys(stage_results).length,
    started_at: local_run.created_at,
    updated_at: local_run.completed_at ?? local_run.created_at,
    stage_results,
  }
}

function stageLabel(stage_id: string): string {
  return stage_id
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

function getSnapshot(
  pipeline_id: DebugPipelineId,
  job: Job,
  model_run?: ModelRun,
): PublicPipelineSnapshot | undefined {
  if (pipeline_id === "component_generation") {
    return job.pipelines?.component_generation ?? job.pipeline
  }
  if (pipeline_id === "typical_application") return job.pipelines?.typical_application
  return model_run?.pipeline
}

function StageStatus({ stage }: { stage?: PublicPipelineStage }) {
  if (!stage || stage.status === "pending") {
    return (
      <span className="pipeline-stage-status status-pending">
        <Circle size={11} /> Pending
      </span>
    )
  }
  if (stage.status === "running") {
    return (
      <span className="pipeline-stage-status status-running">
        <LoaderCircle className="spin" size={12} /> Running
      </span>
    )
  }
  if (stage.status === "completed") {
    return (
      <span className="pipeline-stage-status status-completed">
        <CheckCircle2 size={12} /> Complete
      </span>
    )
  }
  if (stage.status === "failed") {
    return (
      <span className="pipeline-stage-status status-failed">
        <CircleAlert size={12} /> Failed
      </span>
    )
  }
  return <span className="pipeline-stage-status status-muted">{stage.status}</span>
}

export function PipelineDebugger({
  job,
  model_run,
  local_run,
  is_rerunning_local = false,
  on_local_run_started,
  on_rerun_local,
}: {
  job: Job
  model_run?: ModelRun
  local_run?: LocalRunSummary
  is_rerunning_local?: boolean
  on_local_run_started?: (local_run: LocalRunSummary) => void
  on_rerun_local?: (local_run_id: string) => void
}) {
  const [active_pipeline_id, setActivePipelineId] = useState<DebugPipelineId>()
  const [pending_action, setPendingAction] = useState<string>()
  const [error_message, setErrorMessage] = useState<string>()
  const active_pipeline = PIPELINE_DEBUG_CATALOG.find(({ pipeline_id }) => pipeline_id === active_pipeline_id)
  const local_snapshot = local_run ? projectLocalPipelineSnapshot(local_run) : undefined
  const snapshot = active_pipeline_id
    ? local_run
      ? active_pipeline_id === local_run.pipeline_id
        ? local_snapshot
        : undefined
      : getSnapshot(active_pipeline_id, job, model_run)
    : undefined

  const start = async (mode: DebugRunMode, stage_id?: string) => {
    if (!active_pipeline_id || local_run || !on_local_run_started) return
    const action = `${mode}:${stage_id ?? "all"}`
    setPendingAction(action)
    setErrorMessage(undefined)
    try {
      const localRun = await runPipelineDebug({
        job_id: job.job_id,
        pipeline_id: active_pipeline_id,
        mode,
        stage_id,
      })
      on_local_run_started(localRun)
      setActivePipelineId(undefined)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setPendingAction(undefined)
    }
  }

  return (
    <>
      <div className="pipeline-debug-buttons" aria-label="Pipeline debuggers">
        {PIPELINE_DEBUG_CATALOG.map((pipeline) => {
          const pipeline_snapshot = getSnapshot(pipeline.pipeline_id, job, model_run)
          const is_local_pipeline = local_run?.pipeline_id === pipeline.pipeline_id
          const button_status = local_run
            ? is_local_pipeline
              ? local_run.status
              : undefined
            : pipeline_snapshot?.status
          const disabled = local_run
            ? !is_local_pipeline
            : !job.is_complete ||
              (pipeline.pipeline_id === "spice_generation" && !model_run) ||
              pipeline_snapshot?.status === "running"
          return (
            <button
              type="button"
              key={pipeline.pipeline_id}
              disabled={disabled}
              onClick={() => {
                setErrorMessage(undefined)
                setActivePipelineId(pipeline.pipeline_id)
              }}
              title={
                local_run
                  ? is_local_pipeline
                    ? `Inspect Local ${pipeline.title} pipeline`
                    : `${pipeline.title} was not run by this Local run`
                  : `Debug ${pipeline.title} pipeline`
              }
            >
              {button_status === "running" ? <LoaderCircle className="spin" size={12} /> : <Bug size={12} />}
              {pipeline.title}
            </button>
          )
        })}
      </div>

      {active_pipeline && active_pipeline_id && (
        <div
          className="pipeline-debug-backdrop"
          role="presentation"
          onMouseDown={() => setActivePipelineId(undefined)}
        >
          <section
            className="pipeline-debug-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pipeline-debug-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="eyebrow">
                  <Bug size={13} /> {local_run ? "Local pipeline" : "Pipeline debugger"}
                </span>
                <h2 id="pipeline-debug-title">{active_pipeline.title}</h2>
                <p>{active_pipeline.description}</p>
              </div>
              <button
                type="button"
                aria-label="Close pipeline debugger"
                onClick={() => setActivePipelineId(undefined)}
              >
                <X size={17} />
              </button>
            </header>

            <div className="pipeline-debug-runbar">
              <div>
                <strong>{snapshot?.status ?? "Not run"}</strong>
                <span>
                  {local_run && snapshot
                    ? `${
                        local_run.mode === "pipeline"
                          ? "Whole pipeline"
                          : local_run.mode === "task"
                            ? `Only ${stageLabel(local_run.task_id ?? "task")}`
                            : `From ${stageLabel(local_run.task_id ?? "task")}`
                      } · ${Object.values(snapshot.stage_results).filter(({ status }) => status !== "skipped").length} of ${active_pipeline.stages.length} tasks executed`
                    : snapshot
                      ? `Latest invocation · ${snapshot.sequence} events`
                      : "Run the pipeline once to retain inputs for individual step reruns."}
                </span>
              </div>
              {local_run ? (
                <button
                  className="primary-button"
                  type="button"
                  disabled={local_run.status === "running" || is_rerunning_local || !on_rerun_local}
                  onClick={() => on_rerun_local?.(local_run.local_run_id)}
                >
                  {is_rerunning_local ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}
                  Run again locally
                </button>
              ) : (
                <button
                  className="primary-button"
                  type="button"
                  disabled={Boolean(pending_action) || snapshot?.status === "running"}
                  onClick={() => start("pipeline")}
                >
                  {pending_action === "pipeline:all" ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : snapshot ? (
                    <RotateCcw size={14} />
                  ) : (
                    <Play size={14} />
                  )}
                  Run whole pipeline locally
                </button>
              )}
            </div>

            {error_message && (
              <p className="pipeline-debug-error" role="alert">
                {error_message}
              </p>
            )}

            <ol className="pipeline-stage-list">
              {active_pipeline.stages.map((stage_id, index) => {
                const stage = snapshot?.stage_results[stage_id]
                const has_retained_input = index === 0 || Boolean(stage)
                const busy = Boolean(pending_action) || snapshot?.status === "running"
                return (
                  <li key={stage_id}>
                    <span className="pipeline-stage-number">{String(index + 1).padStart(2, "0")}</span>
                    <div className="pipeline-stage-copy">
                      <strong>{stageLabel(stage_id)}</strong>
                      {stage?.error ? <small>{stage.error.message}</small> : <code>{stage_id}</code>}
                    </div>
                    <StageStatus stage={stage} />
                    <span className="pipeline-stage-duration">
                      {stage?.duration_ms === undefined ? "—" : `${(stage.duration_ms / 1000).toFixed(1)}s`}
                    </span>
                    <div className="pipeline-stage-actions">
                      {local_run ? (
                        <>
                          <button
                            type="button"
                            disabled={
                              local_run.mode !== "task" ||
                              local_run.task_id !== stage_id ||
                              local_run.status === "running" ||
                              is_rerunning_local ||
                              !on_rerun_local
                            }
                            title="Rerun this Local task from the same captured input"
                            onClick={() => on_rerun_local?.(local_run.local_run_id)}
                          >
                            <Play size={12} />
                            Run step locally
                          </button>
                          <button
                            type="button"
                            disabled={
                              local_run.mode !== "from_task" ||
                              local_run.task_id !== stage_id ||
                              local_run.status === "running" ||
                              is_rerunning_local ||
                              !on_rerun_local
                            }
                            title="Rerun this Local sequence from the same captured input"
                            onClick={() => on_rerun_local?.(local_run.local_run_id)}
                          >
                            <RotateCcw size={12} />
                            Run locally from here
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={busy || !has_retained_input}
                            title={
                              has_retained_input
                                ? `Run only ${stageLabel(stage_id)}`
                                : "Run the full pipeline once to capture this step input"
                            }
                            onClick={() => start("stage", stage_id)}
                          >
                            {pending_action === `stage:${stage_id}` ? (
                              <LoaderCircle className="spin" size={12} />
                            ) : (
                              <Play size={12} />
                            )}
                            Run step locally
                          </button>
                          <button
                            type="button"
                            disabled={busy || !has_retained_input}
                            title={`Rerun ${stageLabel(stage_id)} and every following step`}
                            onClick={() => start("from_stage", stage_id)}
                          >
                            {pending_action === `from_stage:${stage_id}` ? (
                              <LoaderCircle className="spin" size={12} />
                            ) : (
                              <RotateCcw size={12} />
                            )}
                            Run locally from here
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          </section>
        </div>
      )}
    </>
  )
}
