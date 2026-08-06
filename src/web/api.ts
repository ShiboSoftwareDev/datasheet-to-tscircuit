import type {
  ApiError,
  Job,
  JobSummary,
  ModelPreviewArtifactIdentity,
  ModelRun,
  ModelSelectedPreview,
} from "@/shared/job-types"
import { parseModelSelectedPreview } from "@/shared/model-selected-preview"
import type { DebugPipelineId, DebugRunMode } from "@/shared/pipeline-debug"
import type { LocalRunDetail, LocalRunSummary } from "@/shared/local-run"
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

interface LocalRunsResponse {
  local_runs: LocalRunSummary[]
}

interface LocalRunResponse {
  local_run: LocalRunSummary
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

export async function runPipelineDebug(input: {
  job_id: string
  pipeline_id: DebugPipelineId
  mode: DebugRunMode
  stage_id?: string
}): Promise<LocalRunSummary> {
  const response = await fetch("/api/local-run/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  if (!response.ok) throw new Error(await readApiError(response))
  return ((await response.json()) as LocalRunResponse).local_run
}

export async function getLocalRuns(): Promise<LocalRunSummary[]> {
  const response = await fetch("/api/local-runs", { cache: "no-store" })
  if (!response.ok) throw new Error(await readApiError(response))
  return ((await response.json()) as LocalRunsResponse).local_runs
}

export async function getLocalRun(local_run_id: string): Promise<LocalRunDetail> {
  const response = await fetch(`/api/local-run/get?local_run_id=${encodeURIComponent(local_run_id)}`, {
    cache: "no-store",
  })
  if (!response.ok) throw new Error(await readApiError(response))
  return (await response.json()) as LocalRunDetail
}

export async function rerunLocal(local_run_id: string): Promise<LocalRunSummary> {
  const response = await fetch("/api/local-run/rerun", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ local_run_id }),
  })
  if (!response.ok) throw new Error(await readApiError(response))
  return ((await response.json()) as LocalRunResponse).local_run
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

export function getJobFileUrl(
  job_id: string,
  file: JobFileKind,
  display?: "inline",
  local_run_id?: string,
): string {
  const inline_query = display === "inline" ? "&display=inline" : ""
  const local_query = local_run_id ? `&local_run_id=${encodeURIComponent(local_run_id)}` : ""
  return `/api/job/file?job_id=${encodeURIComponent(job_id)}&file=${file}${inline_query}${local_query}`
}

export async function getModelRun(job_id: string, local_run_id?: string): Promise<ModelRun | undefined> {
  const local_query = local_run_id ? `&local_run_id=${encodeURIComponent(local_run_id)}` : ""
  const response = await fetch(`/api/model-run/get?job_id=${encodeURIComponent(job_id)}${local_query}`)
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
  local_run_id?: string,
): Promise<ModelSelectedPreview> {
  const local_query = local_run_id ? `&local_run_id=${encodeURIComponent(local_run_id)}` : ""
  const response = await fetch(
    `/api/model-run/preview?job_id=${encodeURIComponent(job_id)}&benchmark_id=${encodeURIComponent(benchmark_id)}${local_query}`,
    { cache: "no-store" },
  )
  if (!response.ok) throw new Error(await readApiError(response))
  return parseModelSelectedPreview(await response.json())
}

export function getModelReferenceImageUrl(
  job_id: string,
  benchmark_id: string,
  artifact_identity?: ModelPreviewArtifactIdentity,
  local_run_id?: string,
): string {
  const local_query = local_run_id ? `&local_run_id=${encodeURIComponent(local_run_id)}` : ""
  const base = `/api/model-run/reference-image?job_id=${encodeURIComponent(job_id)}&benchmark_id=${encodeURIComponent(benchmark_id)}${local_query}`
  if (!artifact_identity) return base
  return `${base}&preview_generation=${encodeURIComponent(artifact_identity.preview_generation)}&model_revision=${encodeURIComponent(artifact_identity.model_revision)}`
}

export function getModelFoundReferenceImageUrl(
  job_id: string,
  reference_id: string,
  local_run_id?: string,
): string {
  const local_query = local_run_id ? `&local_run_id=${encodeURIComponent(local_run_id)}` : ""
  return `/api/model-run/found-reference-image?job_id=${encodeURIComponent(job_id)}&reference_id=${encodeURIComponent(reference_id)}${local_query}`
}

export type ModelRunFileKind =
  | "model"
  | "manifest"
  | "report"
  | "contract"
  | "plan"
  | "model_card"
  | "component"
  | "log"

export function getModelRunFileUrl(job_id: string, file: ModelRunFileKind, local_run_id?: string): string {
  const local_query = local_run_id ? `&local_run_id=${encodeURIComponent(local_run_id)}` : ""
  return `/api/model-run/file?job_id=${encodeURIComponent(job_id)}&file=${file}${local_query}`
}

export type { ApiError }
