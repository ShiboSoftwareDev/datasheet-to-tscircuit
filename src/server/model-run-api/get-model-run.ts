import { ModelRunApiContext } from "./model-run-api-context"
import { errorResponse, getJobId, jsonResponse } from "./model-run-api-responses"

export async function getModelRun(request_url: URL, context: ModelRunApiContext): Promise<Response> {
  const job_id = getJobId(request_url)
  if (!job_id) {
    return errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 })
  }
  const model_run = context.model_run_store.getModelRunForJob(job_id)
  if (!model_run) {
    return errorResponse({
      error_code: "model_run_not_found",
      message: "This job has no SPICE model run.",
      status: 404,
    })
  }
  return jsonResponse({ model_run })
}
