import type { JobEvent, JobListEvent, JobSummary } from "@/shared/job-types"
import type { JobStore } from "../job-store"
import type { ModelRunStore } from "../model-run-store"

function withModelRunSummary(job: JobSummary, model_run_store?: ModelRunStore): JobSummary {
  const model_run = model_run_store?.getModelRunSummaryForJob(job.job_id)
  return model_run ? { ...job, model_run } : job
}

export function listJobSummaries(job_store: JobStore, model_run_store?: ModelRunStore): JobSummary[] {
  return job_store.listJobs().map((job) => withModelRunSummary(job, model_run_store))
}

export function createEventStream(job_id: string, job_store: JobStore): Response {
  const encoder = new TextEncoder()
  let unsubscribe: (() => void) | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (job_event: JobEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(job_event)}\n\n`))
        } catch {
          unsubscribe?.()
          if (heartbeat) clearInterval(heartbeat)
        }
      }

      const job = job_store.getJob(job_id)
      if (job) send({ event_type: "snapshot", job })
      unsubscribe = job_store.subscribe(job_id, send)
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"))
        } catch {
          unsubscribe?.()
          if (heartbeat) clearInterval(heartbeat)
        }
      }, 15_000)
    },
    cancel() {
      unsubscribe?.()
      if (heartbeat) clearInterval(heartbeat)
    },
  })

  return new Response(body, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  })
}

export function createJobListEventStream(job_store: JobStore, model_run_store?: ModelRunStore): Response {
  const encoder = new TextEncoder()
  let unsubscribe_jobs: (() => void) | undefined
  let unsubscribe_model_runs: (() => void) | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const cleanup = () => {
    unsubscribe_jobs?.()
    unsubscribe_model_runs?.()
    if (heartbeat) clearInterval(heartbeat)
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (job_event: JobListEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(job_event)}\n\n`))
        } catch {
          cleanup()
        }
      }

      send({ event_type: "jobs_snapshot", jobs: listJobSummaries(job_store, model_run_store) })
      unsubscribe_jobs = job_store.subscribeToJobList((event) => {
        send(
          event.event_type === "job_updated"
            ? { ...event, job: withModelRunSummary(event.job, model_run_store) }
            : event,
        )
      })
      unsubscribe_model_runs = model_run_store?.subscribeToModelRunList((model_run) => {
        const job = job_store.getJobSummary(model_run.job_id)
        if (job) send({ event_type: "job_updated", job: { ...job, model_run } })
      })
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"))
        } catch {
          cleanup()
        }
      }, 15_000)
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(body, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  })
}
