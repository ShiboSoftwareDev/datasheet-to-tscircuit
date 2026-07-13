import type { ApiError, Job } from "@/shared/job-types"

interface JobResponse {
  job: Job
}

async function readApiError(response: Response): Promise<string> {
  const parsed: unknown = await response.json().catch(() => undefined)
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "error" in parsed &&
    typeof parsed.error === "object" &&
    parsed.error !== null &&
    "message" in parsed.error &&
    typeof parsed.error.message === "string"
  ) {
    return parsed.error.message
  }
  return `Request failed with status ${response.status}`
}

export async function createJob(file: File, additional_instructions: string): Promise<Job> {
  const form = new FormData()
  form.set("datasheet", file)
  if (additional_instructions.trim()) form.set("additional_instructions", additional_instructions.trim())

  const response = await fetch("/api/job/create", { method: "POST", body: form })
  if (!response.ok) throw new Error(await readApiError(response))
  const job_response = (await response.json()) as JobResponse
  return job_response.job
}

export async function getJob(job_id: string): Promise<Job> {
  const response = await fetch(`/api/job/get?job_id=${encodeURIComponent(job_id)}`)
  if (!response.ok) throw new Error(await readApiError(response))
  const job_response = (await response.json()) as JobResponse
  return job_response.job
}

export function getJobFileUrl(job_id: string, file: "component" | "log"): string {
  return `/api/job/file?job_id=${encodeURIComponent(job_id)}&file=${file}`
}

export type { ApiError }
