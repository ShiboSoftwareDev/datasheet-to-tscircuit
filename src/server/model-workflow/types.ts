import type { AgentClient } from "../infrastructure/agent"
import type { ProcessRunner } from "../infrastructure/process"
import type { JobStore } from "../job-store"
import type { ModelRunStore } from "../model-run-store"
import type { ModelStrategyRegistry } from "../modeling"
import type { NgspiceExecutor } from "../spice-validation"

export type ModelRepairFeedbackCategory =
  | "target_mismatch"
  | "bounds_violation"
  | "curve_mismatch"
  | "viewer_curve_mismatch"
  | "stimulus_insensitive"
  | "invalid_log_output"
  | "non_finite_output"
  | "convergence_failure"
  | "simulator_rejected_model"
  | "comparison_failure"
  | "validation_failure"

export type ModelRepairFeedbackIssue = {
  readonly category: ModelRepairFeedbackCategory
  readonly affected_cases: number
  readonly affected_observations: number
}

export type ModelRepairFeedback = {
  readonly version: 1
  readonly status: "failed"
  readonly issues: readonly ModelRepairFeedbackIssue[]
}

export interface ModelRunnerContext {
  job_store: JobStore
  model_run_store: ModelRunStore
  agent_bin: string
  tsci_bin: string
  use_openai?: boolean
  ngspice_bin?: string
  agent_transport_retry_limit?: number
  agent_transport_retry_base_delay_ms?: number
  agent_client?: AgentClient
  process_runner?: ProcessRunner
  ngspice_executor?: NgspiceExecutor
  strategy_registry?: ModelStrategyRegistry
}

export type ModelPipelineOutputs = {
  wait_for_component: {
    job_id: string
    component_source: string
  }
  prepare_workspace: {
    part_number: string
    entry_name: string
    pin_count: number
    interface_path: string
    attempt_dir: string
    application_fixture_path: string
    application_fixture_sha256: string
  }
  characterize: {
    contract_path: string
    family: string
    strategy: string
    modeled_requirement_ids: string[]
    documented_only_count: number
    application_fixture_path: string
    application_fixture_sha256: string
    time_graph_hints_path: string
    reference_observation_path: string
    reference_source_proof_path: string
    reference_verification_path: string
  }
  design_validation: {
    plan_path: string
    contract_path: string
    evidence_dir: string
    case_count: number
    requirement_ids: string[]
  }
  generate_model: {
    model_path: string
    model_card_path: string
    manifest_path: string
    contract_path: string
    plan_path: string
    evidence_dir: string
    revision: string
  }
  validate_model: {
    result_path: string
    model_path: string
    model_card_path: string
    manifest_path: string
    contract_path: string
    plan_path: string
    evidence_dir: string
    passed: boolean
    case_count: number
    failing_case_ids: string[]
    /** Redacted category/count-only feedback, including viewer-only curve mismatches. */
    repair_feedback?: ModelRepairFeedback
    revision: string
  }
  repair_model: {
    result_path: string
    model_path: string
    model_card_path: string
    manifest_path: string
    contract_path: string
    plan_path: string
    evidence_dir: string
    passed: boolean
    repair_attempts: number
    revision: string
  }
  publish_model: {
    attached: boolean
    component_path: string
    revision: string
  }
}

export interface ModelPipelineContext {
  model_run_id: string
  job_id: string
  job_dir: string
  model_dir: string
  use_openai: boolean
  max_repair_attempts: number
  invocation_id: string
}

export interface ModelPipelineServices {
  job_store: JobStore
  model_run_store: ModelRunStore
  agent_client: AgentClient
  process_runner: ProcessRunner
  strategy_registry: ModelStrategyRegistry
  tsci_bin: string
  ngspice_bin: string
  ngspice_executor: NgspiceExecutor
}
