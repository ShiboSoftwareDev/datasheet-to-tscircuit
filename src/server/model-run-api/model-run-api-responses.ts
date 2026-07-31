import type { ApiError } from "@/shared/job-types"

export function jsonResponse(body: object, status = 200): Response {
  return Response.json(body, { status })
}

type ErrorResponseInput = ApiError["error"] & { status: number }

export function errorResponse({ error_code, message, status }: ErrorResponseInput): Response {
  const api_error: ApiError = { error: { error_code, message } }
  return jsonResponse(api_error, status)
}

export function jobDeletingResponse(): Response {
  return errorResponse({
    error_code: "job_deleting",
    message: "This task is being deleted; its SPICE model cannot be changed.",
    status: 409,
  })
}

export function getJobId(request_url: URL): string | undefined {
  return request_url.searchParams.get("job_id")?.trim() || undefined
}

export async function readEffort(
  request: Request,
  field: "effort_multiplier" | "additional_effort",
): Promise<number | undefined> {
  const value: unknown = await request.json().catch(() => undefined)
  if (typeof value !== "object" || value === null || !(field in value)) return undefined
  const effort = (value as Record<string, unknown>)[field]
  return typeof effort === "number" && Number.isInteger(effort) && effort >= 1 && effort <= 8
    ? effort
    : undefined
}
