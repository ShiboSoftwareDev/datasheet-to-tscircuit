import type { PublicPipelineSnapshot, PublicPipelineStage } from "@/shared/job-types"

const PIPELINE_STATUS_COPY: Record<PublicPipelineSnapshot["status"], string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
}

const STAGE_STATUS_COPY: Record<PublicPipelineStage["status"], string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  skipped: "Skipped",
  failed: "Failed",
  cancelled: "Cancelled",
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))} ms`

  const total_seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const hours = Math.floor(total_seconds / 3_600)
  const minutes = Math.floor((total_seconds % 3_600) / 60)
  const seconds = total_seconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`
}

function defaultStageLabel(stage_id: string): string {
  return stage_id.replaceAll("_", " ")
}

function isTerminalStage(stage: PublicPipelineStage): boolean {
  return ["completed", "skipped", "failed", "cancelled"].includes(stage.status)
}

export function PipelineTrace({
  pipeline,
  title = "Execution trace",
  stage_labels = {},
  class_name,
}: {
  pipeline?: PublicPipelineSnapshot
  title?: string
  stage_labels?: Readonly<Record<string, string>>
  class_name?: string
}) {
  const stages = Object.values(pipeline?.stage_results ?? {})
  if (!pipeline || stages.length === 0) return null

  const finished_count = stages.filter(isTerminalStage).length
  const open_on_failure = pipeline.status === "failed" || pipeline.status === "cancelled"

  return (
    <details className={`pipeline-trace${class_name ? ` ${class_name}` : ""}`} open={open_on_failure}>
      <summary>
        <span>{title}</span>
        <small>
          <code>{pipeline.pipeline_id}</code> · {PIPELINE_STATUS_COPY[pipeline.status]} · {finished_count}/
          {stages.length} stages
        </small>
      </summary>
      <ol>
        {stages.map((stage) => (
          <li className={`pipeline-stage-${stage.status}`} key={stage.stage_id}>
            <i aria-hidden="true" />
            <span>
              <strong>{stage_labels[stage.stage_id] ?? defaultStageLabel(stage.stage_id)}</strong>
              {stage.status === "failed" && stage.error ? (
                <>
                  <small className="pipeline-stage-diagnostic">
                    <code>{stage.error.code}</code>: {stage.error.message}
                  </small>
                  <small className="pipeline-stage-operation">
                    Operation: {stage.error.operation}
                    {stage.error.retryable ? " · retryable" : " · not retryable"}
                  </small>
                  {stage.error.hint && (
                    <small className="pipeline-stage-hint">Next: {stage.error.hint}</small>
                  )}
                  <small className="pipeline-stage-debug-ref">
                    Debug bundle: <code>{stage.debug_ref}</code>
                  </small>
                </>
              ) : stage.status === "skipped" || stage.status === "cancelled" ? (
                <small>{stage.reason}</small>
              ) : null}
            </span>
            <time>
              {typeof stage.duration_ms === "number"
                ? formatDuration(stage.duration_ms)
                : STAGE_STATUS_COPY[stage.status]}
            </time>
          </li>
        ))}
      </ol>
    </details>
  )
}
