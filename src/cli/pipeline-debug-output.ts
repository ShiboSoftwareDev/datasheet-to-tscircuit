import type { PublicPipelineSnapshot } from "@/shared/job-types"
import type { LocalRunProgressEvent } from "../server/pipeline-local-run"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function projectDebugCliStdout(result: unknown): unknown {
  if (
    !isRecord(result) ||
    (result.version !== 1 && result.version !== 2) ||
    typeof result.local_run_id !== "string" ||
    typeof result.pipeline_id !== "string" ||
    typeof result.status !== "string" ||
    typeof result.summary_path !== "string"
  ) {
    return result
  }
  const stages = isRecord(result.stage_results) ? Object.entries(result.stage_results) : []
  const completed_stages = stages.flatMap(([stage_id, stage]) =>
    isRecord(stage) && stage.status === "completed" ? [stage_id] : [],
  )
  const failed = stages.find(([, stage]) => isRecord(stage) && stage.status === "failed")
  const failed_stage = failed?.[1]
  const failed_error = isRecord(failed_stage) && isRecord(failed_stage.error) ? failed_stage.error : undefined
  const error_message =
    typeof failed_error?.message === "string"
      ? failed_error.message.split("\n", 1)[0]!.slice(0, 500)
      : typeof result.error_message === "string"
        ? result.error_message.split("\n", 1)[0]!.slice(0, 500)
        : undefined
  return {
    version: result.version,
    local_run_id: result.local_run_id,
    execution_kind: result.execution_kind,
    mode: result.mode,
    pipeline_id: result.pipeline_id,
    task_id: result.task_id,
    source_job_id: result.source_job_id,
    target_job_id: result.target_job_id,
    status: result.status,
    created_at: result.created_at,
    completed_at: result.completed_at,
    summary_path: result.summary_path,
    completed_stages,
    ...(failed
      ? {
          failed_stage: {
            stage_id: failed[0],
            ...(typeof failed_error?.code === "string" ? { code: failed_error.code } : {}),
            ...(error_message ? { message: error_message } : {}),
          },
        }
      : error_message
        ? { error_message }
        : {}),
  }
}

function elapsedLabel(startedAt: string): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).valueOf()) / 1_000))
  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = elapsedSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

export function createStderrProgressReporter(): (event: LocalRunProgressEvent) => void {
  let latestPipeline: PublicPipelineSnapshot | undefined
  let lastHeartbeatAt = 0
  let lastPipelineLine = ""
  return (event) => {
    if (event.kind === "started") {
      lastHeartbeatAt = Date.now()
      process.stderr.write(
        `[local] ${event.summary.local_run_id} started ${event.summary.pipeline_id}/${event.summary.task_id ?? "pipeline"}\n`,
      )
      return
    }
    if (event.kind === "pipeline") {
      latestPipeline = event.pipeline
      const stages = Object.values(event.pipeline.stage_results)
      const completed = stages.filter(({ status }) => status === "completed").length
      const active = stages.find(({ status }) => status === "running")
      const line = active
        ? `[local] ${active.stage_id} running (${completed}/${stages.length} completed)`
        : `[local] ${event.pipeline.status} (${completed}/${stages.length} completed)`
      if (line !== lastPipelineLine) {
        process.stderr.write(`${line}\n`)
        lastPipelineLine = line
      }
      return
    }
    const now = Date.now()
    if (now - lastHeartbeatAt < 15_000) return
    lastHeartbeatAt = now
    const active = latestPipeline
      ? Object.values(latestPipeline.stage_results).find(({ status }) => status === "running")
      : undefined
    process.stderr.write(
      `[local] ${active?.stage_id ?? event.summary.task_id ?? event.summary.pipeline_id} still running (${elapsedLabel(event.summary.created_at)})\n`,
    )
  }
}
