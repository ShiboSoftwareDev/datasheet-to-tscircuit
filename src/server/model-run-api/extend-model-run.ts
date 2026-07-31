import type { ModelRunApiContext } from "./model-run-api-context"
import {
  errorResponse,
  getJobId,
  jobDeletingResponse,
  jsonResponse,
  readEffort,
} from "./model-run-api-responses"
import { appendModelRunLogBestEffort, launchModelRunner } from "./launch-model-run"

export async function extendModelRun(request: Request, context: ModelRunApiContext): Promise<Response> {
  const request_url = new URL(request.url)
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
  if (context.job_store.isJobDeleting(job_id)) return jobDeletingResponse()
  const current_run = context.model_run_store.getModelRunForJob(job_id)
  if (!current_run) {
    return errorResponse({
      error_code: "model_run_not_found",
      message: "This job has no SPICE model run.",
      status: 404,
    })
  }
  if (current_run.status === "validating" || current_run.status === "cancelling") {
    return errorResponse({
      error_code: "model_run_busy",
      message: "Wait for the current model-run phase to finish.",
      status: 409,
    })
  }
  const additional_effort = await readEffort(request, "additional_effort")
  const job = context.job_store.getJob(job_id)
  if (!job) {
    return errorResponse({
      error_code: "job_not_found",
      message: `No job exists for ${job_id}.`,
      status: 404,
    })
  }
  if (context.job_store.isJobDeleting(job_id)) return jobDeletingResponse()
  if (!additional_effort) {
    return errorResponse({
      error_code: "invalid_effort",
      message: "additional_effort must be an integer from 1 through 8.",
      status: 400,
    })
  }
  const latest_run = context.model_run_store.getModelRunForJob(job_id)
  if (!latest_run) {
    return errorResponse({
      error_code: "model_run_not_found",
      message: "This job has no SPICE model run.",
      status: 404,
    })
  }
  if (latest_run.status === "validating" || latest_run.status === "cancelling") {
    return errorResponse({
      error_code: "model_run_busy",
      message: "Wait for the current model-run phase to finish.",
      status: 409,
    })
  }
  if (latest_run.effort_multiplier + additional_effort > 8) {
    return errorResponse({
      error_code: "invalid_effort",
      message: `The total repair budget cannot exceed 8×; this run already has ${latest_run.effort_multiplier}×.`,
      status: 400,
    })
  }
  const requested_provider = request_url.searchParams.get("use_openai")
  const fallback_use_openai =
    requested_provider === "true"
      ? true
      : requested_provider === "false"
        ? false
        : (context.use_openai ?? false)
  const use_openai = latest_run.use_openai ?? job.use_openai ?? fallback_use_openai
  if (latest_run.use_openai === undefined) {
    context.model_run_store.updateModelRun(latest_run.model_run_id, { use_openai })
  }
  if (job.use_openai === undefined) {
    context.job_store.updateJob(job_id, { use_openai })
  }
  const result = context.model_run_store.extendModelRun(latest_run.model_run_id, additional_effort)
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
      message: "Wait for the current model-run execution to finish, then try again.",
      status: 409,
    })
  }
  if (result.status === "invalid_effort") {
    return errorResponse({
      error_code: "invalid_effort",
      message: `The total repair budget cannot exceed 8×; this run already has ${result.model_run.effort_multiplier}×.`,
      status: 400,
    })
  }
  const execution_context = { ...context, use_openai }
  appendModelRunLogBestEffort(
    execution_context,
    latest_run.model_run_id,
    result.should_start
      ? `Added ${additional_effort}× repair effort and started a new full pipeline trace; the previous contract, plan, candidates, and debug bundles remain preserved.\n`
      : `Added ${additional_effort}× repair effort to the active pipeline; its accepted contract and validation plan remain unchanged.\n`,
  )
  if (result.should_start) {
    launchModelRunner(latest_run.model_run_id, execution_context)
  }
  return jsonResponse({ model_run: context.model_run_store.getModelRun(latest_run.model_run_id) }, 202)
}
