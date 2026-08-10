import type { AgentClient } from "../infrastructure/agent"
import type { ProcessRunner } from "../infrastructure/process"
import type { JobStore } from "../job-store"
import type { ModelRunStore } from "../model-run-store"
import type { ModelStrategyRegistry } from "../modeling"
import type { NgspiceExecutor } from "../spice-validation"

export const REPAIR_BUDGET_MS_PER_EFFORT = 30 * 60 * 1_000

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

export type ModelRepairAction =
  | "recalibrate_continuous_transfer"
  | "enforce_declared_output_limits"
  | "retune_dynamic_response"
  | "preserve_viewer_portability"
  | "couple_response_to_public_stimulus"
  | "guard_logarithmic_domain"
  | "bound_internal_state"
  | "improve_numerical_convergence"
  | "replace_unsupported_ngspice_syntax"
  | "review_model_equations"

export type ModelRepairFeedbackIssue = {
  readonly category: ModelRepairFeedbackCategory
  readonly affected_cases: number
  readonly affected_observations: number
  /** Closed, non-numeric guidance; never contains private fixture or sample information. */
  readonly recommended_actions: readonly ModelRepairAction[]
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
  /** @deprecated The model workflow no longer executes ngspice. */
  ngspice_bin?: string
  agent_transport_retry_limit?: number
  agent_transport_retry_base_delay_ms?: number
  agent_client?: AgentClient
  process_runner?: ProcessRunner
  /** @deprecated The model workflow no longer executes ngspice. */
  ngspice_executor?: NgspiceExecutor
  strategy_registry?: ModelStrategyRegistry
}

export type ModelPipelineOutputs = {
  find_reference_graphs: {
    found_reference_ids: string[]
    evidence_dir: string
    time_graph_hints_path: string
    reference_observation_path: string
  }
  wait_for_model_evidence: {
    model_interface_path: string
    application_fixture_path: string
    application_fixture_sha256: string
  }
  create_comparison_graphs: {
    plan_path: string
    contract_path: string
    evidence_dir: string
    case_count: number
    requirement_ids: string[]
  }
  infer_spice_model: {
    model_path: string
    model_card_path: string
    manifest_path: string
    contract_path: string
    plan_path: string
    evidence_dir: string
    revision: string
  }
  create_simulation_tsx: {
    source_dir: string
    source_manifest_path: string
    model_path: string
    model_card_path: string
    manifest_path: string
    contract_path: string
    plan_path: string
    evidence_dir: string
    revision: string
    case_count: number
  }
  run_simulations: {
    result_path: string
    simulation_dir: string
    source_dir: string
    model_path: string
    model_card_path: string
    manifest_path: string
    contract_path: string
    plan_path: string
    evidence_dir: string
    case_count: number
    simulation_error_case_ids: string[]
    causality_result_path?: string
    causality_case_count: number
    causality_simulation_error_case_ids: string[]
    revision: string
  }
  compare_simulation_outputs: {
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
    stimulus_causality_failure?: {
      affected_case_count: number
      affected_observation_count: number
    }
    revision: string
  }
  repair_spice_model: {
    result_path: string
    model_path: string
    model_card_path: string
    manifest_path: string
    contract_path: string
    plan_path: string
    evidence_dir: string
    passed: boolean
    repair_attempts: number
    repair_elapsed_ms?: number
    revision: string
  }
  wait_for_component: {
    job_id: string
    component_source_path: string
    component_circuit_json_path: string
    integration_interface_path: string
    integration_dir: string
  }
  publish: {
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
  repair_budget_ms?: number
  /** @deprecated Retained only for source-level test fixtures. */
  max_repair_attempts?: number
  invocation_id: string
}

export interface ModelPipelineServices {
  job_store: JobStore
  model_run_store: ModelRunStore
  agent_client: AgentClient
  process_runner: ProcessRunner
  strategy_registry: ModelStrategyRegistry
  tsci_bin: string
  /** @deprecated The model workflow no longer executes ngspice. */
  ngspice_bin?: string
  /** @deprecated The model workflow no longer executes ngspice. */
  ngspice_executor?: NgspiceExecutor
}
