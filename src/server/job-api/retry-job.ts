import { copyFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { Job } from "@/shared/job-types"
import { writeJobScaffold } from "../job-scaffold"
import type { JobApiContext } from "./job-api-context"
import { errorResponse, getJobId, jsonResponse } from "./job-api-responses"
import { launchJobRunner } from "./launch-job-runner"

interface RetryJobInput {
  request_url: URL
  pending_retries: Map<string, Promise<Job>>
}

export async function retryJob(
  { request_url, pending_retries }: RetryJobInput,
  context: JobApiContext,
): Promise<Response> {
  const source_job_id = getJobId(request_url)
  if (!source_job_id) {
    return errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 })
  }

  const source = context.job_store.getJobRetrySource(source_job_id)
  if (!source) {
    return errorResponse({
      error_code: "job_not_found",
      message: `No job exists for ${source_job_id}.`,
      status: 404,
    })
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
    context.job_store.updateJob(source_job_id, { use_openai })
  }

  const active_retry = context.job_store.getActiveRetryForSource(source_job_id)
  if (active_retry) return jsonResponse({ job: active_retry }, 202)

  let pending_retry = pending_retries.get(source_job_id)
  if (!pending_retry) {
    pending_retry = (async () => {
      const existing_retry = context.job_store.getActiveRetryForSource(source_job_id)
      if (existing_retry) return existing_retry

      const job_id = crypto.randomUUID()
      const job_dir = join(context.jobs_root, job_id)
      await mkdir(job_dir, { recursive: true })
      await writeJobScaffold(job_dir)
      await copyFile(join(source.job_dir, "datasheet.pdf"), join(job_dir, "datasheet.pdf"))

      const job = context.job_store.createJob({
        job_id,
        job_dir,
        file_name: source.file_name,
        use_openai,
        additional_instructions: source.additional_instructions,
        retry_source_job_id: source_job_id,
      })
      await context.job_store.appendLog(job_id, {
        stream: "system",
        message: `Retrying ${source.display_status} task ${source_job_id}.\n`,
      })

      launchJobRunner(
        { job_id, additional_instructions: source.additional_instructions },
        { ...context, use_openai },
      )
      return job
    })()
    pending_retries.set(source_job_id, pending_retry)
  }

  try {
    return jsonResponse({ job: await pending_retry }, 202)
  } finally {
    if (pending_retries.get(source_job_id) === pending_retry) {
      pending_retries.delete(source_job_id)
    }
  }
}
