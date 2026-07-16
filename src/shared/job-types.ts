import type { AnyCircuitElement } from "circuit-json"

export type JobDisplayStatus =
  | "queued"
  | "agent_running"
  | "building"
  | "cancelling"
  | "cancelled"
  | "complete"
  | "failed"
export type JobLogStream = "system" | "stdout" | "stderr"

export interface JobLog {
  log_id: string
  created_at: string
  stream: JobLogStream
  message: string
}

export interface Job {
  job_id: string
  file_name: string
  created_at: string
  completed_at?: string
  display_status: JobDisplayStatus
  is_complete: boolean
  has_errors: boolean
  error_message?: string
  logs: JobLog[]
  component_code?: string
  circuit_json?: AnyCircuitElement[]
}

export type JobSummary = Pick<
  Job,
  | "job_id"
  | "file_name"
  | "created_at"
  | "completed_at"
  | "display_status"
  | "is_complete"
  | "has_errors"
  | "error_message"
>

export type JobEvent =
  | { event_type: "snapshot" | "job_updated"; job: Job }
  | { event_type: "log"; log: JobLog }

export type JobListEvent =
  | { event_type: "jobs_snapshot"; jobs: JobSummary[] }
  | { event_type: "job_updated"; job: JobSummary }
  | { event_type: "job_deleted"; job_id: string }

export interface ApiError {
  error: {
    error_code: string
    message: string
  }
}

export type ModelRunStatus =
  | "queued"
  | "setting_up"
  | "waiting_for_component"
  | "running"
  | "validating"
  | "cancelling"
  | "cancelled"
  | "complete"
  | "timed_out"
  | "failed"

export interface ModelValidationBenchmark {
  benchmark_id: string
  title: string
  critical: boolean
  tolerance: number
  normalized_rmse?: number
  normalized_max_error?: number
  passed: boolean
  error_message?: string
}

export interface ModelValidationSummary {
  benchmark_count: number
  passing_count: number
  critical_count: number
  critical_passing_count: number
  score?: number
  worst_normalized_error?: number
  all_critical_passed: boolean
  all_passed: boolean
  benchmarks: ModelValidationBenchmark[]
}

export interface ModelManifest {
  version: 1
  part_number: string
  dialect: "pspice" | "ngspice" | "portable"
  entry_name: string
  model_file: string
  revision: string
  simulator: string
  generated_at: string
  pins: Array<{
    component_pin: string
    spice_node: string
  }>
}

export type ModelProgressPhase =
  | "queued"
  | "extracting_datasheet"
  | "digitizing_graphs"
  | "preparing_benchmarks"
  | "waiting_for_component"
  | "locking_benchmarks"
  | "building_baseline"
  | "simulating"
  | "scoring"
  | "refining"
  | "finalizing"
  | "validating"
  | "complete"
  | "timed_out"
  | "failed"
  | "cancelled"

export interface ModelProgress {
  sequence: number
  phase: ModelProgressPhase
  message: string
  updated_at: string
  iteration?: number
  evidence?: {
    pages_reviewed?: number
    graphs_found?: number
    graphs_digitized?: number
    benchmark_drafts?: number
  }
  benchmark?: {
    current?: string
    completed?: number
    total?: number
    draft_total?: number
    locked_total?: number
    omitted?: number
  }
  champion?: {
    revision?: string
    passing?: number
    total?: number
    score?: number
    worst_normalized_error?: number
  }
}

export type ModelProgressEvent = Pick<
  ModelProgress,
  "sequence" | "phase" | "message" | "updated_at" | "iteration"
>

export interface ModelCurvePoint {
  x: number
  y: number
}

export interface ModelCircuitPreview {
  source_file: string
  code: string
  build_status: "source_ready" | "building" | "ready" | "failed"
  updated_at: string
  circuit_json?: AnyCircuitElement[]
  snapshot_origin?: "workspace" | "server_validation"
  is_stale?: boolean
  error_message?: string
}

export interface ModelReferencePreview {
  benchmark_id?: string
  title: string
  source_file: string
  result_file?: string
  x_scale: "linear" | "log"
  y_scale: "linear" | "log"
  reference_points: ModelCurvePoint[]
  result_points?: ModelCurvePoint[]
  result_status?: "partial" | "verified"
  is_stale?: boolean
  updated_at: string
}

export interface ModelPreviewOption {
  benchmark_id: string
  title: string
  circuit_file: string
  reference_file?: string
  result_file?: string
}

export interface ModelSelectedPreview {
  circuit_preview?: ModelCircuitPreview
  reference_preview?: ModelReferencePreview
}

export interface ModelRun {
  model_run_id: string
  job_id: string
  created_at: string
  updated_at: string
  completed_at?: string
  status: ModelRunStatus
  is_complete: boolean
  has_errors: boolean
  error_message?: string
  effort_multiplier: number
  base_effort_ms: number
  allocated_time_ms: number
  elapsed_time_ms: number
  segment_started_at?: string
  iteration: number
  logs: JobLog[]
  model_source?: string
  manifest?: ModelManifest
  validation?: ModelValidationSummary
  model_card?: string
  progress?: ModelProgress
  progress_history: ModelProgressEvent[]
  circuit_preview?: ModelCircuitPreview
  reference_preview?: ModelReferencePreview
  preview_options: ModelPreviewOption[]
}

export type ModelRunEvent =
  | { event_type: "snapshot" | "model_run_updated"; model_run: ModelRun }
  | { event_type: "log"; log: JobLog }
