import { extname } from "node:path"
import { resolveBenchmarkReferenceImage } from "../model-artifact-monitor/resolve-benchmark-reference-image"
import type { ModelRunApiContext } from "./model-run-api-context"
import { errorResponse, getJobId } from "./model-run-api-responses"

const SAFE_BENCHMARK_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export async function getBenchmarkReferenceImage(
  request_url: URL,
  context: ModelRunApiContext,
): Promise<Response> {
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
  if (!SAFE_BENCHMARK_ID.test(benchmark_id)) {
    return errorResponse({
      error_code: "invalid_benchmark_id",
      message: "benchmark_id contains unsupported characters.",
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

  const image = await resolveBenchmarkReferenceImage({ model_dir, benchmark_id })
  if (!image) {
    return errorResponse({
      error_code: "reference_image_not_found",
      message: `No datasheet reference image exists for ${benchmark_id}.`,
      status: 404,
    })
  }

  return new Response(Bun.file(image.file_path), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `inline; filename="${benchmark_id}-datasheet-reference${extname(image.file_path).toLowerCase()}"`,
      "Content-Type": image.content_type,
    },
  })
}
