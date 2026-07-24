import type { ApiError, Job, JobSummary, ModelRun, ModelSelectedPreview } from "@/shared/job-types"
import { getInitialUseOpenai } from "./agent-provider-preference"

interface JobResponse {
  job: Job
}

interface JobsResponse {
  jobs: JobSummary[]
}

interface ModelRunResponse {
  model_run: ModelRun
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

export async function createJob(input: {
  file: File
  additional_instructions: string
  use_openai: boolean
  model_options?: { create_pspice_model: boolean; model_effort_multiplier: number }
}): Promise<Job> {
  const { file, additional_instructions, use_openai, model_options } = input
  const form = new FormData()
  form.set("datasheet", file)
  form.set("use_openai", String(use_openai))
  if (additional_instructions.trim()) form.set("additional_instructions", additional_instructions.trim())
  if (model_options?.create_pspice_model) {
    form.set("create_pspice_model", "true")
    form.set("model_effort_multiplier", String(model_options.model_effort_multiplier))
  }

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

export async function getJobs(): Promise<JobSummary[]> {
  const response = await fetch("/api/jobs")
  if (!response.ok) throw new Error(await readApiError(response))
  const jobs_response = (await response.json()) as JobsResponse
  return jobs_response.jobs
}

export async function cancelJob(job_id: string): Promise<Job> {
  const response = await fetch(`/api/job/cancel?job_id=${encodeURIComponent(job_id)}`, { method: "POST" })
  if (!response.ok) throw new Error(await readApiError(response))
  const job_response = (await response.json()) as JobResponse
  return job_response.job
}

export async function retryJob(job_id: string): Promise<Job> {
  const response = await fetch(
    `/api/job/retry?job_id=${encodeURIComponent(job_id)}&use_openai=${getInitialUseOpenai()}`,
    { method: "POST" },
  )
  if (!response.ok) throw new Error(await readApiError(response))
  const job_response = (await response.json()) as JobResponse
  return job_response.job
}

export async function deleteJob(job_id: string): Promise<void> {
  const response = await fetch(`/api/job/delete?job_id=${encodeURIComponent(job_id)}`, {
    method: "DELETE",
  })
  if (!response.ok) throw new Error(await readApiError(response))
}

export type JobFileKind =
  | "component"
  | "typical_application"
  | "log"
  | "component_evidence"
  | "footprint_plan"
  | "application_plan"
  | "land_pattern"
  | "component_schematic_reference"
  | "application_reference"
  | "events"

export function getJobFileUrl(job_id: string, file: JobFileKind, display?: "inline"): string {
  const inline_query = display === "inline" ? "&display=inline" : ""
  return `/api/job/file?job_id=${encodeURIComponent(job_id)}&file=${file}${inline_query}`
}

export async function getModelRun(job_id: string): Promise<ModelRun | undefined> {
  const response = await fetch(`/api/model-run/get?job_id=${encodeURIComponent(job_id)}`)
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(await readApiError(response))
  return ((await response.json()) as ModelRunResponse).model_run
}

export async function createModelRun(job_id: string, effort_multiplier: number): Promise<ModelRun> {
  const response = await fetch(
    `/api/model-run/create?job_id=${encodeURIComponent(job_id)}&use_openai=${getInitialUseOpenai()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ effort_multiplier }),
    },
  )
  if (!response.ok) throw new Error(await readApiError(response))
  return ((await response.json()) as ModelRunResponse).model_run
}

export async function extendModelRun(job_id: string, additional_effort: number): Promise<ModelRun> {
  const response = await fetch(
    `/api/model-run/extend?job_id=${encodeURIComponent(job_id)}&use_openai=${getInitialUseOpenai()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ additional_effort }),
    },
  )
  if (!response.ok) throw new Error(await readApiError(response))
  return ((await response.json()) as ModelRunResponse).model_run
}

export async function cancelModelRun(job_id: string): Promise<ModelRun> {
  const response = await fetch(`/api/model-run/cancel?job_id=${encodeURIComponent(job_id)}`, {
    method: "POST",
  })
  if (!response.ok) throw new Error(await readApiError(response))
  return ((await response.json()) as ModelRunResponse).model_run
}

export async function retryModelRun(job_id: string): Promise<ModelRun> {
  const response = await fetch(
    `/api/model-run/retry?job_id=${encodeURIComponent(job_id)}&use_openai=${getInitialUseOpenai()}`,
    { method: "POST" },
  )
  if (!response.ok) throw new Error(await readApiError(response))
  return ((await response.json()) as ModelRunResponse).model_run
}

export async function getModelSelectedPreview(
  job_id: string,
  benchmark_id: string,
): Promise<ModelSelectedPreview> {
  const response = await fetch(
    `/api/model-run/preview?job_id=${encodeURIComponent(job_id)}&benchmark_id=${encodeURIComponent(benchmark_id)}`,
  )
  if (!response.ok) throw new Error(await readApiError(response))
  return (await response.json()) as ModelSelectedPreview
}

export function getModelReferenceImageUrl(job_id: string, benchmark_id: string): string {
  return `/api/model-run/reference-image?job_id=${encodeURIComponent(job_id)}&benchmark_id=${encodeURIComponent(benchmark_id)}`
}

export type ModelRunFileKind = "model" | "manifest" | "report" | "model_card" | "component" | "log"

export function getModelRunFileUrl(job_id: string, file: ModelRunFileKind): string {
  return `/api/model-run/file?job_id=${encodeURIComponent(job_id)}&file=${file}`
}

export type { ApiError }
