import type { ModelRun } from "./job-types"

/**
 * A successful partial invocation is paused at a pipeline boundary, not ready.
 * This is based only on workflow state and is independent of its execution environment.
 */
export function isModelRunPaused(model_run: Pick<ModelRun, "status" | "pipeline">): boolean {
  if (model_run.status !== "complete") return false
  const pipeline = model_run.pipeline
  if (pipeline?.pipeline_id !== "spice_generation") return false
  return pipeline.stage_results.publish?.status !== "completed"
}

/** Counts workflow progress through the furthest completed stage; later skipped stages add nothing. */
export function getModelPipelineProgress(model_run: Pick<ModelRun, "pipeline">): {
  completed: number
  total: number
} {
  const stages = Object.values(model_run.pipeline?.stage_results ?? {})
  let completed = 0
  stages.forEach((stage, index) => {
    if (stage.status === "completed") completed = index + 1
  })
  return { completed, total: stages.length }
}

/** Measures the current pipeline invocation instead of the ModelRun's cumulative retry history. */
export function getModelPipelineElapsedTime(
  model_run: Pick<ModelRun, "pipeline" | "elapsed_time_ms" | "segment_started_at">,
  now: number,
): number {
  const pipeline = model_run.pipeline
  if (pipeline) {
    const started_at = new Date(pipeline.started_at).valueOf()
    const finished_at = pipeline.status === "running" ? now : new Date(pipeline.updated_at).valueOf()
    if (Number.isFinite(started_at) && Number.isFinite(finished_at)) {
      return Math.max(0, finished_at - started_at)
    }
  }
  if (!model_run.segment_started_at) return model_run.elapsed_time_ms
  const segment_start = new Date(model_run.segment_started_at).valueOf()
  return model_run.elapsed_time_ms + (Number.isFinite(segment_start) ? Math.max(0, now - segment_start) : 0)
}

export function getModelRepairElapsedTime(
  model_run: Pick<
    ModelRun,
    "repair_elapsed_time_ms" | "repair_started_at" | "repair_budget_ms" | "effort_multiplier"
  >,
  now: number,
): { elapsed: number; budget: number } {
  const budget = model_run.repair_budget_ms ?? model_run.effort_multiplier * 30 * 60 * 1_000
  const started_at = model_run.repair_started_at
    ? new Date(model_run.repair_started_at).valueOf()
    : Number.NaN
  const elapsed =
    (model_run.repair_elapsed_time_ms ?? 0) +
    (Number.isFinite(started_at) ? Math.max(0, now - started_at) : 0)
  return { elapsed: Math.min(budget, elapsed), budget }
}
