import type { Job } from "@/shared/job-types"
import { JobApiContext } from "./job-api-context"
import { createJobFromRequest } from "./create-job-from-request"
import { errorResponse, getJobId, jsonResponse } from "./job-api-responses"
import { createEventStream, createJobListEventStream, listJobSummaries } from "./create-job-event-stream"
import { cancelJob } from "./cancel-job"
import { retryJob } from "./retry-job"
import { deleteJob } from "./delete-job"
import { getJobFile } from "./get-job-file"

export function createJobApiHandler(context: JobApiContext) {
  const pending_retries = new Map<string, Promise<Job>>()
  return async (request: Request): Promise<Response | undefined> => {
    const request_url = new URL(request.url)
    if (!request_url.pathname.startsWith("/api/")) return undefined

    if (request.method === "OPTIONS") return new Response(null, { status: 204 })
    if (request_url.pathname === "/api/job/create" && request.method === "POST") {
      return createJobFromRequest(request, context)
    }
    if (request_url.pathname === "/api/jobs" && request.method === "GET") {
      return jsonResponse({ jobs: listJobSummaries(context.job_store, context.model_run_store) })
    }
    if (request_url.pathname === "/api/jobs/events" && request.method === "GET") {
      return createJobListEventStream(context.job_store, context.model_run_store)
    }
    if (request_url.pathname === "/api/job/cancel" && request.method === "POST") {
      return cancelJob(request_url, context)
    }
    if (request_url.pathname === "/api/job/retry" && request.method === "POST") {
      return retryJob({ request_url, pending_retries }, context)
    }
    if (request_url.pathname === "/api/job/delete" && request.method === "DELETE") {
      return deleteJob(request_url, context)
    }
    if (request_url.pathname === "/api/job/get" && request.method === "GET") {
      const job_id = getJobId(request_url)
      if (!job_id) {
        return errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 })
      }
      const job = context.job_store.getJob(job_id)
      return job
        ? jsonResponse({ job })
        : errorResponse({
            error_code: "job_not_found",
            message: `No job exists for ${job_id}.`,
            status: 404,
          })
    }
    if (request_url.pathname === "/api/job/events" && request.method === "GET") {
      const job_id = getJobId(request_url)
      if (!job_id) {
        return errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 })
      }
      if (!context.job_store.getJob(job_id)) {
        return errorResponse({
          error_code: "job_not_found",
          message: `No job exists for ${job_id}.`,
          status: 404,
        })
      }
      return createEventStream(job_id, context.job_store)
    }
    if (request_url.pathname === "/api/job/file" && request.method === "GET") {
      return getJobFile(request_url, context)
    }
    return errorResponse({ error_code: "route_not_found", message: "API route not found.", status: 404 })
  }
}
