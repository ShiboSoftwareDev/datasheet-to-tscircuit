import { extname, join } from "node:path"
import { resolveDirectoryReferenceImage } from "../modeling/reference-image"
import type { ModelRunApiContext } from "./model-run-api-context"
import { errorResponse, getJobId } from "./model-run-api-responses"

const SAFE_REFERENCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store")
  return response
}

export async function getFoundReferenceImage(
  request_url: URL,
  context: ModelRunApiContext,
): Promise<Response> {
  const job_id = getJobId(request_url)
  if (!job_id) {
    return noStore(
      errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 }),
    )
  }
  const reference_id = request_url.searchParams.get("reference_id")?.trim()
  if (!reference_id) {
    return noStore(
      errorResponse({
        error_code: "reference_id_required",
        message: "reference_id is required.",
        status: 400,
      }),
    )
  }
  if (!SAFE_REFERENCE_ID.test(reference_id)) {
    return noStore(
      errorResponse({
        error_code: "invalid_reference_id",
        message: "reference_id contains unsupported characters.",
        status: 400,
      }),
    )
  }
  const model_run_id = context.model_run_store.getModelRunIdForJob(job_id)
  const model_dir = model_run_id ? context.model_run_store.getModelDir(model_run_id) : undefined
  if (!model_dir) {
    return noStore(
      errorResponse({
        error_code: "model_run_not_found",
        message: "This job has no SPICE model run.",
        status: 404,
      }),
    )
  }
  const resolved = await resolveDirectoryReferenceImage(join(model_dir, "found-references"), reference_id)
  if (!resolved.benchmark_found || !resolved.image) {
    return noStore(
      errorResponse({
        error_code: "found_reference_image_not_found",
        message: `No found datasheet reference image exists for ${reference_id}.`,
        status: 404,
      }),
    )
  }
  const body = "bytes" in resolved.image ? resolved.image.bytes : Bun.file(resolved.image.file_path)
  return noStore(
    new Response(body, {
      headers: {
        "Content-Disposition": `inline; filename="${reference_id}-found-reference${extname(resolved.image.file_name).toLowerCase()}"`,
        "Content-Type": resolved.image.content_type,
      },
    }),
  )
}
