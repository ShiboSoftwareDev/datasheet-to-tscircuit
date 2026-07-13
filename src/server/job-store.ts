import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import type { Job, JobEvent, JobLog, JobLogStream } from "@/shared/job-types"

type JobSubscriber = (job_event: JobEvent) => void

interface JobRecord extends Job {
  job_dir: string
  subscriber_set: Set<JobSubscriber>
}

export interface CreateJobInput {
  job_id: string
  job_dir: string
  file_name: string
}

export type JobUpdate = Partial<
  Pick<
    Job,
    | "display_status"
    | "is_complete"
    | "has_errors"
    | "error_message"
    | "completed_at"
    | "component_code"
    | "circuit_json"
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
    component_code: job_record.component_code,
    circuit_json: job_record.circuit_json,
  }
}

export class JobStore {
  private job_map = new Map<string, JobRecord>()

  createJob(input: CreateJobInput): Job {
    const job_record: JobRecord = {
      job_id: input.job_id,
      job_dir: input.job_dir,
      file_name: input.file_name,
      created_at: new Date().toISOString(),
      display_status: "queued",
      is_complete: false,
      has_errors: false,
      logs: [],
      subscriber_set: new Set(),
    }
    this.job_map.set(job_record.job_id, job_record)
    return getPublicJob(job_record)
  }

  getJob(job_id: string): Job | undefined {
    const job_record = this.job_map.get(job_id)
    return job_record ? getPublicJob(job_record) : undefined
  }

  getJobDir(job_id: string): string | undefined {
    return this.job_map.get(job_id)?.job_dir
  }

  updateJob(job_id: string, job_update: JobUpdate): Job {
    const job_record = this.job_map.get(job_id)
    if (!job_record) throw new Error(`Job ${job_id} was not found`)
    Object.assign(job_record, job_update)
    const job = getPublicJob(job_record)
    this.publish(job_record, { event_type: "job_updated", job })
    return job
  }

  async appendLog(job_id: string, stream: JobLogStream, message: string): Promise<JobLog> {
    const job_record = this.job_map.get(job_id)
    if (!job_record) throw new Error(`Job ${job_id} was not found`)

    const log: JobLog = {
      log_id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      stream,
      message,
    }
    job_record.logs.push(log)
    await appendFile(
      join(job_record.job_dir, "agent.log"),
      `[${log.created_at}] [${stream}] ${message}`,
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

  private publish(job_record: JobRecord, job_event: JobEvent): void {
    for (const subscriber of job_record.subscriber_set) subscriber(job_event)
  }
}
