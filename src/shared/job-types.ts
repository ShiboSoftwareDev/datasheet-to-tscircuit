import type { AnyCircuitElement } from "circuit-json"

export type JobDisplayStatus = "queued" | "agent_running" | "building" | "complete" | "failed"
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

export type JobEvent =
  | { event_type: "snapshot" | "job_updated"; job: Job }
  | { event_type: "log"; log: JobLog }

export interface ApiError {
  error: {
    error_code: string
    message: string
  }
}
