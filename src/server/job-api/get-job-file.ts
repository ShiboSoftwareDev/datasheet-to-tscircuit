import { JobApiContext } from "./job-api-context"
import { errorResponse, getJobId } from "./job-api-responses"
import { resolveJobFileArtifact } from "./resolve-job-file-artifact"

export async function getJobFile(request_url: URL, context: JobApiContext): Promise<Response> {
  const job_id = getJobId(request_url)
  const file_kind = request_url.searchParams.get("file")
  if (!job_id) {
    return errorResponse({ error_code: "job_id_required", message: "job_id is required.", status: 400 })
  }
  const job_dir = context.job_store.getJobDir(job_id)
  if (!job_dir) {
    return errorResponse({
      error_code: "job_not_found",
      message: `No job exists for ${job_id}.`,
      status: 404,
    })
  }

  const resolution = await resolveJobFileArtifact(job_dir, file_kind)
  if (resolution.status === "invalid") {
    return errorResponse({ error_code: "invalid_file", message: "Unknown job artifact.", status: 400 })
  }
  if (resolution.status === "missing") {
    return errorResponse({
      error_code: "file_not_found",
      message: `${resolution.download_name} is not available.`,
      status: 404,
    })
  }
  const artifact = Bun.file(resolution.artifact_path)
  return new Response(artifact, {
    headers: {
      "Cache-Control": resolution.content_type.startsWith("image/") ? "no-store" : "private, no-cache",
      "Content-Disposition": `${request_url.searchParams.get("display") === "inline" ? "inline" : "attachment"}; filename="${resolution.download_name}"`,
      "Content-Type": resolution.content_type,
    },
  })
}
