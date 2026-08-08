import { lstat, readFile, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import type { PublicPipelineSnapshot } from "@/shared/job-types"
import type { LocalRunMode } from "@/shared/local-run"
import type { DebugPipelineId, DebugRunMode } from "@/shared/pipeline-debug"
import type { JobRunnerContext } from "./component-workflow/types"
import { JobStore } from "./job-store"
import { restorePersistedJob } from "./job-restorer"
import { listLocalRuns, readLocalRunSummary } from "./local-runs"
import { ModelRunStore } from "./model-run-store"
import type { ModelRunnerContext } from "./model-workflow/types"
import { loadPipelineTaskInputBundle } from "./pipeline"
import { PIPELINE_REGISTRY, type RegisteredPipelineId } from "./pipeline-registry"
import { createPipelineJobRun } from "./pipeline-local-run"

interface LocalRunApiContext extends JobRunnerContext, ModelRunnerContext {
  root_dir: string
  local_runs_root: string
  jobs_root: string
  job_store: JobStore
  model_run_store: ModelRunStore
}

interface StartLocalRunRequest {
  job_id: string
  pipeline_id: DebugPipelineId
  mode: DebugRunMode
  stage_id?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseStartRequest(value: unknown): StartLocalRunRequest | undefined {
  if (!isRecord(value) || typeof value.job_id !== "string" || !value.job_id.trim()) return undefined
  if (
    !(
      value.pipeline_id === "component_generation" ||
      value.pipeline_id === "typical_application" ||
      value.pipeline_id === "spice_generation"
    )
  ) {
    return undefined
  }
  if (!(value.mode === "pipeline" || value.mode === "stage" || value.mode === "from_stage")) {
    return undefined
  }
  if (value.mode !== "pipeline" && (typeof value.stage_id !== "string" || !value.stage_id.trim())) {
    return undefined
  }
  return {
    job_id: value.job_id,
    pipeline_id: value.pipeline_id,
    mode: value.mode,
    ...(typeof value.stage_id === "string" ? { stage_id: value.stage_id } : {}),
  }
}

function errorResponse(status: number, error_code: string, message: string): Response {
  return Response.json({ error: { error_code, message } }, { status })
}

function snapshotForPipeline(input: {
  pipelineId: RegisteredPipelineId
  jobId: string
  jobStore: JobStore
  modelRunStore: ModelRunStore
}): PublicPipelineSnapshot | undefined {
  const job = input.jobStore.getJob(input.jobId)
  if (!job) return undefined
  if (input.pipelineId === "component_generation") {
    return job.pipelines?.component_generation ?? job.pipeline
  }
  if (input.pipelineId === "typical_application") return job.pipelines?.typical_application
  const modelRunId = input.modelRunStore.getModelRunIdForJob(input.jobId)
  return modelRunId ? input.modelRunStore.getModelRun(modelRunId)?.pipeline : undefined
}

async function resolveRetainedInput(input: {
  jobDir: string
  snapshot: PublicPipelineSnapshot
  taskId: string
}): Promise<string> {
  const stage = input.snapshot.stage_results[input.taskId]
  if (!stage) throw new Error(`No retained input exists for ${input.snapshot.pipeline_id}/${input.taskId}`)
  const jobRoot = await realpath(input.jobDir)
  const unresolvedInput = resolve(jobRoot, stage.debug_ref, "input.json")
  const metadata = await lstat(unresolvedInput)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Retained task input is unavailable")
  const inputPath = await realpath(unresolvedInput)
  const pathFromJob = relative(jobRoot, inputPath)
  if (pathFromJob.startsWith("..") || isAbsolute(pathFromJob)) {
    throw new Error("Retained task input escapes its Task workspace")
  }
  return inputPath
}

async function prepareFromTask(request: StartLocalRunRequest, context: LocalRunApiContext) {
  const pipelineId = request.pipeline_id as RegisteredPipelineId
  const definition = PIPELINE_REGISTRY[pipelineId]
  const taskId = request.mode === "pipeline" ? definition.stages[0]?.id : request.stage_id
  if (!taskId || !definition.stages.some(({ id }) => id === taskId)) {
    throw new Error(`Pipeline ${pipelineId} has no task ${taskId}`)
  }
  const jobDir = context.job_store.getJobDir(request.job_id)
  if (!jobDir) throw new Error(`Task ${request.job_id} was not found`)
  const snapshot = snapshotForPipeline({
    pipelineId,
    jobId: request.job_id,
    jobStore: context.job_store,
    modelRunStore: context.model_run_store,
  })
  if (!snapshot) throw new Error(`Task ${request.job_id} has no ${pipelineId} pipeline output`)
  const inputPath = await resolveRetainedInput({ jobDir, snapshot, taskId })
  const bundle = await loadPipelineTaskInputBundle(inputPath)
  if (bundle.envelope.pipeline_id !== pipelineId || bundle.envelope.task_id !== taskId) {
    throw new Error("Retained task input identity does not match the requested Local run")
  }
  const mode: LocalRunMode =
    request.mode === "pipeline" ? "pipeline" : request.mode === "stage" ? "task" : "from_task"
  return createPipelineJobRun({
    context: {
      rootDir: context.root_dir,
      jobsRoot: context.jobs_root,
      localRunsRoot: context.local_runs_root,
      jobStore: context.job_store,
      modelRunStore: context.model_run_store,
    },
    bundle,
    targetJobId: request.job_id,
    sourceJobId: request.job_id,
    executionKind: "in_place",
    mode,
    ...(mode === "pipeline" ? {} : { taskId }),
  })
}

async function prepareFromLocal(localRunId: string, context: LocalRunApiContext) {
  const source = await readLocalRunSummary(context.local_runs_root, localRunId)
  if (source.version !== 2 || !source.target_job_id) {
    throw new Error("This historical isolated run has no regular target job")
  }
  const bundle = await loadPipelineTaskInputBundle(source.input_path)
  return createPipelineJobRun({
    context: {
      rootDir: context.root_dir,
      jobsRoot: context.jobs_root,
      localRunsRoot: context.local_runs_root,
      jobStore: context.job_store,
      modelRunStore: context.model_run_store,
    },
    bundle,
    targetJobId: source.target_job_id,
    sourceJobId: source.source_job_id,
    executionKind: "in_place",
    mode: source.mode,
    ...(source.task_id ? { taskId: source.task_id } : {}),
    parentLocalRunId: source.local_run_id,
  })
}

function launchLocalRun(prepared: Awaited<ReturnType<typeof createPipelineJobRun>>): void {
  void prepared.execute().catch((error) => {
    console.error("[local-run] execution_failed", {
      local_run_id: prepared.summary.local_run_id,
      cause: error instanceof Error ? error.message : String(error),
    })
  })
}

async function synchronizeCompletedCliRun(
  summary: Awaited<ReturnType<typeof readLocalRunSummary>>,
  context: LocalRunApiContext,
): Promise<void> {
  if (summary.version !== 2 || summary.status === "running" || !summary.target_job_id) return
  const diskJobs = new JobStore({
    checkpoint_writer: () => undefined,
    log_writer: async () => undefined,
  })
  const diskModels = new ModelRunStore({
    checkpoint_writer: () => undefined,
    log_writer: async () => undefined,
  })
  const targetJobDir = join(context.jobs_root, summary.target_job_id)
  await restorePersistedJob({
    job_id: summary.target_job_id,
    job_dir: targetJobDir,
    job_store: diskJobs,
    model_run_store: diskModels,
  })
  const job = diskJobs.getJob(summary.target_job_id)
  const jobDir = diskJobs.getJobDir(summary.target_job_id)
  if (!job || !jobDir) throw new Error(`Local run ${summary.local_run_id} target job is unavailable`)
  const retrySource = diskJobs.getJobRetrySource(summary.target_job_id)
  context.job_store.refreshRestoredJob({
    ...job,
    job_dir: jobDir,
    warnings: job.warnings ?? [],
    ...(retrySource?.additional_instructions
      ? { additional_instructions: retrySource.additional_instructions }
      : {}),
  })
  const modelRun = diskModels.getModelRunForJob(summary.target_job_id)
  if (modelRun) {
    const modelDir = diskModels.getModelDir(modelRun.model_run_id)
    if (!modelDir) throw new Error(`Local run ${summary.local_run_id} model workspace is unavailable`)
    context.model_run_store.refreshRestoredModelRun({
      model_dir: modelDir,
      model_run: modelRun,
      logs: modelRun.logs,
    })
  }
}

export function createLocalRunApiHandler(context: LocalRunApiContext) {
  const synchronizedCliRuns = new Set<string>()
  const synchronizingCliRuns = new Map<string, Promise<void>>()
  const serverLaunchedRuns = new Set<string>()
  const synchronize = async (summary: Awaited<ReturnType<typeof readLocalRunSummary>>) => {
    if (serverLaunchedRuns.has(summary.local_run_id)) return
    const key = `${summary.local_run_id}:${summary.status}:${summary.completed_at ?? ""}`
    if (summary.status === "running" || synchronizedCliRuns.has(key)) return
    const existing = synchronizingCliRuns.get(key)
    if (existing) return existing
    const pending = synchronizeCompletedCliRun(summary, context)
      .then(() => {
        synchronizedCliRuns.add(key)
      })
      .finally(() => synchronizingCliRuns.delete(key))
    synchronizingCliRuns.set(key, pending)
    return pending
  }
  return async (request: Request): Promise<Response | undefined> => {
    const requestUrl = new URL(request.url)

    if (requestUrl.pathname === "/api/local-runs" && request.method === "GET") {
      const local_runs = (await listLocalRuns(context.local_runs_root)).filter(
        (summary) => summary.version === 2,
      )
      for (const summary of [...local_runs].reverse()) {
        void synchronize(summary).catch((error) => {
          console.error("[local-run] checkpoint_refresh_failed", {
            local_run_id: summary.local_run_id,
            cause: error instanceof Error ? error.message : String(error),
          })
        })
      }
      return Response.json({ local_runs })
    }
    if (requestUrl.pathname === "/api/local-run/get" && request.method === "GET") {
      const localRunId = requestUrl.searchParams.get("local_run_id")?.trim()
      if (!localRunId) return errorResponse(400, "local_run_id_required", "local_run_id is required.")
      try {
        const summary = await readLocalRunSummary(context.local_runs_root, localRunId)
        if (summary.version === 2 && summary.target_job_id) {
          await synchronize(summary)
          const job = context.job_store.getJob(summary.target_job_id)
          if (!job) throw new Error(`Local run ${localRunId} target job is unavailable`)
          const model_run = context.model_run_store.getModelRunForJob(summary.target_job_id)
          return Response.json({ local_run: summary, job, ...(model_run ? { model_run } : {}) })
        }
        return errorResponse(
          410,
          "historical_local_run",
          "This historical isolated output predates mutable Local jobs.",
        )
      } catch (error) {
        return errorResponse(
          404,
          "local_run_not_found",
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    if (requestUrl.pathname === "/api/local-run/run" && request.method === "POST") {
      const parsed = parseStartRequest(await request.json().catch(() => undefined))
      if (!parsed) return errorResponse(400, "invalid_local_run_request", "Invalid Local run request.")
      try {
        const prepared = await prepareFromTask(parsed, context)
        serverLaunchedRuns.add(prepared.summary.local_run_id)
        launchLocalRun(prepared)
        return Response.json({ local_run: prepared.summary }, { status: 202 })
      } catch (error) {
        return errorResponse(
          409,
          "local_run_unavailable",
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    if (requestUrl.pathname === "/api/local-run/rerun" && request.method === "POST") {
      const value = await request.json().catch(() => undefined)
      const localRunId = isRecord(value) && typeof value.local_run_id === "string" ? value.local_run_id : ""
      if (!localRunId) return errorResponse(400, "local_run_id_required", "local_run_id is required.")
      try {
        const prepared = await prepareFromLocal(localRunId, context)
        serverLaunchedRuns.add(prepared.summary.local_run_id)
        launchLocalRun(prepared)
        return Response.json({ local_run: prepared.summary }, { status: 202 })
      } catch (error) {
        return errorResponse(
          409,
          "local_rerun_unavailable",
          error instanceof Error ? error.message : String(error),
        )
      }
    }

    // A page refresh retains local_run_id in the browser URL. Let the normal
    // application/static-file handler serve non-API requests.
    if (!requestUrl.pathname.startsWith("/api/")) return undefined

    const localRunId = requestUrl.searchParams.get("local_run_id")?.trim()
    if (!localRunId) return undefined
    const summary = await readLocalRunSummary(context.local_runs_root, localRunId).catch(() => undefined)
    // Version 2 Local records target the main stores, so ordinary API handlers
    // serve them exactly like any other job even when an old URL retains this query.
    if (summary?.version === 2) return undefined
    if (summary?.version === 1) {
      return errorResponse(
        410,
        "historical_local_run",
        "This historical isolated output predates mutable Local jobs.",
      )
    }
    return undefined
  }
}
