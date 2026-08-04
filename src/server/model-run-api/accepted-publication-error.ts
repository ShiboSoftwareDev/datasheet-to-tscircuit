import { errorResponse } from "./model-run-api-responses"

export function acceptedPublicationErrorResponse(input: {
  job_id: string
  operation: string
  error: unknown
}): Response {
  console.error("[model-publication] reader_failed", {
    job_id: input.job_id,
    operation: input.operation,
    cause: input.error instanceof Error ? input.error.message : String(input.error),
  })
  return errorResponse({
    error_code: "accepted_publication_invalid",
    message:
      "The accepted model publication failed its integrity checks. Inspect the server diagnostic for this job.",
    status: 500,
  })
}
