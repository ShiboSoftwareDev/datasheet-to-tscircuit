import { parseModelPreviewArtifactIdentity } from "@/shared/model-selected-preview"
import { loadStoredModelPreview, modelCheckpointRequiresPublicationPointer } from "../modeling"
import { acceptedPublicationErrorResponse } from "./accepted-publication-error"
import type { ModelRunApiContext } from "./model-run-api-context"
import { errorResponse, getJobId, jsonResponse } from "./model-run-api-responses"

export async function getSelectedPreview(request_url: URL, context: ModelRunApiContext): Promise<Response> {
  const job_id = getJobId(request_url)
  if (!job_id) {
    return errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 })
  }
  const benchmark_id = request_url.searchParams.get("benchmark_id")?.trim()
  if (!benchmark_id) {
    return errorResponse({
      error_code: "benchmark_id_required",
      message: "benchmark_id is required.",
      status: 400,
    })
  }
  const model_run_id = context.model_run_store.getModelRunIdForJob(job_id)
  const model_dir = model_run_id ? context.model_run_store.getModelDir(model_run_id) : undefined
  if (!model_run_id || !model_dir) {
    return errorResponse({
      error_code: "model_run_not_found",
      message: "This job has no SPICE model run.",
      status: 404,
    })
  }
  const model_run = context.model_run_store.getModelRun(model_run_id)
  const candidate_preview = model_run?.validation?.artifact_state === "candidate"
  let preview: Awaited<ReturnType<typeof loadStoredModelPreview>>
  try {
    const candidate_artifact_identity = candidate_preview
      ? parseModelPreviewArtifactIdentity({
          preview_generation: model_run.validation?.preview_generation,
          model_revision: model_run.validation?.model_revision,
        })
      : undefined
    preview = await loadStoredModelPreview({
      job_id,
      model_dir,
      case_id: benchmark_id,
      current_preview_generation: candidate_artifact_identity?.preview_generation,
      current_model_revision: candidate_artifact_identity?.model_revision,
      require_accepted_publication: modelCheckpointRequiresPublicationPointer(model_run),
    })
  } catch (error) {
    if (candidate_preview) {
      const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim()
      const bounded_detail = detail.length > 500 ? `${detail.slice(0, 497)}...` : detail
      console.error("[model-preview] candidate_reader_failed", {
        job_id,
        benchmark_id,
        cause: bounded_detail,
      })
      const response = errorResponse({
        error_code: "candidate_preview_invalid",
        message: `Candidate preview ${benchmark_id} is invalid: ${bounded_detail}`,
        status: 500,
      })
      response.headers.set("Cache-Control", "no-store")
      return response
    }
    const response = acceptedPublicationErrorResponse({
      job_id,
      operation: "load_preview",
      error,
    })
    response.headers.set("Cache-Control", "no-store")
    return response
  }
  const response = preview
    ? jsonResponse(preview)
    : errorResponse({
        error_code: "preview_not_found",
        message: `No benchmark circuit exists for ${benchmark_id}.`,
        status: 404,
      })
  response.headers.set("Cache-Control", "no-store")
  return response
}
