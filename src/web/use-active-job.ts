import { useEffect, useState } from "react"
import type { Job, JobEvent } from "@/shared/job-types"
import { getJob } from "./api"

function parseJobEvent(message: MessageEvent<string>): JobEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(message.data)
    if (typeof parsed !== "object" || parsed === null || !("event_type" in parsed)) return undefined
    if (parsed.event_type === "log" && "log" in parsed) return parsed as JobEvent
    if ((parsed.event_type === "snapshot" || parsed.event_type === "job_updated") && "job" in parsed) {
      return parsed as JobEvent
    }
    return undefined
  } catch {
    return undefined
  }
}

export function useActiveJob() {
  const initial_job_id = new URLSearchParams(window.location.search).get("job_id")
  const [job, setJob] = useState<Job>()
  const [job_id, setJobId] = useState<string | undefined>(initial_job_id ?? undefined)
  const [load_error, setLoadError] = useState<string>()

  useEffect(() => {
    if (!job_id) return
    let is_active = true
    getJob(job_id)
      .then((loaded_job) => {
        if (is_active) setJob(loaded_job)
      })
      .catch((error: Error) => {
        if (is_active) setLoadError(error.message)
      })
    return () => {
      is_active = false
    }
  }, [job_id])

  useEffect(() => {
    if (!job_id) return
    const event_source = new EventSource(`/api/job/events?job_id=${encodeURIComponent(job_id)}`)
    event_source.onmessage = (message) => {
      const job_event = parseJobEvent(message)
      if (!job_event) return
      if (job_event.event_type === "log") {
        setJob((current_job) => {
          if (!current_job || current_job.logs.some((log) => log.log_id === job_event.log.log_id)) {
            return current_job
          }
          return { ...current_job, logs: [...current_job.logs, job_event.log] }
        })
      } else {
        setJob(job_event.job)
        if (job_event.job.is_complete) event_source.close()
      }
    }
    return () => event_source.close()
  }, [job_id])

  const selectJob = (next_job: Job) => {
    setLoadError(undefined)
    setJob(next_job)
    setJobId(next_job.job_id)
    const request_url = new URL(window.location.href)
    request_url.searchParams.set("job_id", next_job.job_id)
    window.history.replaceState({}, "", request_url)
  }

  const clearJob = () => {
    setJob(undefined)
    setJobId(undefined)
    setLoadError(undefined)
    const request_url = new URL(window.location.href)
    request_url.searchParams.delete("job_id")
    window.history.replaceState({}, "", request_url)
  }

  return { job, load_error, selectJob, clearJob }
}
