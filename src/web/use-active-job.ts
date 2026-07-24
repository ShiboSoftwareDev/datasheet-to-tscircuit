import { useEffect, useRef, useState } from "react"
import type { Job, JobEvent, JobListEvent, JobSummary } from "@/shared/job-types"
import { cancelJob, deleteJob, getJob, getJobs, retryJob } from "./api"

function parseEvent<T extends JobEvent | JobListEvent>(message: MessageEvent<string>): T | undefined {
  try {
    const parsed: unknown = JSON.parse(message.data)
    if (typeof parsed !== "object" || parsed === null || !("event_type" in parsed)) return undefined
    return parsed as T
  } catch {
    return undefined
  }
}

function summarizeJob(job: Job): JobSummary {
  return {
    job_id: job.job_id,
    file_name: job.file_name,
    created_at: job.created_at,
    completed_at: job.completed_at,
    display_status: job.display_status,
    is_complete: job.is_complete,
    has_errors: job.has_errors,
    error_message: job.error_message,
    warnings: job.warnings,
  }
}

function upsertJobSummary(current_jobs: JobSummary[], next_job: JobSummary): JobSummary[] {
  return [next_job, ...current_jobs.filter((job) => job.job_id !== next_job.job_id)].sort((first, second) =>
    second.created_at.localeCompare(first.created_at),
  )
}

function mergeJobSummaries(current_jobs: JobSummary[], loaded_jobs: JobSummary[]): JobSummary[] {
  return current_jobs.reduce(upsertJobSummary, loaded_jobs)
}

export function useActiveJob() {
  const initial_job_id = new URLSearchParams(window.location.search).get("job_id")
  const [jobs, setJobs] = useState<JobSummary[]>([])
  const [job, setJob] = useState<Job>()
  const [job_id, setJobId] = useState<string | undefined>(initial_job_id ?? undefined)
  const [load_error, setLoadError] = useState<string>()
  const [action_error, setActionError] = useState<string>()
  const [cancelling_job_ids, setCancellingJobIds] = useState<Set<string>>(new Set())
  const [retrying_job_ids, setRetryingJobIds] = useState<Set<string>>(new Set())
  const retrying_job_id_ref = useRef(new Set<string>())
  const [deleting_job_ids, setDeletingJobIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    let is_active = true
    getJobs()
      .then((loaded_jobs) => {
        if (is_active) setJobs((current_jobs) => mergeJobSummaries(current_jobs, loaded_jobs))
      })
      .catch((error: Error) => {
        if (is_active) setActionError(error.message)
      })

    const event_source = new EventSource("/api/jobs/events")
    event_source.onmessage = (message) => {
      const job_event = parseEvent<JobListEvent>(message)
      if (!job_event) return
      if (job_event.event_type === "jobs_snapshot") setJobs(job_event.jobs)
      else if (job_event.event_type === "job_deleted") {
        setJobs((current_jobs) => current_jobs.filter((job) => job.job_id !== job_event.job_id))
      } else setJobs((current_jobs) => upsertJobSummary(current_jobs, job_event.job))
    }

    return () => {
      is_active = false
      event_source.close()
    }
  }, [])

  useEffect(() => {
    if (!job_id) {
      setJob(undefined)
      return
    }

    let is_active = true
    setLoadError(undefined)
    setJob((current_job) => (current_job?.job_id === job_id ? current_job : undefined))
    getJob(job_id)
      .then((loaded_job) => {
        if (!is_active) return
        setJob((current_job) => current_job ?? loaded_job)
        setJobs((current_jobs) =>
          current_jobs.some((listed_job) => listed_job.job_id === loaded_job.job_id)
            ? current_jobs
            : upsertJobSummary(current_jobs, summarizeJob(loaded_job)),
        )
      })
      .catch((error: Error) => {
        if (is_active) setLoadError(error.message)
      })

    const event_source = new EventSource(`/api/job/events?job_id=${encodeURIComponent(job_id)}`)
    event_source.onmessage = (message) => {
      const job_event = parseEvent<JobEvent>(message)
      if (!job_event) return
      if (job_event.event_type === "log") {
        setJob((current_job) => {
          if (
            !current_job ||
            current_job.job_id !== job_id ||
            current_job.logs.some((log) => log.log_id === job_event.log.log_id)
          ) {
            return current_job
          }
          return { ...current_job, logs: [...current_job.logs, job_event.log] }
        })
      } else {
        setJob(job_event.job)
        setJobs((current_jobs) => upsertJobSummary(current_jobs, summarizeJob(job_event.job)))
      }
    }

    return () => {
      is_active = false
      event_source.close()
    }
  }, [job_id])

  const setActiveJobId = (next_job_id?: string) => {
    setJobId(next_job_id)
    setLoadError(undefined)
    setActionError(undefined)
    const request_url = new URL(window.location.href)
    if (next_job_id) request_url.searchParams.set("job_id", next_job_id)
    else request_url.searchParams.delete("job_id")
    window.history.replaceState({}, "", request_url)
  }

  const selectJob = (next_job: Job) => {
    setJob(next_job)
    setJobs((current_jobs) => upsertJobSummary(current_jobs, summarizeJob(next_job)))
    setActiveJobId(next_job.job_id)
  }

  const cancelTask = async (target_job_id: string) => {
    if (cancelling_job_ids.has(target_job_id)) return
    setCancellingJobIds((current_ids) => new Set(current_ids).add(target_job_id))
    setActionError(undefined)
    try {
      const cancelled_job = await cancelJob(target_job_id)
      setJobs((current_jobs) => upsertJobSummary(current_jobs, summarizeJob(cancelled_job)))
      if (job_id === target_job_id) setJob(cancelled_job)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The task could not be stopped.")
    } finally {
      setCancellingJobIds((current_ids) => {
        const next_ids = new Set(current_ids)
        next_ids.delete(target_job_id)
        return next_ids
      })
    }
  }

  const retryTask = async (target_job_id: string) => {
    if (retrying_job_id_ref.current.has(target_job_id)) return
    retrying_job_id_ref.current.add(target_job_id)
    setRetryingJobIds((current_ids) => new Set(current_ids).add(target_job_id))
    setActionError(undefined)
    try {
      selectJob(await retryJob(target_job_id))
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The task could not be retried.")
    } finally {
      retrying_job_id_ref.current.delete(target_job_id)
      setRetryingJobIds((current_ids) => {
        const next_ids = new Set(current_ids)
        next_ids.delete(target_job_id)
        return next_ids
      })
    }
  }

  const deleteTask = async (target_job_id: string) => {
    if (deleting_job_ids.has(target_job_id)) return
    setDeletingJobIds((current_ids) => new Set(current_ids).add(target_job_id))
    setActionError(undefined)
    try {
      await deleteJob(target_job_id)
      setJobs((current_jobs) => current_jobs.filter((listed_job) => listed_job.job_id !== target_job_id))
      if (job_id === target_job_id) setActiveJobId(undefined)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The task could not be deleted.")
    } finally {
      setDeletingJobIds((current_ids) => {
        const next_ids = new Set(current_ids)
        next_ids.delete(target_job_id)
        return next_ids
      })
    }
  }

  return {
    jobs,
    job,
    active_job_id: job_id,
    load_error,
    action_error,
    cancelling_job_ids,
    retrying_job_ids,
    deleting_job_ids,
    selectJob,
    selectTask: setActiveJobId,
    startNewTask: () => setActiveJobId(undefined),
    cancelTask,
    retryTask,
    deleteTask,
  }
}
