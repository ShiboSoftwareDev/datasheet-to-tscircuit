import type { ModelRunApiContext } from "./model-run-api-context"
import { errorResponse, getJobId, jobDeletingResponse, jsonResponse } from "./model-run-api-responses"
import { appendModelRunLogBestEffort, launchModelRunner } from "./launch-model-run"

export async function retryModelRun(request_url: URL, context: ModelRunApiContext): Promise<Response> {
  const job_id = getJobId(request_url)
  if (!job_id) {
    return errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 })
  }
  const job = context.job_store.getJob(job_id)
  if (!job) {
    return errorResponse({
      error_code: "job_not_found",
      message: `No job exists for ${job_id}.`,
      status: 404,
    })
  }
  if (context.job_store.isJobDeleting(job_id)) return jobDeletingResponse()
  const current_run = context.model_run_store.getModelRunForJob(job_id)
  if (!current_run) {
    return errorResponse({
      error_code: "model_run_not_found",
      message: "This job has no SPICE model run.",
      status: 404,
    })
  }
  if (!current_run.is_complete) {
    return errorResponse({
      error_code: "model_run_not_retryable",
      message: "Only a finished SPICE model run can be restarted.",
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
  const use_openai = current_run.use_openai ?? job.use_openai ?? fallback_use_openai
  if (current_run.use_openai === undefined) {
    context.model_run_store.updateModelRun(current_run.model_run_id, { use_openai })
  }
  if (job.use_openai === undefined) {
    context.job_store.updateJob(job_id, { use_openai })
  }
  const result = context.model_run_store.retryModelRun(current_run.model_run_id)
  if (result.status === "not_found") {
    return errorResponse({
      error_code: "model_run_not_found",
      message: "This job has no SPICE model run.",
      status: 404,
    })
  }
  if (result.status === "busy") {
    return errorResponse({
      error_code: "model_run_busy",
      message: "The current model-run execution is still finishing. Retry shortly.",
      status: 409,
    })
  }
  if (result.status === "not_retryable") {
    return errorResponse({
      error_code: "model_run_not_retryable",
      message: "Only a finished SPICE model run can be restarted.",
      status: 409,
    })
  }
  const execution_context = { ...context, use_openai }
  appendModelRunLogBestEffort(
    execution_context,
    current_run.model_run_id,
    `Restarting SPICE generation after ${current_run.status === "complete" ? "successful completion" : current_run.status === "cancelled" ? "the stopped run" : current_run.status === "timed_out" ? "the run timed out" : "failure"}; prior contracts, plans, candidates, and debug bundles remain preserved.\n`,
  )
  launchModelRunner(current_run.model_run_id, execution_context)
  return jsonResponse({ model_run: context.model_run_store.getModelRun(current_run.model_run_id) }, 202)
}
