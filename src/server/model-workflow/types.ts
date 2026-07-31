import type { AgentClient } from "../infrastructure/agent"
import type { ProcessRunner } from "../infrastructure/process"
import type { JobStore } from "../job-store"
import type { ModelRunStore } from "../model-run-store"
import type { ModelStrategyRegistry } from "../modeling"
import type { NgspiceExecutor } from "../spice-validation"

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
  }
  characterize: {
    contract_path: string
    family: string
    strategy: string
    modeled_requirement_ids: string[]
    documented_only_count: number
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
