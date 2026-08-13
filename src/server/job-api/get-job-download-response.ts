import type { JobApiContext } from "./job-api-context"
import { errorResponse } from "./job-api-responses"
import { createJobDownloadPackage, type PackagedJobFileKind } from "./create-job-download-package"

export async function getJobDownloadResponse(input: {
  request_url: URL
  context: JobApiContext
  job_id: string
  job_dir: string
  file_kind: PackagedJobFileKind
}): Promise<Response> {
  const job = input.context.job_store.getJob(input.job_id)
  if (!job) {
    return errorResponse({
      error_code: "job_not_found",
      message: `No job exists for ${input.job_id}.`,
      status: 404,
    })
  }
  try {
    const download = await createJobDownloadPackage({
      file_kind: input.file_kind,
      job,
      job_dir: input.job_dir,
      application_id: input.request_url.searchParams.get("application_id") ?? undefined,
    })
    if (!download) {
      return errorResponse({
        error_code: "file_not_found",
        message: "The requested export is not available.",
        status: 404,
      })
    }
    return new Response(download.artifact_bytes, {
      headers: {
        "Cache-Control": "private, no-cache",
        "Content-Disposition": `attachment; filename="${download.download_name}"`,
        "Content-Type": download.content_type,
      },
    })
  } catch (error) {
    console.error("[job-export] generation_failed", {
      job_id: input.job_id,
      file_kind: input.file_kind,
      cause: error instanceof Error ? error.message : String(error),
    })
    return errorResponse({
      error_code: "artifact_export_failed",
      message: "The requested export could not be generated. Inspect the server diagnostic for this job.",
      status: 500,
    })
  }
}
