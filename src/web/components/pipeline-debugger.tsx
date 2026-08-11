import { Bug, CheckCircle2, Circle, CircleAlert, LoaderCircle, Play, RotateCcw, X } from "lucide-react"
import { useState } from "react"
import type { Job, ModelRun, PublicPipelineSnapshot, PublicPipelineStage } from "@/shared/job-types"
import type { LocalRunSummary } from "@/shared/local-run"
import { type DebugPipelineId, type DebugRunMode, PIPELINE_DEBUG_CATALOG } from "@/shared/pipeline-debug"
import { runPipelineDebug } from "../api"

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
    if (stage.error?.code === "no_eligible_time_domain_graph") {
      return (
        <span className="pipeline-stage-status status-muted">
          <CircleAlert size={12} /> Unsupported
        </span>
      )
    }
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
  on_run_started,
}: {
  job: Job
  model_run?: ModelRun
  on_run_started: (local_run: LocalRunSummary) => void
}) {
  const [active_pipeline_id, setActivePipelineId] = useState<DebugPipelineId>()
  const [pending_action, setPendingAction] = useState<string>()
  const [error_message, setErrorMessage] = useState<string>()
  const active_pipeline = PIPELINE_DEBUG_CATALOG.find(({ pipeline_id }) => pipeline_id === active_pipeline_id)
  const snapshot = active_pipeline_id ? getSnapshot(active_pipeline_id, job, model_run) : undefined

  const start = async (mode: DebugRunMode, stage_id?: string) => {
    if (!active_pipeline_id) return
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
      on_run_started(localRun)
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
          return (
            <button
              type="button"
              key={pipeline.pipeline_id}
              onClick={() => {
                setErrorMessage(undefined)
                setActivePipelineId(pipeline.pipeline_id)
              }}
              title={`Debug ${pipeline.title} pipeline`}
            >
              <Bug size={12} />
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
                  <Bug size={13} /> Pipeline debugger
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
                  {snapshot
                    ? `Latest invocation · ${snapshot.sequence} events`
                    : "Run the pipeline once to retain inputs for individual step reruns."}
                </span>
              </div>
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
                Run whole pipeline
              </button>
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
                        Run step
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
                        Run from here
                      </button>
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
