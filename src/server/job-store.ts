import { mkdirSync, writeFileSync } from "node:fs"
import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import type { Job, JobEvent, JobListEvent, JobLog, JobLogStream, JobSummary } from "@/shared/job-types"

type JobSubscriber = (job_event: JobEvent) => void
type JobListSubscriber = (job_event: JobListEvent) => void

interface JobRecord extends Job {
  job_dir: string
  additional_instructions?: string
  retry_source_job_id?: string
  cancellation_controller: AbortController
  subscriber_set: Set<JobSubscriber>
}

export interface JobRetrySource {
  job_dir: string
  file_name: string
  additional_instructions?: string
  display_status: Job["display_status"]
}

export type JobCancellationResult = "requested" | "already_requested" | "already_complete" | "not_found"

export interface CreateJobInput {
  job_id: string
  job_dir: string
  file_name: string
  additional_instructions?: string
  retry_source_job_id?: string
}

export interface RestoreJobInput extends CreateJobInput {
  created_at: string
  completed_at?: string
  display_status: Job["display_status"]
  is_complete: boolean
  has_errors: boolean
  error_message?: string
  logs: JobLog[]
  component_ready?: boolean
  component_code?: string
  circuit_json?: Job["circuit_json"]
  typical_application_title?: string
  typical_application_code?: string
  typical_application_circuit_json?: Job["typical_application_circuit_json"]
  validation?: Job["validation"]
  provenance?: Job["provenance"]
  evidence_available?: boolean
}

export type JobUpdate = Partial<
  Pick<
    Job,
    | "display_status"
    | "is_complete"
    | "has_errors"
    | "error_message"
    | "completed_at"
    | "component_ready"
    | "component_code"
    | "circuit_json"
    | "typical_application_title"
    | "typical_application_code"
    | "typical_application_circuit_json"
    | "validation"
    | "provenance"
    | "evidence_available"
  >
>

function getPublicJob(job_record: JobRecord): Job {
  return {
    job_id: job_record.job_id,
    file_name: job_record.file_name,
    created_at: job_record.created_at,
    completed_at: job_record.completed_at,
    display_status: job_record.display_status,
    is_complete: job_record.is_complete,
    has_errors: job_record.has_errors,
    error_message: job_record.error_message,
    logs: [...job_record.logs],
    component_ready: job_record.component_ready,
    component_code: job_record.component_code,
    circuit_json: job_record.circuit_json,
    typical_application_title: job_record.typical_application_title,
    typical_application_code: job_record.typical_application_code,
    typical_application_circuit_json: job_record.typical_application_circuit_json,
    validation: job_record.validation,
    provenance: job_record.provenance,
    evidence_available: job_record.evidence_available,
  }
}

function getJobSummary(job_record: JobRecord): JobSummary {
  return {
    job_id: job_record.job_id,
    file_name: job_record.file_name,
    created_at: job_record.created_at,
    completed_at: job_record.completed_at,
    display_status: job_record.display_status,
    is_complete: job_record.is_complete,
    has_errors: job_record.has_errors,
    error_message: job_record.error_message,
  }
}

export class JobStore {
  private job_map = new Map<string, JobRecord>()
  private job_list_subscriber_set = new Set<JobListSubscriber>()

  createJob(input: CreateJobInput): Job {
    const job_record: JobRecord = {
      job_id: input.job_id,
      job_dir: input.job_dir,
      file_name: input.file_name,
      additional_instructions: input.additional_instructions,
      retry_source_job_id: input.retry_source_job_id,
      created_at: new Date().toISOString(),
      display_status: "queued",
      is_complete: false,
      has_errors: false,
      logs: [],
      cancellation_controller: new AbortController(),
      subscriber_set: new Set(),
    }
    this.job_map.set(job_record.job_id, job_record)
    this.persist(job_record)
    const job = getPublicJob(job_record)
    this.publishJobList({ event_type: "job_updated", job: getJobSummary(job_record) })
    return job
  }

  restoreJob(input: RestoreJobInput): Job {
    const existing = this.job_map.get(input.job_id)
    if (existing) return getPublicJob(existing)
    const job_record: JobRecord = {
      ...input,
      cancellation_controller: new AbortController(),
      subscriber_set: new Set(),
    }
    this.job_map.set(job_record.job_id, job_record)
    this.persist(job_record)
    return getPublicJob(job_record)
  }

  getJob(job_id: string): Job | undefined {
    const job_record = this.job_map.get(job_id)
    return job_record ? getPublicJob(job_record) : undefined
  }

  listJobs(): JobSummary[] {
    return [...this.job_map.values()]
      .reverse()
      .map(getJobSummary)
      .sort((first, second) => second.created_at.localeCompare(first.created_at))
  }

  getJobDir(job_id: string): string | undefined {
    return this.job_map.get(job_id)?.job_dir
  }

  getJobRetrySource(job_id: string): JobRetrySource | undefined {
    const job_record = this.job_map.get(job_id)
    if (!job_record) return undefined
    return {
      job_dir: job_record.job_dir,
      file_name: job_record.file_name,
      additional_instructions: job_record.additional_instructions,
      display_status: job_record.display_status,
    }
  }

  getActiveRetryForSource(source_job_id: string): Job | undefined {
    const retry = [...this.job_map.values()]
      .reverse()
      .find((job_record) => job_record.retry_source_job_id === source_job_id && !job_record.is_complete)
    return retry ? getPublicJob(retry) : undefined
  }

  getCancellationSignal(job_id: string): AbortSignal | undefined {
    return this.job_map.get(job_id)?.cancellation_controller.signal
  }

  requestCancellation(job_id: string): JobCancellationResult {
    const job_record = this.job_map.get(job_id)
    if (!job_record) return "not_found"
    if (job_record.is_complete) return "already_complete"
    if (job_record.cancellation_controller.signal.aborted) return "already_requested"

    job_record.display_status = "cancelling"
    this.persist(job_record)
    const job = getPublicJob(job_record)
    this.publish(job_record, { event_type: "job_updated", job })
    this.publishJobList({ event_type: "job_updated", job: getJobSummary(job_record) })
    job_record.cancellation_controller.abort()
    return "requested"
  }

  updateJob(job_id: string, job_update: JobUpdate): Job {
    const job_record = this.job_map.get(job_id)
    if (!job_record) throw new Error(`Job ${job_id} was not found`)
    Object.assign(job_record, job_update)
    this.persist(job_record)
    const job = getPublicJob(job_record)
    this.publish(job_record, { event_type: "job_updated", job })
    this.publishJobList({ event_type: "job_updated", job: getJobSummary(job_record) })
    return job
  }

  async appendLog(job_id: string, input: { stream: JobLogStream; message: string }): Promise<JobLog> {
    const job_record = this.job_map.get(job_id)
    if (!job_record) throw new Error(`Job ${job_id} was not found`)

    const log: JobLog = {
      log_id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      stream: input.stream,
      message: input.message,
    }
    job_record.logs.push(log)
    await appendFile(
      join(job_record.job_dir, "agent.log"),
      `[${log.created_at}] [${input.stream}] ${input.message}`,
      "utf8",
    )
    this.publish(job_record, { event_type: "log", log })
    return log
  }

  subscribe(job_id: string, subscriber: JobSubscriber): (() => void) | undefined {
    const job_record = this.job_map.get(job_id)
    if (!job_record) return undefined
    job_record.subscriber_set.add(subscriber)
    return () => job_record.subscriber_set.delete(subscriber)
  }

  subscribeToJobList(subscriber: JobListSubscriber): () => void {
    this.job_list_subscriber_set.add(subscriber)
    return () => this.job_list_subscriber_set.delete(subscriber)
  }

  deleteJob(job_id: string): boolean {
    const job_record = this.job_map.get(job_id)
    if (!job_record || !job_record.is_complete) return false
    this.job_map.delete(job_id)
    this.publishJobList({ event_type: "job_deleted", job_id })
    return true
  }

  private publish(job_record: JobRecord, job_event: JobEvent): void {
    for (const subscriber of job_record.subscriber_set) subscriber(job_event)
  }

  private publishJobList(job_event: JobListEvent): void {
    for (const subscriber of this.job_list_subscriber_set) subscriber(job_event)
  }

  private persist(job_record: JobRecord): void {
    mkdirSync(job_record.job_dir, { recursive: true })
    writeFileSync(
      join(job_record.job_dir, "job.json"),
      `${JSON.stringify(
        {
          version: 2,
          job_id: job_record.job_id,
          file_name: job_record.file_name,
          created_at: job_record.created_at,
          completed_at: job_record.completed_at,
          display_status: job_record.display_status,
          is_complete: job_record.is_complete,
          has_errors: job_record.has_errors,
          error_message: job_record.error_message,
          additional_instructions: job_record.additional_instructions,
          retry_source_job_id: job_record.retry_source_job_id,
          component_ready: job_record.component_ready,
          typical_application_title: job_record.typical_application_title,
          validation: job_record.validation,
          provenance: job_record.provenance,
          evidence_available: job_record.evidence_available,
        },
        null,
        2,
      )}\n`,
    )
  }
}
