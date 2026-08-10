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
  extract_evidence: {
    evidence_path: string
    part_number: string
    pin_count: number
  }
  generate_component: {
    source_path: string
    source_bytes: number
  }
  build_component: {
    result_path: string
    build_errors: string[]
    drc_errors: string[]
    circuit_element_count: number
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
  publish_component: {
    component_ready: boolean
    component_path: string
    component_circuit_json_path: string
  }
}

export type ApplicationPipelineOutputs = {
  extract_application_evidence: {
    evidence_path: string
    application_available: boolean
    application_title?: string
  }
  wait_for_component:
    | { component_required: false }
    | {
        component_required: true
        component_path: string
        component_circuit_json_path: string
        component_sha256: string
        component_circuit_json_sha256: string
      }
  generate_application:
    | { available: false }
    | {
        available: true
        source_path: string
      }
  build_application: {
    result_path: string
    available: boolean
    build_errors: string[]
    circuit_element_count: number
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
  publish_application: {
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
