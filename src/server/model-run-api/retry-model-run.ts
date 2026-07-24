import { runModel } from "../model-runner"
import type { ModelRunApiContext } from "./model-run-api-context"
import { errorResponse, getJobId, jsonResponse } from "./model-run-api-responses"

export async function retryModelRun(request_url: URL, context: ModelRunApiContext): Promise<Response> {
  const job_id = getJobId(request_url)
  if (!job_id) {
    return errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 })
  }
  const current_run = context.model_run_store.getModelRunForJob(job_id)
  if (!current_run) {
    return errorResponse({
      error_code: "model_run_not_found",
      message: "This job has no SPICE model run.",
      status: 404,
    })
  }
  const requested_provider = request_url.searchParams.get("use_openai")
  const fallback_use_openai =
    requested_provider === "true"
      ? true
      : requested_provider === "false"
        ? false
        : (context.use_openai ?? false)
  const job = context.job_store.getJob(job_id)
  const use_openai = current_run.use_openai ?? job?.use_openai ?? fallback_use_openai
  const result = context.model_run_store.retryModelRun(current_run.model_run_id)
  if (result !== "retried") {
    return errorResponse({
      error_code: "model_run_not_failed",
      message: "Only a failed SPICE model run can be retried.",
      status: 409,
    })
  }
  if (current_run.use_openai === undefined) {
    context.model_run_store.updateModelRun(current_run.model_run_id, { use_openai })
  }
  if (job?.use_openai === undefined) {
    context.job_store.updateJob(job_id, { use_openai })
  }
  await context.model_run_store.appendLog(current_run.model_run_id, {
    stream: "system",
    message: "Retrying the failed run from its preserved evidence and best model checkpoint.\n",
  })
  const runner = context.run_model ?? runModel
  void runner({ model_run_id: current_run.model_run_id }, { ...context, use_openai })
  return jsonResponse({ model_run: context.model_run_store.getModelRun(current_run.model_run_id) }, 202)
}
