import { ModelRunApiContext } from "./model-run-api-context"
import { createModelRun } from "./create-model-run"
import { extendModelRun } from "./extend-model-run"
import { cancelModelRun } from "./cancel-model-run"
import { retryModelRun } from "./retry-model-run"
import { getModelRun } from "./get-model-run"
import { getSelectedPreview } from "./get-selected-preview"
import { errorResponse, getJobId } from "./model-run-api-responses"
import { createEventStream } from "./create-model-run-event-stream"
import { getModelRunFile } from "./get-model-run-file"
import { getBenchmarkReferenceImage } from "./get-benchmark-reference-image"

export function createModelRunApiHandler(context: ModelRunApiContext) {
  return async (request: Request): Promise<Response | undefined> => {
    const request_url = new URL(request.url)
    if (!request_url.pathname.startsWith("/api/model-run/")) return undefined
    if (request.method === "OPTIONS") return new Response(null, { status: 204 })
    if (request_url.pathname === "/api/model-run/create" && request.method === "POST") {
      return createModelRun(request, context)
    }
    if (request_url.pathname === "/api/model-run/extend" && request.method === "POST") {
      return extendModelRun(request, context)
    }
    if (request_url.pathname === "/api/model-run/cancel" && request.method === "POST") {
      return cancelModelRun(request_url, context)
    }
    if (request_url.pathname === "/api/model-run/retry" && request.method === "POST") {
      return retryModelRun(request_url, context)
    }
    if (request_url.pathname === "/api/model-run/get" && request.method === "GET") {
      return getModelRun(request_url, context)
    }
    if (request_url.pathname === "/api/model-run/preview" && request.method === "GET") {
      return getSelectedPreview(request_url, context)
    }
    if (request_url.pathname === "/api/model-run/reference-image" && request.method === "GET") {
      return getBenchmarkReferenceImage(request_url, context)
    }
    if (request_url.pathname === "/api/model-run/events" && request.method === "GET") {
      const job_id = getJobId(request_url)
      if (!job_id) {
        return errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 })
      }
      const model_run_id = context.model_run_store.getModelRunIdForJob(job_id)
      return model_run_id
        ? createEventStream(model_run_id, context.model_run_store)
        : errorResponse({
            error_code: "model_run_not_found",
            message: "This job has no SPICE model run.",
            status: 404,
          })
    }
    if (request_url.pathname === "/api/model-run/file" && request.method === "GET") {
      return getModelRunFile(request_url, context)
    }
    return errorResponse({
      error_code: "route_not_found",
      message: "Model-run API route not found.",
      status: 404,
    })
  }
}
