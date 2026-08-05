import type { AgentClient } from "../infrastructure/agent"
import type { ProcessRunner } from "../infrastructure/process"
import type { JobStore } from "../job-store"

export interface JobRunnerContext {
  job_store: JobStore
  agent_bin: string
  tsci_bin: string
  use_openai?: boolean
  agent_transport_retry_limit?: number
  agent_transport_retry_base_delay_ms?: number
  agent_client?: AgentClient
  process_runner?: ProcessRunner
}

export type ComponentPipelineOutputs = {
  prepare: {
    job_id: string
    datasheet_path: string
    provenance_path: string
  }
  extract_evidence: {
    evidence_path: string
    part_number: string
    pin_count: number
    application_available: boolean
  }
  generate_component: {
    source_path: string
    source_bytes: number
  }
  validate_component: {
    result_path: string
    passed: boolean
    errors: string[]
  }
  repair_component: {
    result_path: string
    passed: boolean
    repair_attempts: number
  }
}

export type ApplicationPipelineOutputs = {
  prepare_application: {
    component_path: string
    component_circuit_json_path: string
    application_available: boolean
  }
  generate_application: {
    available: boolean
    source_path: string
  }
  validate_application: {
    result_path: string
    available: boolean
    passed: boolean
    errors: string[]
  }
  repair_application: {
    result_path: string
    available: boolean
    passed: boolean
    repair_attempts: number
    errors: string[]
  }
  publish: {
    component_ready: boolean
    application_ready: boolean
  }
}

export interface ComponentPipelineContext {
  job_id: string
  job_dir: string
  additional_instructions?: string
  use_openai: boolean
  invocation_id: string
}

export interface ComponentPipelineServices {
  job_store: JobStore
  agent_client: AgentClient
  process_runner: ProcessRunner
  tsci_bin: string
}
