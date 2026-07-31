import { copyFile } from "node:fs/promises"
import { join } from "node:path"
import type { Job } from "@/shared/job-types"
import type { JobRetrySource } from "../job-store"
import type { JobApiContext } from "./job-api-context"
import { errorResponse, getJobId, jsonResponse } from "./job-api-responses"
import { launchJobRunner } from "./launch-job-runner"
import { prepareJobWorkspace } from "./prepare-job-workspace"

interface RetryJobInput {
  request_url: URL
  pending_retries: Map<string, Promise<Job>>
}

type RetrySourceUnavailableReason = "job_deleting" | "job_not_found"

class RetrySourceUnavailableError extends Error {
  constructor(readonly reason: RetrySourceUnavailableReason) {
    super(reason)
    this.name = "RetrySourceUnavailableError"
  }
}

function requireRetrySource(source_job_id: string, context: JobApiContext): JobRetrySource {
  if (context.job_store.isJobDeleting(source_job_id)) {
    throw new RetrySourceUnavailableError("job_deleting")
  }
  const source = context.job_store.getJobRetrySource(source_job_id)
  // Recheck after the read so a store implementation cannot hand out a source
  // at the same boundary where its deletion lease becomes visible.
  if (context.job_store.isJobDeleting(source_job_id)) {
    throw new RetrySourceUnavailableError("job_deleting")
  }
  if (!source) throw new RetrySourceUnavailableError("job_not_found")
  return source
}

function retrySourceUnavailableResponse(
  source_job_id: string,
  reason: RetrySourceUnavailableReason,
): Response {
  if (reason === "job_deleting") {
    return errorResponse({
      error_code: "job_deleting",
      message: "This task is being deleted and cannot be retried.",
      status: 409,
    })
  }
  return errorResponse({
    error_code: "job_not_found",
    message: `No job exists for ${source_job_id}.`,
    status: 404,
  })
}

export async function retryJob(
  { request_url, pending_retries }: RetryJobInput,
  context: JobApiContext,
): Promise<Response> {
  const source_job_id = getJobId(request_url)
  if (!source_job_id) {
    return errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 })
  }

  let source: JobRetrySource
  try {
    source = requireRetrySource(source_job_id, context)
  } catch (error) {
    if (error instanceof RetrySourceUnavailableError) {
      return retrySourceUnavailableResponse(source_job_id, error.reason)
    }
    throw error
  }
  if (
    source.display_status !== "cancelled" &&
    source.display_status !== "unsupported" &&
    source.display_status !== "failed"
  ) {
    return errorResponse({
      error_code: "job_not_retryable",
      message: "Only stopped or unsuccessful tasks can be retried.",
      status: 409,
    })
  }
  const requested_provider = request_url.searchParams.get("use_openai")
  const fallback_use_openai =
    requested_provider === "true"
      ? true
      : requested_provider === "false"
        ? false
        : (context.use_openai ?? false)
  const use_openai = source.use_openai ?? fallback_use_openai
  if (source.use_openai === undefined) {
    try {
      context.job_store.updateJob(source_job_id, { use_openai })
    } catch (error) {
      return errorResponse({
        error_code: "job_retry_failed",
        message: `The retry provider could not be saved for ${source_job_id}: ${error instanceof Error ? error.message : String(error)}`,
        status: 500,
      })
    }
  }

  const active_retry = context.job_store.getActiveRetryForSource(source_job_id)
  if (active_retry) return jsonResponse({ job: active_retry }, 202)

  let pending_retry = pending_retries.get(source_job_id)
  if (!pending_retry) {
    pending_retry = (async () => {
      const existing_retry = context.job_store.getActiveRetryForSource(source_job_id)
      if (existing_retry) return existing_retry

      const job_id = crypto.randomUUID()
      const workspace = await prepareJobWorkspace({
        jobs_root: context.jobs_root,
        job_id,
        write_datasheet: (datasheet_path) => copyFile(join(source.job_dir, "datasheet.pdf"), datasheet_path),
      })

      // Workspace preparation awaits filesystem work. The source may have
      // entered (or completed) deletion during that interval, so it must be
      // revalidated at the final synchronous create-and-launch boundary.
      try {
        requireRetrySource(source_job_id, context)
      } catch (error) {
        await workspace.discard().catch(() => undefined)
        throw error
      }

      let job: Job
      try {
        job = context.job_store.createJob({
          job_id,
          job_dir: workspace.job_dir,
          file_name: source.file_name,
          use_openai,
          additional_instructions: source.additional_instructions,
          retry_source_job_id: source_job_id,
        })
      } catch (error) {
        await workspace.discard().catch(() => undefined)
        throw error
      }
      const initial_log = context.job_store.appendLog(job_id, {
        stream: "system",
        message: `Retrying ${source.display_status} task ${source_job_id}.\n`,
      })

      launchJobRunner(
        { job_id, additional_instructions: source.additional_instructions },
        { ...context, use_openai },
      )
      void initial_log.catch(() => undefined)
      return job
    })()
    pending_retries.set(source_job_id, pending_retry)
  }

  try {
    return jsonResponse({ job: await pending_retry }, 202)
  } catch (error) {
    if (error instanceof RetrySourceUnavailableError) {
      return retrySourceUnavailableResponse(source_job_id, error.reason)
    }
    return errorResponse({
      error_code: "job_retry_failed",
      message: `Retry ${source_job_id} could not be created: ${error instanceof Error ? error.message : String(error)}`,
      status: 500,
    })
  } finally {
    if (pending_retries.get(source_job_id) === pending_retry) {
      pending_retries.delete(source_job_id)
    }
  }
}
