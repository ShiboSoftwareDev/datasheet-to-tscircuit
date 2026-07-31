import { rename, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { JobApiContext } from "./job-api-context"
import { errorResponse, getJobId } from "./job-api-responses"
import { waitForJobCompletion, waitForModelRunCompletion } from "./wait-for-job-completion"

export async function deleteJob(request_url: URL, context: JobApiContext): Promise<Response> {
  const job_id = getJobId(request_url)
  if (!job_id) {
    return errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 })
  }

  const lease_result = context.job_store.acquireJobDeletionLease(job_id)
  if (lease_result.status === "not_found") {
    return errorResponse({
      error_code: "job_not_found",
      message: `No job exists for ${job_id}.`,
      status: 404,
    })
  }
  if (lease_result.status === "already_deleting") {
    return errorResponse({
      error_code: "job_delete_in_progress",
      message: "This task is already being deleted.",
      status: 409,
    })
  }

  const { lease } = lease_result
  let should_release_lease = true
  try {
    const job_dir = context.job_store.getJobDir(job_id)
    const job = context.job_store.getJob(job_id)
    if (!job_dir || !job) {
      return errorResponse({
        error_code: "job_not_found",
        message: `No job exists for ${job_id}.`,
        status: 404,
      })
    }

    const model_run = context.model_run_store?.getModelRunForJob(job_id)
    if (model_run && !model_run.is_complete) {
      context.model_run_store?.requestCancellation(model_run.model_run_id)
      if (
        !(await waitForModelRunCompletion({ model_run_id: model_run.model_run_id }, context.model_run_store!))
      ) {
        return errorResponse({
          error_code: "model_stop_timeout",
          message: "The SPICE model run could not be stopped.",
          status: 409,
        })
      }
    }

    if (!job.is_complete) {
      context.job_store.requestCancellation(job_id)
      if (!(await waitForJobCompletion({ job_id }, context.job_store))) {
        return errorResponse({
          error_code: "job_stop_timeout",
          message: "The task could not be stopped before deletion.",
          status: 409,
        })
      }
    }

    const tombstone_path = join(dirname(job_dir), `.deleting-${basename(job_dir)}-${crypto.randomUUID()}`)
    try {
      await rename(job_dir, tombstone_path)
      should_release_lease = false
    } catch (error) {
      return errorResponse({
        error_code: "job_delete_failed",
        message: `The task directory could not be tombstoned: ${error instanceof Error ? error.message : String(error)}`,
        status: 500,
      })
    }

    if (!context.job_store.deleteJob(job_id)) {
      const restored = await rename(tombstone_path, job_dir)
        .then(() => true)
        .catch(() => false)
      should_release_lease = restored
      return errorResponse({
        error_code: "job_delete_conflict",
        message: "The task is still active and cannot be deleted.",
        status: 409,
      })
    }
    context.model_run_store?.deleteModelRunForJob(job_id)
    // Once renamed, a crash or cleanup failure cannot resurrect this job on restart.
    await rm(tombstone_path, { recursive: true, force: true }).catch(() => undefined)
    return new Response(null, { status: 204 })
  } finally {
    if (should_release_lease) context.job_store.releaseJobDeletionLease(lease)
  }
}
