import { join } from "node:path"
import type { Job, JobEvent, JobListEvent, JobLog, JobLogStream, JobSummary } from "@/shared/job-types"
import { atomicWriteJsonSync, type CheckpointWriter } from "./infrastructure/persistence/atomic-write"
import {
  appendBoundedLogEvent,
  capRecentLogs,
  type LogEventWriter,
  prepareBoundedLogEvent,
} from "./infrastructure/persistence/bounded-log"

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
  use_openai?: boolean
  additional_instructions?: string
  display_status: Job["display_status"]
}

export type JobCancellationResult = "requested" | "already_requested" | "already_complete" | "not_found"

export interface JobDeletionLease {
  readonly job_id: string
  readonly token: symbol
}

export type JobDeletionLeaseResult =
  | { status: "acquired"; lease: JobDeletionLease }
  | { status: "already_deleting" }
  | { status: "not_found" }

export interface CreateJobInput {
  job_id: string
  job_dir: string
  file_name: string
  use_openai?: boolean
  additional_instructions?: string
  retry_source_job_id?: string
}

export interface JobStoreOptions {
  checkpoint_writer?: CheckpointWriter
  log_writer?: LogEventWriter
}

export interface CommittedJobProjectionResult {
  job: Job
  checkpoint_error?: string
}

export interface RestoreJobInput extends CreateJobInput {
  created_at: string
  completed_at?: string
  display_status: Job["display_status"]
  is_complete: boolean
  has_errors: boolean
  error_message?: string
  warnings: string[]
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
  pipeline?: Job["pipeline"]
  pipelines?: Job["pipelines"]
}

export type JobUpdate = Partial<
  Pick<
    Job,
    | "display_status"
    | "use_openai"
    | "is_complete"
    | "has_errors"
    | "error_message"
    | "warnings"
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
    | "pipeline"
    | "pipelines"
  >
>

function getPublicJob(job_record: JobRecord): Job {
  return {
    job_id: job_record.job_id,
    file_name: job_record.file_name,
    use_openai: job_record.use_openai,
    created_at: job_record.created_at,
    completed_at: job_record.completed_at,
    display_status: job_record.display_status,
    is_complete: job_record.is_complete,
    has_errors: job_record.has_errors,
    error_message: job_record.error_message,
    warnings: [...(job_record.warnings ?? [])],
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
    pipeline: job_record.pipeline,
    pipelines: job_record.pipelines,
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
    warnings: [...(job_record.warnings ?? [])],
    component_ready: job_record.component_ready,
  }
}

function cloneJobRecord(job_record: JobRecord): JobRecord {
  return {
    ...job_record,
    warnings: [...(job_record.warnings ?? [])],
    logs: [...job_record.logs],
    cancellation_controller: job_record.cancellation_controller,
    subscriber_set: job_record.subscriber_set,
  }
}

export class JobStore {
  private job_map = new Map<string, JobRecord>()
  private job_list_subscriber_set = new Set<JobListSubscriber>()
  private job_deletion_lease_map = new Map<string, symbol>()
  private readonly checkpoint_writer: CheckpointWriter
  private readonly log_writer: LogEventWriter

  constructor(options: JobStoreOptions = {}) {
    this.checkpoint_writer = options.checkpoint_writer ?? atomicWriteJsonSync
    this.log_writer = options.log_writer ?? appendBoundedLogEvent
  }

  createJob(input: CreateJobInput): Job {
    const job_record: JobRecord = {
      job_id: input.job_id,
      job_dir: input.job_dir,
      file_name: input.file_name,
      use_openai: input.use_openai,
      additional_instructions: input.additional_instructions,
      retry_source_job_id: input.retry_source_job_id,
      created_at: new Date().toISOString(),
      display_status: "queued",
      is_complete: false,
      has_errors: false,
      warnings: [],
      logs: [],
      cancellation_controller: new AbortController(),
      subscriber_set: new Set(),
    }
    this.persist(job_record)
    this.job_map.set(job_record.job_id, job_record)
    const job = getPublicJob(job_record)
    this.publishJobList({ event_type: "job_updated", job: getJobSummary(job_record) })
    return job
  }

  restoreJob(input: RestoreJobInput): Job {
    const existing = this.job_map.get(input.job_id)
    if (existing) return getPublicJob(existing)
    const job_record: JobRecord = {
      ...input,
      logs: capRecentLogs(input.logs),
      cancellation_controller: new AbortController(),
      subscriber_set: new Set(),
    }
    this.persist(job_record)
    this.job_map.set(job_record.job_id, job_record)
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

  getJobSummary(job_id: string): JobSummary | undefined {
    const job_record = this.job_map.get(job_id)
    return job_record ? getJobSummary(job_record) : undefined
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
      use_openai: job_record.use_openai,
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

  acquireJobDeletionLease(job_id: string): JobDeletionLeaseResult {
    if (!this.job_map.has(job_id)) return { status: "not_found" }
    if (this.job_deletion_lease_map.has(job_id)) return { status: "already_deleting" }
    const token = Symbol(job_id)
    this.job_deletion_lease_map.set(job_id, token)
    return { status: "acquired", lease: { job_id, token } }
  }

  releaseJobDeletionLease(lease: JobDeletionLease): boolean {
    if (this.job_deletion_lease_map.get(lease.job_id) !== lease.token) return false
    this.job_deletion_lease_map.delete(lease.job_id)
    return true
  }

  isJobDeleting(job_id: string): boolean {
    return this.job_deletion_lease_map.has(job_id)
  }

  requestCancellation(job_id: string): JobCancellationResult {
    const job_record = this.job_map.get(job_id)
    if (!job_record) return "not_found"
    if (job_record.is_complete) return "already_complete"
    if (job_record.cancellation_controller.signal.aborted) return "already_requested"

    const candidate = cloneJobRecord(job_record)
    candidate.display_status = "cancelling"
    try {
      this.persist(candidate)
    } catch (error) {
      job_record.cancellation_controller.abort()
      throw error
    }
    Object.assign(job_record, candidate)
    job_record.cancellation_controller.abort()
    const job = getPublicJob(job_record)
    this.publish(job_record, { event_type: "job_updated", job })
    this.publishJobList({ event_type: "job_updated", job: getJobSummary(job_record) })
    return "requested"
  }

  updateJob(job_id: string, job_update: JobUpdate): Job {
    const job_record = this.job_map.get(job_id)
    if (!job_record) throw new Error(`Job ${job_id} was not found`)
    const candidate = cloneJobRecord(job_record)
    Object.assign(candidate, job_update)
    this.persist(candidate)
    Object.assign(job_record, candidate)
    const job = getPublicJob(job_record)
    this.publish(job_record, { event_type: "job_updated", job })
    this.publishJobList({ event_type: "job_updated", job: getJobSummary(job_record) })
    return job
  }

  /**
   * Projects files selected by an already-committed external publication.
   * The pointer can reconstruct this view after restart, so a compatibility
   * checkpoint failure must not roll the in-memory job back to stale TSX.
   */
  projectCommittedPublication(job_id: string, job_update: JobUpdate): CommittedJobProjectionResult {
    const job_record = this.job_map.get(job_id)
    if (!job_record) throw new Error(`Job ${job_id} was not found`)
    const candidate = cloneJobRecord(job_record)
    Object.assign(candidate, job_update)
    let checkpoint_error: string | undefined
    try {
      this.persist(candidate)
    } catch (error) {
      checkpoint_error = error instanceof Error ? error.message : String(error)
    }
    Object.assign(job_record, candidate)
    const job = getPublicJob(job_record)
    this.publish(job_record, { event_type: "job_updated", job })
    this.publishJobList({ event_type: "job_updated", job: getJobSummary(job_record) })
    return { job, ...(checkpoint_error ? { checkpoint_error } : {}) }
  }

  async appendLog(job_id: string, input: { stream: JobLogStream; message: string }): Promise<JobLog> {
    const job_record = this.job_map.get(job_id)
    if (!job_record) throw new Error(`Job ${job_id} was not found`)

    const log = prepareBoundedLogEvent({
      log_id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      stream: input.stream,
      message: input.message,
    })
    await this.log_writer(join(job_record.job_dir, "agent.log"), log)
    job_record.logs = capRecentLogs([...job_record.logs, log])
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
    if (!job_record?.is_complete) return false
    this.job_map.delete(job_id)
    this.job_deletion_lease_map.delete(job_id)
    this.publishJobList({ event_type: "job_deleted", job_id })
    return true
  }

  private publish(job_record: JobRecord, job_event: JobEvent): void {
    for (const subscriber of [...job_record.subscriber_set]) {
      try {
        subscriber(job_event)
      } catch {
        job_record.subscriber_set.delete(subscriber)
      }
    }
  }

  private publishJobList(job_event: JobListEvent): void {
    for (const subscriber of [...this.job_list_subscriber_set]) {
      try {
        subscriber(job_event)
      } catch {
        this.job_list_subscriber_set.delete(subscriber)
      }
    }
  }

  private persist(job_record: JobRecord): void {
    this.checkpoint_writer(join(job_record.job_dir, "job.json"), {
      version: 2,
      job_id: job_record.job_id,
      file_name: job_record.file_name,
      use_openai: job_record.use_openai,
      created_at: job_record.created_at,
      completed_at: job_record.completed_at,
      display_status: job_record.display_status,
      is_complete: job_record.is_complete,
      has_errors: job_record.has_errors,
      error_message: job_record.error_message,
      warnings: job_record.warnings,
      additional_instructions: job_record.additional_instructions,
      retry_source_job_id: job_record.retry_source_job_id,
      component_ready: job_record.component_ready,
      typical_application_title: job_record.typical_application_title,
      validation: job_record.validation,
      provenance: job_record.provenance,
      evidence_available: job_record.evidence_available,
      pipeline: job_record.pipeline,
      pipelines: job_record.pipelines,
    })
  }
}
