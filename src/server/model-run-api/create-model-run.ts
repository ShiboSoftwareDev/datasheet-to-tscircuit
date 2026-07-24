import { launchModelRun } from "./launch-model-run"
import type { ModelRunApiContext } from "./model-run-api-context"
import { errorResponse, getJobId, jsonResponse, readEffort } from "./model-run-api-responses"

export async function createModelRun(request: Request, context: ModelRunApiContext): Promise<Response> {
  const request_url = new URL(request.url)
  const job_id = getJobId(request_url)
  if (!job_id) {
    return errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 })
  }
  const job = context.job_store.getJob(job_id)
  const job_dir = context.job_store.getJobDir(job_id)
  if (!job || !job_dir) {
    return errorResponse({
      error_code: "job_not_found",
      message: `No job exists for ${job_id}.`,
      status: 404,
    })
  }
  if (context.model_run_store.getModelRunForJob(job_id)) {
    return errorResponse({
      error_code: "model_run_exists",
      message: "This job already has a SPICE model run.",
      status: 409,
    })
  }
  const effort_multiplier = await readEffort(request, "effort_multiplier")
  if (!effort_multiplier) {
    return errorResponse({
      error_code: "invalid_effort",
      message: "effort_multiplier must be an integer from 1 through 8.",
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
  const use_openai = job.use_openai ?? fallback_use_openai
  if (job.use_openai === undefined) {
    context.job_store.updateJob(job_id, { use_openai })
  }
  const model_run = await launchModelRun({ job_id, job_dir, effort_multiplier }, { ...context, use_openai })
  return jsonResponse({ model_run }, 202)
}
