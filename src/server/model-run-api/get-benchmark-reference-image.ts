import { extname } from "node:path"
import type { ModelPreviewArtifactIdentity } from "@/shared/job-types"
import { parseModelPreviewArtifactIdentity } from "@/shared/model-selected-preview"
import { modelCheckpointRequiresPublicationPointer } from "../modeling"
import { ModelReferenceImageIdentityError, resolveBenchmarkReferenceImage } from "../modeling/reference-image"
import { acceptedPublicationErrorResponse } from "./accepted-publication-error"
import type { ModelRunApiContext } from "./model-run-api-context"
import { errorResponse, getJobId } from "./model-run-api-responses"

const SAFE_BENCHMARK_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store")
  return response
}

export async function getBenchmarkReferenceImage(
  request_url: URL,
  context: ModelRunApiContext,
): Promise<Response> {
  const job_id = getJobId(request_url)
  if (!job_id) {
    return noStore(
      errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 }),
    )
  }
  const benchmark_id = request_url.searchParams.get("benchmark_id")?.trim()
  if (!benchmark_id) {
    return noStore(
      errorResponse({
        error_code: "benchmark_id_required",
        message: "benchmark_id is required.",
        status: 400,
      }),
    )
  }
  if (!SAFE_BENCHMARK_ID.test(benchmark_id)) {
    return noStore(
      errorResponse({
        error_code: "invalid_benchmark_id",
        message: "benchmark_id contains unsupported characters.",
        status: 400,
      }),
    )
  }
  const raw_preview_generation = request_url.searchParams.get("preview_generation")?.trim()
  const raw_model_revision = request_url.searchParams.get("model_revision")?.trim()
  if (Boolean(raw_preview_generation) !== Boolean(raw_model_revision)) {
    return noStore(
      errorResponse({
        error_code: "preview_artifact_identity_incomplete",
        message: "preview_generation and model_revision must be provided together.",
        status: 400,
      }),
    )
  }
  let requested_artifact_identity: ModelPreviewArtifactIdentity | undefined
  if (raw_preview_generation && raw_model_revision) {
    try {
      requested_artifact_identity = parseModelPreviewArtifactIdentity({
        preview_generation: raw_preview_generation,
        model_revision: raw_model_revision,
      })
    } catch (error) {
      return noStore(
        errorResponse({
          error_code: "preview_artifact_identity_invalid",
          message: error instanceof Error ? error.message : "The preview artifact identity is invalid.",
          status: 400,
        }),
      )
    }
  }

  const model_run_id = context.model_run_store.getModelRunIdForJob(job_id)
  const model_dir = model_run_id ? context.model_run_store.getModelDir(model_run_id) : undefined
  if (!model_run_id || !model_dir) {
    return noStore(
      errorResponse({
        error_code: "model_run_not_found",
        message: "This job has no SPICE model run.",
        status: 404,
      }),
    )
  }

  let image: Awaited<ReturnType<typeof resolveBenchmarkReferenceImage>>
  try {
    const model_run = context.model_run_store.getModelRun(model_run_id)
    const candidate_preview = model_run?.validation?.artifact_state === "candidate"
    const candidate_artifact_identity = candidate_preview
      ? parseModelPreviewArtifactIdentity({
          preview_generation: model_run.validation?.preview_generation,
          model_revision: model_run.validation?.model_revision,
        })
      : undefined
    image = await resolveBenchmarkReferenceImage({
      job_id,
      model_dir,
      benchmark_id,
      current_preview_generation: candidate_artifact_identity?.preview_generation,
      current_model_revision: candidate_artifact_identity?.model_revision,
      requested_artifact_identity,
      require_accepted_publication: modelCheckpointRequiresPublicationPointer(model_run),
    })
  } catch (error) {
    if (error instanceof ModelReferenceImageIdentityError) {
      return noStore(
        errorResponse({
          error_code: error.error_code,
          message: error.message,
          status: error.status,
        }),
      )
    }
    const model_run = context.model_run_store.getModelRun(model_run_id)
    if (model_run?.validation?.artifact_state === "candidate") {
      const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim()
      const bounded_detail = detail.length > 500 ? `${detail.slice(0, 497)}...` : detail
      return noStore(
        errorResponse({
          error_code: "candidate_reference_image_invalid",
          message: `Candidate reference image ${benchmark_id} is invalid: ${bounded_detail}`,
          status: 500,
        }),
      )
    }
    return noStore(
      acceptedPublicationErrorResponse({
        job_id,
        operation: "load_reference_image",
        error,
      }),
    )
  }
  if (!image) {
    return noStore(
      errorResponse({
        error_code: "reference_image_not_found",
        message: `No datasheet reference image exists for ${benchmark_id}.`,
        status: 404,
      }),
    )
  }

  const body = "bytes" in image ? image.bytes : Bun.file(image.file_path)
  return noStore(
    new Response(body, {
      headers: {
        "Content-Disposition": `inline; filename="${benchmark_id}-datasheet-reference${extname(image.file_name).toLowerCase()}"`,
        "Content-Type": image.content_type,
      },
    }),
  )
}
