import type { AnyCircuitElement } from "circuit-json"
import type { PipelineRunStatus, PipelineStageStatus } from "./pipeline-types"

export interface PublicPipelineError {
  code: string
  message: string
  operation: string
  hint?: string
  retryable: boolean
}

export interface PublicPipelineStage {
  stage_id: string
  status: PipelineStageStatus
  debug_ref: string
  started_at?: string
  completed_at?: string
  duration_ms?: number
  reason?: string
  error?: PublicPipelineError
}

export interface PublicPipelineSnapshot {
  pipeline_id: string
  status: PipelineRunStatus
  sequence: number
  started_at: string
  updated_at: string
  stage_results: Record<string, PublicPipelineStage>
}

export interface JobPipelineSnapshots {
  component_generation?: PublicPipelineSnapshot
  typical_application?: PublicPipelineSnapshot
}

export type JobDisplayStatus =
  | "queued"
  | "agent_running"
  | "building"
  | "cancelling"
  | "cancelled"
  | "complete"
  | "unsupported"
  | "failed"
export type JobLogStream = "system" | "stdout" | "stderr"

export interface JobLog {
  log_id: string
  created_at: string
  stream: JobLogStream
  message: string
}

export type JobValidationStatus =
  | "pending"
  | "passed"
  | "warning"
  | "failed"
  | "inconclusive"
  | "unresolved"
  | "not_applicable"

export interface JobValidation {
  evidence: JobValidationStatus
  component_build: JobValidationStatus
  component_drc: JobValidationStatus
  footprint: JobValidationStatus
  pinout: JobValidationStatus
  component_schematic: JobValidationStatus
  component_visual: JobValidationStatus
  application_build: JobValidationStatus
  application_connectivity: JobValidationStatus
  application_schematic: JobValidationStatus
  application_visual: JobValidationStatus
}

export interface JobProvenance {
  source_commit: string
  /** Hash of the actual server/shared workflow files, including uncommitted edits. */
  workflow_source_sha256?: string
  evidence_contract_sha256?: string
  bun_version: string
  tscircuit_version: string
  tsci_agent_version: string
  agent_model: string
  agent_settings: string
  datasheet_sha256: string
  dependency_lock_sha256?: string
  prompt_sha256: Record<string, string>
}

export interface Job {
  job_id: string
  file_name: string
  /** Missing only on tasks persisted before provider selection became durable. */
  use_openai?: boolean
  created_at: string
  completed_at?: string
  display_status: JobDisplayStatus
  is_complete: boolean
  has_errors: boolean
  error_message?: string
  warnings?: string[]
  logs: JobLog[]
  component_ready?: boolean
  component_code?: string
  circuit_json?: AnyCircuitElement[]
  typical_application_title?: string
  typical_application_code?: string
  typical_application_circuit_json?: AnyCircuitElement[]
  validation?: JobValidation
  provenance?: JobProvenance
  evidence_available?: boolean
  /** Observable, typed execution state. Older persisted jobs may not have one. */
  pipeline?: PublicPipelineSnapshot
  /** First-class component and application traces. `pipeline` is the legacy component alias. */
  pipelines?: JobPipelineSnapshots
}

export interface ModelRunSummary {
  model_run_id: string
  job_id: string
  status: ModelRunStatus
  is_complete: boolean
  has_errors: boolean
  error_message?: string
  has_model: boolean
  has_retained_accepted_model: boolean
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
  | "warnings"
  | "component_ready"
> & {
  model_run?: ModelRunSummary
}

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
  series?: ModelValidationSeries[]
}

export interface ModelValidationSeries {
  series_id: string
  title: string
  role: "response" | "stimulus"
  unit: string
  tolerance: number
  normalized_rmse?: number
  normalized_max_error?: number
  passed: boolean
  error_message?: string
}

export interface ModelValidationSummary {
  /** Distinguishes an inspectable attempt from the immutable accepted model. */
  artifact_state?: "candidate" | "accepted"
  /** Revision whose simulator results produced this exact projection. */
  model_revision?: string
  /** Immutable live-preview generation for an unaccepted candidate. */
  preview_generation?: string
  benchmark_count: number
  passing_count: number
  critical_count: number
  critical_passing_count: number
  score?: number
  worst_normalized_error?: number
  /** Sample-weighted NRMSE for curve observations only; scalar checks never dilute it. */
  curve_score?: number
  curve_worst_normalized_error?: number
  all_critical_passed: boolean
  all_passed: boolean
  benchmarks: ModelValidationBenchmark[]
  scope?: {
    total_requirement_count: number
    modeled_requirement_count: number
    documented_only_requirement_count: number
    validated_sample_count: number
    scalar_observation_count: number
    curve_observation_count: number
    compared_curve_observation_count: number
    curve_sample_count: number
    swept_case_count: number
    quality: "scalar_only" | "range_checked" | "curve_attempted" | "curve_validated"
    documented_only_requirements: Array<{
      requirement_id: string
      title: string
      reason: string
    }>
    limitations: string[]
  }
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

/** The current server-generated model being developed, whether or not it is accepted yet. */
export interface ModelDevelopmentArtifact {
  model_source: string
  manifest: ModelManifest
  model_card: string
}

export type ModelProgressPhase =
  | "queued"
  | "characterizing"
  | "designing_validation"
  | "generating_model"
  | "repairing"
  | "publishing"
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
    figures_found?: number
    figures_digitized?: number
    channels_found?: number
    channels_digitized?: number
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

export interface ModelReferenceSeriesPreview {
  series_id: string
  title: string
  role: "response" | "stimulus"
  quantity: string
  unit: string
  source_file: string
  result_file?: string
  y_scale: "linear" | "log"
  /** Distinguishes a sampled time-domain curve from scalar specification checks. */
  reference_kind?: "curve" | "target" | "bounds"
  reference_points: ModelCurvePoint[]
  reference_bounds?: {
    min?: number
    max?: number
  }
  result_points?: ModelCurvePoint[]
  normalized_rmse?: number
  normalized_max_error?: number
  matches_reference?: boolean
}

export interface ModelCircuitPreview {
  source_file: string
  code: string
  build_status: "source_ready" | "building" | "ready" | "failed"
  updated_at: string
  circuit_json?: AnyCircuitElement[]
  /** Analysis represented by the generated validation-case TSX. */
  analysis_type?: "operating_point" | "dc_sweep" | "transient"
  /** Whether Circuit JSON contains a completed transient experiment and waveform. */
  analog_simulation_status?: "available" | "unsupported" | "failed"
  snapshot_origin?: "workspace" | "server_validation"
  is_stale?: boolean
  error_message?: string
}

export interface ModelReferencePreview {
  benchmark_id?: string
  title: string
  source_file: string
  result_file?: string
  x_axis_label?: string
  x_axis_unit?: string
  y_axis_label?: string
  y_axis_unit?: string
  x_scale: "linear" | "log"
  y_scale: "linear" | "log"
  /** Distinguishes a sampled time-domain curve from scalar specification checks. */
  reference_kind?: "curve" | "target" | "bounds"
  reference_points: ModelCurvePoint[]
  reference_bounds?: {
    min?: number
    max?: number
  }
  result_points?: ModelCurvePoint[]
  series?: ModelReferenceSeriesPreview[]
  result_status?: "unverified" | "partial" | "verified" | "failed" | "cancelled" | "deprecated"
  result_origin?: "workspace" | "server_validation" | "tscircuit_viewer"
  normalized_rmse?: number
  normalized_max_error?: number
  matches_reference?: boolean
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

/** Source evidence published by Find Reference Graphs before any comparison exists. */
export interface ModelFoundReference {
  reference_id: string
  title: string
  source_file: string
  page?: number
  figure?: string
  x_axis_label: "Time"
  x_axis_unit: "s"
  updated_at: string
}

/** Immutable identity shared by one selected preview and its datasheet image. */
export interface ModelPreviewArtifactIdentity {
  preview_generation: string
  model_revision: string
}

export interface ModelSelectedPreview {
  /** Missing only for preview artifacts written before immutable image binding was introduced. */
  artifact_identity?: ModelPreviewArtifactIdentity
  circuit_preview?: ModelCircuitPreview
  reference_preview?: ModelReferencePreview
}

export interface ModelRun {
  model_run_id: string
  job_id: string
  /** Missing only on runs persisted before provider selection became durable. */
  use_openai?: boolean
  created_at: string
  updated_at: string
  completed_at?: string
  status: ModelRunStatus
  is_complete: boolean
  has_errors: boolean
  error_message?: string
  warnings?: string[]
  effort_multiplier: number
  elapsed_time_ms: number
  segment_started_at?: string
  /** Identifies the pipeline invocation whose checkpoints are currently being written. */
  current_invocation_id?: string
  iteration: number
  logs: JobLog[]
  /** Current generated candidate. This is distinct from the accepted publication below. */
  development_model?: ModelDevelopmentArtifact
  model_source?: string
  manifest?: ModelManifest
  validation?: ModelValidationSummary
  model_card?: string
  progress?: ModelProgress
  progress_history: ModelProgressEvent[]
  circuit_preview?: ModelCircuitPreview
  reference_preview?: ModelReferencePreview
  preview_options: ModelPreviewOption[]
  /** Present after Find Reference Graphs; contains no simulated or digitized comparison series. */
  found_references?: ModelFoundReference[]
  /** Observable, typed execution state. Older persisted runs may not have one. */
  pipeline?: PublicPipelineSnapshot
}

export type ModelRunEvent =
  | { event_type: "snapshot" | "model_run_updated"; model_run: ModelRun }
  | { event_type: "log"; log: JobLog }
