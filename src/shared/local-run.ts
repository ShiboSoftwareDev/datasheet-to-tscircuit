import type { Job, ModelRun } from "./job-types"

export type LocalRunMode = "pipeline" | "task" | "from_task"
export type LocalRunStatus = "running" | "completed" | "failed" | "cancelled"

export interface LocalRunSummary {
  readonly version: 1
  readonly local_run_id: string
  readonly mode: LocalRunMode
  readonly pipeline_id: string
  readonly task_id?: string
  readonly source_run_id: string
  readonly source_job_id: string
  readonly parent_local_run_id?: string
  readonly file_name: string
  readonly status: LocalRunStatus
  readonly created_at: string
  readonly completed_at?: string
  readonly error_message?: string
  readonly execution_dir: string
  readonly workspace_dir: string
  readonly input_path: string
  readonly pipeline_dir: string
  readonly events_path: string
  readonly summary_path: string
  readonly stage_results: unknown
  readonly selected_task_result?: unknown
}

export interface LocalRunDetail {
  readonly local_run: LocalRunSummary
  readonly job: Job
  readonly model_run?: ModelRun
}
