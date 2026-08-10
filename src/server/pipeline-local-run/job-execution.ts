import { mkdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import type { Job, ModelRun, PublicPipelineSnapshot } from "@/shared/job-types"
import type { LocalRunMode, LocalRunSummary } from "@/shared/local-run"
import type { PipelineJsonValue, PipelineTaskInputEnvelope } from "@/shared/pipeline-types"
import { atomicWriteJsonSync } from "../infrastructure/persistence/atomic-write"
import { restoreJobDirectory } from "../job-restorer/restore-job-directory"
import { restoreModelDirectory } from "../job-restorer/restore-model-directory"
import { JobStore } from "../job-store"
import { LOCAL_RUN_HEARTBEAT_INTERVAL_MS } from "../local-runs"
import { ModelRunStore } from "../model-run-store"
import {
  loadPipelineTaskInputBundle,
  materializePipelineTaskInputFiles,
  type PipelineTaskInputBundle,
  restorePipelineTaskInputFiles,
} from "../pipeline"
import { PIPELINE_REGISTRY, type RegisteredPipelineId } from "../pipeline-registry"
import { executePipeline, type PreparedPipelineLocalRun, validateLocalInput } from "./run"
import { type LocalWorkspace, retainLocalInputBundle, rewriteWorkspacePaths } from "./workspace"

export interface PipelineJobExecutionContext {
  rootDir: string
  jobsRoot: string
  localRunsRoot: string
  jobStore: JobStore
  modelRunStore: ModelRunStore
}

export type LocalRunProgressEvent =
  | { readonly kind: "started" | "heartbeat"; readonly summary: LocalRunSummary }
  | {
      readonly kind: "pipeline"
      readonly summary: LocalRunSummary
      readonly pipeline: PublicPipelineSnapshot
    }

function requiredContextString(context: Readonly<Record<string, PipelineJsonValue>>, key: string): string {
  const value = context[key]
  if (typeof value !== "string" || !value.trim()) throw new Error(`Task context requires ${key}`)
  return value
}

function reboundEnvelope(input: {
  bundle: PipelineTaskInputBundle
  targetJobId: string
  targetJobDir: string
  targetModelRunId?: string
  invocationId: string
}): PipelineTaskInputEnvelope {
  const sourceContext = input.bundle.envelope.execution_context
  const sourceJobDir = requiredContextString(sourceContext, "job_dir")
  const rewrittenContext = rewriteWorkspacePaths({
    value: sourceContext,
    sourceJobDir,
    localJobDir: input.targetJobDir,
  }) as Readonly<Record<string, PipelineJsonValue>>
  const execution_context: Record<string, PipelineJsonValue> = {
    ...rewrittenContext,
    job_id: input.targetJobId,
    job_dir: input.targetJobDir,
    invocation_id: input.invocationId,
  }
  if (input.bundle.envelope.pipeline_id === "spice_generation") {
    if (!input.targetModelRunId) throw new Error("SPICE execution requires a model run")
    execution_context.model_run_id = input.targetModelRunId
    execution_context.model_dir = join(input.targetJobDir, "spice")
  } else {
    delete execution_context.model_run_id
    delete execution_context.model_dir
  }
  return {
    ...input.bundle.envelope,
    execution_context,
    dependency_outputs: rewriteWorkspacePaths({
      value: input.bundle.envelope.dependency_outputs,
      sourceJobDir,
      localJobDir: input.targetJobDir,
    }) as Readonly<Record<string, PipelineJsonValue>>,
  }
}

function cloneJobProjection(source: Job): Parameters<JobStore["updateJob"]>[1] {
  return {
    display_status: source.display_status,
    is_complete: source.is_complete,
    has_errors: source.has_errors,
    error_message: source.error_message,
    warnings: source.warnings,
    completed_at: source.completed_at,
    component_ready: source.component_ready,
    component_code: source.component_code,
    circuit_json: source.circuit_json,
    typical_application_title: source.typical_application_title,
    typical_application_code: source.typical_application_code,
    typical_application_circuit_json: source.typical_application_circuit_json,
    validation: source.validation,
    provenance: source.provenance,
    evidence_available: source.evidence_available,
    pipeline: source.pipeline,
    pipelines: source.pipelines,
  }
}

async function refreshJobFromRestoredWorkspace(input: {
  context: PipelineJobExecutionContext
  jobId: string
  jobDir: string
}): Promise<void> {
  const restoredStore = new JobStore({
    checkpoint_writer: () => undefined,
    log_writer: async () => undefined,
  })
  const restored = await restoreJobDirectory({
    job_id: input.jobId,
    job_dir: input.jobDir,
    job_store: restoredStore,
    active_job_state: "preserve",
  })
  if (!restored) throw new Error(`Retained input for job ${input.jobId} has no restorable job checkpoint`)
  const retrySource = restoredStore.getJobRetrySource(input.jobId)
  input.context.jobStore.refreshRestoredJob({
    ...restored,
    job_dir: input.jobDir,
    warnings: restored.warnings ?? [],
    ...(retrySource?.additional_instructions
      ? { additional_instructions: retrySource.additional_instructions }
      : {}),
  })
}

function clonedModelRun(source: ModelRun, input: { jobId: string; modelRunId: string }): ModelRun {
  const now = new Date().toISOString()
  return {
    ...source,
    model_run_id: input.modelRunId,
    job_id: input.jobId,
    created_at: now,
    updated_at: now,
    completed_at: now,
    status: "complete",
    is_complete: true,
    has_errors: false,
    error_message: undefined,
    warnings: (source.warnings ?? []).filter((warning) => !warning.startsWith("Accepted model ")),
    elapsed_time_ms: 0,
    segment_started_at: undefined,
    current_invocation_id: undefined,
    logs: [],
    // Accepted publications are identity-bound to their original job. A clone
    // retains development artifacts but starts without an accepted publication.
    model_source: undefined,
    manifest: undefined,
    model_card: undefined,
    validation: source.validation?.artifact_state === "candidate" ? source.validation : undefined,
  }
}

/** Creates a regular, independently identified job from a retained task boundary. */
export async function clonePipelineJob(input: {
  context: PipelineJobExecutionContext
  sourceJobId: string
  bundle: PipelineTaskInputBundle
}): Promise<{ jobId: string; bundle: PipelineTaskInputBundle }> {
  const liveSourceJob = input.context.jobStore.getJob(input.sourceJobId)
  if (liveSourceJob && input.context.jobStore.isJobDeleting(input.sourceJobId)) {
    throw new Error(`Job ${input.sourceJobId} is being deleted`)
  }
  const jobId = crypto.randomUUID()
  const stagingDir = join(input.context.jobsRoot, `.creating-${jobId}`)
  const jobDir = join(input.context.jobsRoot, jobId)
  let sourceJob: Job | undefined
  let sourceModel: ModelRun | undefined
  try {
    await mkdir(stagingDir)
    await materializePipelineTaskInputFiles({ bundle: input.bundle, destination_root: stagingDir })
    // Immutable accepted bundles cannot be copied across job identities. They
    // are outputs, never inputs to an earlier debugging task. Remove them
    // before restoring the retained projection so a stale or identity-bound
    // publication cannot hide the retained development candidate.
    await Promise.all([
      rm(join(stagingDir, "published-model.json"), { force: true }),
      rm(join(stagingDir, "published-models"), { recursive: true, force: true }),
      rm(join(stagingDir, "spice", "accepted-revisions"), { recursive: true, force: true }),
    ])
    const retainedJobStore = new JobStore({
      checkpoint_writer: () => undefined,
      log_writer: async () => undefined,
    })
    const retainedModelRunStore = new ModelRunStore({
      checkpoint_writer: () => undefined,
      log_writer: async () => undefined,
    })
    // A clone represents the retained pre-task boundary. The live source job
    // may have advanced through later in-place executions, so copying its
    // current in-memory projection would cross-wire newer model metadata with
    // the retained preview files materialized above.
    sourceJob = await restoreJobDirectory({
      job_id: input.sourceJobId,
      job_dir: stagingDir,
      job_store: retainedJobStore,
    })
    sourceModel = await restoreModelDirectory({
      job_id: input.sourceJobId,
      model_dir: join(stagingDir, "spice"),
      model_run_store: retainedModelRunStore,
    })
    if (!sourceJob) {
      throw new Error(`Retained input for job ${input.sourceJobId} has no restorable job checkpoint`)
    }
    await rename(stagingDir, jobDir)
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
    await rm(jobDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }

  try {
    input.context.jobStore.createJob({
      job_id: jobId,
      job_dir: jobDir,
      file_name: sourceJob.file_name,
      use_openai: sourceJob.use_openai,
    })
    input.context.jobStore.updateJob(jobId, cloneJobProjection(sourceJob))

    let modelRunId: string | undefined
    if (input.bundle.envelope.pipeline_id === "spice_generation") {
      modelRunId = crypto.randomUUID()
      if (sourceModel) {
        input.context.modelRunStore.restoreModelRun({
          model_dir: join(jobDir, "spice"),
          model_run: clonedModelRun(sourceModel, { jobId, modelRunId }),
          logs: [],
        })
      } else {
        input.context.modelRunStore.createModelRun({
          model_run_id: modelRunId,
          job_id: jobId,
          model_dir: join(jobDir, "spice"),
          use_openai: sourceJob.use_openai,
          effort_multiplier: 1,
        })
      }
    }
    const invocationId = crypto.randomUUID()
    const envelope = reboundEnvelope({
      bundle: input.bundle,
      targetJobId: jobId,
      targetJobDir: jobDir,
      targetModelRunId: modelRunId,
      invocationId,
    })
    return { jobId, bundle: { ...input.bundle, envelope } }
  } catch (error) {
    input.context.modelRunStore.deleteModelRunForJob(jobId)
    if (input.context.jobStore.getJob(jobId)) {
      input.context.jobStore.updateJob(jobId, { is_complete: true })
      input.context.jobStore.deleteJob(jobId)
    }
    await rm(jobDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

function terminalJobStatus(status: LocalRunSummary["status"]) {
  if (status === "completed") return "complete" as const
  if (status === "cancelled") return "cancelled" as const
  return "failed" as const
}

export function normalizePartialPipeline(input: {
  snapshot: PublicPipelineSnapshot | undefined
  baselineSnapshot?: PublicPipelineSnapshot
  mode: LocalRunMode
  taskId?: string
  status: LocalRunSummary["status"]
}): PublicPipelineSnapshot | undefined {
  if (!input.snapshot) return undefined
  if (input.mode === "pipeline" || !input.taskId) return { ...input.snapshot, status: input.status }
  const definition = PIPELINE_REGISTRY[input.snapshot.pipeline_id as RegisteredPipelineId]
  const targetIndex = definition?.stages.findIndex(({ id }) => id === input.taskId) ?? -1
  if (targetIndex < 0) return { ...input.snapshot, status: input.status }
  const stage_results = Object.fromEntries(
    definition.stages.flatMap(({ id }, index) => {
      const stage = input.snapshot?.stage_results[id]
      if (!stage) return []
      if (index < targetIndex) {
        const inherited = input.baselineSnapshot?.stage_results[id] ?? stage
        return [[id, { ...inherited, stage_id: id, status: "completed" as const }]]
      }
      if (input.mode === "task" && index > targetIndex && stage.status === "skipped") {
        return [[id, { stage_id: id, status: "pending" as const, debug_ref: stage.debug_ref }]]
      }
      return [[id, stage]]
    }),
  )
  return { ...input.snapshot, status: input.status, stage_results }
}

/** Runs a task or pipeline against a normal job and records local provenance. */
export async function createPipelineJobRun(input: {
  context: PipelineJobExecutionContext
  bundle: PipelineTaskInputBundle
  targetJobId: string
  sourceJobId: string
  executionKind: "in_place" | "clone"
  mode: LocalRunMode
  taskId?: string
  parentLocalRunId?: string
  signal?: AbortSignal
  on_progress?: (event: LocalRunProgressEvent) => void
}): Promise<PreparedPipelineLocalRun> {
  validateLocalInput(input)
  const targetJob = input.context.jobStore.getJob(input.targetJobId)
  const targetJobDir = input.context.jobStore.getJobDir(input.targetJobId)
  if (!targetJob || !targetJobDir) throw new Error(`Job ${input.targetJobId} was not found`)
  if (input.context.jobStore.isJobDeleting(input.targetJobId)) {
    throw new Error(`Job ${input.targetJobId} is being deleted`)
  }

  const targetModelRunId = input.context.modelRunStore.getModelRunIdForJob(input.targetJobId)
  const baselinePipeline =
    input.executionKind !== "in_place"
      ? undefined
      : input.bundle.envelope.pipeline_id === "spice_generation"
        ? targetModelRunId
          ? input.context.modelRunStore.getModelRun(targetModelRunId)?.pipeline
          : undefined
        : input.bundle.envelope.pipeline_id === "component_generation"
          ? (targetJob.pipelines?.component_generation ?? targetJob.pipeline)
          : targetJob.pipelines?.typical_application
  const invocationId = crypto.randomUUID()
  const envelope = reboundEnvelope({
    bundle: input.bundle,
    targetJobId: input.targetJobId,
    targetJobDir,
    targetModelRunId,
    invocationId,
  })
  const reboundBundle: PipelineTaskInputBundle = { ...input.bundle, envelope }
  const localRunId = `local-${crypto.randomUUID()}`
  const executionDir = join(input.context.localRunsRoot, localRunId)
  await mkdir(input.context.localRunsRoot, { recursive: true })
  await mkdir(executionDir)
  let inputPath: string
  let retainedBundle: PipelineTaskInputBundle
  try {
    inputPath = await retainLocalInputBundle({
      bundle: reboundBundle,
      executionDir,
      envelope,
    })
    retainedBundle = await loadPipelineTaskInputBundle(inputPath)
  } catch (error) {
    await rm(executionDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }

  const runDir =
    envelope.pipeline_id === "spice_generation"
      ? join(targetJobDir, "spice", "runs", invocationId)
      : join(targetJobDir, "runs", envelope.pipeline_id, invocationId)
  await mkdir(runDir, { recursive: true })
  const claimedModelRunId =
    envelope.pipeline_id === "spice_generation"
      ? requiredContextString(envelope.execution_context, "model_run_id")
      : undefined
  const claimed = claimedModelRunId
    ? input.context.modelRunStore.claimModelExecution(claimedModelRunId)
    : input.context.jobStore.claimPipelineExecution(input.targetJobId, envelope.pipeline_id)
  if (!claimed) {
    await rm(executionDir, { recursive: true, force: true }).catch(() => undefined)
    throw new Error(`${envelope.pipeline_id} for job ${input.targetJobId} is already running`)
  }
  try {
    if (input.executionKind === "in_place") {
      await restorePipelineTaskInputFiles({
        bundle: retainedBundle,
        destination_root: targetJobDir,
        excluded_roots: envelope.pipeline_id === "spice_generation" ? [] : ["spice"],
        // A retained task boundary supplies the task's explicit dependency
        // paths, but it must never roll back the selected job's accumulated
        // SPICE candidates, reference graphs, simulations, or live preview.
        preserved_roots: envelope.pipeline_id === "spice_generation" ? ["spice"] : [],
        // The selected job is the execution container, not a task artifact.
        // Rewinding its live checkpoint can erase progress written by another
        // pipeline or by the server process coordinating this Local run.
        preserved_paths: ["job.json"],
      })
      await refreshJobFromRestoredWorkspace({
        context: input.context,
        jobId: input.targetJobId,
        jobDir: targetJobDir,
      })
    }
  } catch (error) {
    if (claimedModelRunId) input.context.modelRunStore.releaseModelExecution(claimedModelRunId)
    else input.context.jobStore.releasePipelineExecution(input.targetJobId, envelope.pipeline_id)
    await rm(executionDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  const pipelineDir = join(runDir, ".pipeline")
  const summaryPath = join(executionDir, "summary.json")
  const local: LocalWorkspace = {
    localRunId,
    executionDir,
    jobsRoot: input.context.jobsRoot,
    jobDir: targetJobDir,
    inputPath,
    context: envelope.execution_context,
    dependencyOutputs: envelope.dependency_outputs,
  }
  const createdAt = new Date().toISOString()
  const initialSummary: LocalRunSummary = {
    version: 2,
    local_run_id: localRunId,
    execution_kind: input.executionKind,
    mode: input.mode,
    pipeline_id: envelope.pipeline_id,
    ...(input.taskId ? { task_id: input.taskId } : {}),
    source_run_id: envelope.run_id,
    source_job_id: input.sourceJobId,
    target_job_id: input.targetJobId,
    ...(input.parentLocalRunId ? { parent_local_run_id: input.parentLocalRunId } : {}),
    file_name: targetJob.file_name,
    status: "running",
    created_at: createdAt,
    heartbeat_at: createdAt,
    execution_dir: executionDir,
    workspace_dir: targetJobDir,
    input_path: inputPath,
    pipeline_dir: pipelineDir,
    events_path: join(pipelineDir, "events.ndjson"),
    summary_path: summaryPath,
    stage_results: {},
  }
  try {
    atomicWriteJsonSync(summaryPath, initialSummary)
  } catch (error) {
    if (claimedModelRunId) input.context.modelRunStore.releaseModelExecution(claimedModelRunId)
    else input.context.jobStore.releasePipelineExecution(input.targetJobId, envelope.pipeline_id)
    await rm(executionDir, { recursive: true, force: true }).catch(() => undefined)
    await rm(runDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }

  let execution: Promise<LocalRunSummary> | undefined
  const execute = () => {
    if (execution) return execution
    const modelRunId =
      envelope.pipeline_id === "spice_generation"
        ? requiredContextString(envelope.execution_context, "model_run_id")
        : undefined
    let heartbeatSummary = initialSummary
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined
    const reportProgress = (event: LocalRunProgressEvent) => {
      try {
        input.on_progress?.(event)
      } catch (error) {
        console.error("[local-run] progress_observer_failed", {
          local_run_id: localRunId,
          cause: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const refreshHeartbeat = () => {
      heartbeatSummary = { ...heartbeatSummary, heartbeat_at: new Date().toISOString() }
      try {
        atomicWriteJsonSync(summaryPath, heartbeatSummary)
        reportProgress({ kind: "heartbeat", summary: heartbeatSummary })
      } catch (error) {
        console.error("[local-run] heartbeat_write_failed", {
          local_run_id: localRunId,
          cause: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const stopHeartbeat = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
    reportProgress({ kind: "started", summary: heartbeatSummary })
    refreshHeartbeat()
    heartbeatTimer = setInterval(refreshHeartbeat, LOCAL_RUN_HEARTBEAT_INTERVAL_MS)
    try {
      if (modelRunId) {
        input.context.modelRunStore.startSegment(modelRunId)
        input.context.modelRunStore.updateModelRun(modelRunId, { current_invocation_id: invocationId })
      } else {
        input.context.jobStore.updateJob(input.targetJobId, {
          display_status: "agent_running",
          is_complete: false,
          has_errors: false,
          error_message: undefined,
          completed_at: undefined,
        })
      }
    } catch (error) {
      stopHeartbeat()
      if (modelRunId) input.context.modelRunStore.releaseModelExecution(modelRunId)
      else input.context.jobStore.releasePipelineExecution(input.targetJobId, envelope.pipeline_id)
      atomicWriteJsonSync(summaryPath, {
        ...initialSummary,
        status: "failed",
        completed_at: new Date().toISOString(),
        error_message: error instanceof Error ? error.message : String(error),
      } satisfies LocalRunSummary)
      execution = Promise.reject(error)
      return execution
    }
    const storeSignal = modelRunId
      ? input.context.modelRunStore.getCancellationSignal(modelRunId)
      : input.context.jobStore.getCancellationSignal(input.targetJobId)
    const executionSignal =
      storeSignal && input.signal
        ? AbortSignal.any([storeSignal, input.signal])
        : (input.signal ?? storeSignal)
    execution = executePipeline({
      rootDir: input.context.rootDir,
      local,
      jobStore: input.context.jobStore,
      modelRunStore: input.context.modelRunStore,
      pipelineId: envelope.pipeline_id,
      mode: input.mode,
      taskId: input.taskId,
      runDir,
      signal: executionSignal,
      refresh_job: () =>
        refreshJobFromRestoredWorkspace({
          context: input.context,
          jobId: input.targetJobId,
          jobDir: targetJobDir,
        }),
      normalize_snapshot: (pipeline) =>
        normalizePartialPipeline({
          snapshot: pipeline,
          baselineSnapshot: baselinePipeline,
          mode: input.mode,
          taskId: input.taskId,
          status: "running",
        }) ?? pipeline,
      on_snapshot: (pipeline) => {
        reportProgress({ kind: "pipeline", summary: heartbeatSummary, pipeline })
      },
    })
      .then((result) => {
        stopHeartbeat()
        const failedStage = Object.values(result.stage_results).find(({ status }) => status === "failed")
        const resultError = failedStage?.status === "failed" ? failedStage.error.message : undefined
        const summary: LocalRunSummary = {
          ...initialSummary,
          status: result.status,
          completed_at: new Date().toISOString(),
          pipeline_dir: result.pipeline_dir,
          events_path: result.events_path,
          stage_results: result.stage_results,
          ...(resultError ? { error_message: resultError } : {}),
          ...(input.taskId ? { selected_task_result: result.stage_results[input.taskId] } : {}),
        }
        const currentPipeline = modelRunId
          ? input.context.modelRunStore.getModelRun(modelRunId)?.pipeline
          : envelope.pipeline_id === "component_generation"
            ? input.context.jobStore.getJob(input.targetJobId)?.pipelines?.component_generation
            : input.context.jobStore.getJob(input.targetJobId)?.pipelines?.typical_application
        const publicPipeline = normalizePartialPipeline({
          snapshot: currentPipeline,
          baselineSnapshot: baselinePipeline,
          mode: input.mode,
          taskId: input.taskId,
          status: summary.status,
        })
        if (modelRunId) {
          input.context.modelRunStore.finishSegment(modelRunId, {
            status: terminalJobStatus(summary.status),
            is_complete: true,
            has_errors: summary.status === "failed",
            error_message: summary.error_message,
            completed_at: summary.completed_at,
            ...(publicPipeline ? { pipeline: publicPipeline } : {}),
          })
        } else {
          const job = input.context.jobStore.getJob(input.targetJobId)
          const pipelines = job?.pipelines ?? {}
          input.context.jobStore.updateJob(input.targetJobId, {
            display_status: terminalJobStatus(summary.status),
            is_complete: true,
            has_errors: summary.status === "failed",
            error_message: summary.error_message,
            completed_at: summary.completed_at,
            ...(publicPipeline && envelope.pipeline_id === "component_generation"
              ? {
                  pipeline: publicPipeline,
                  pipelines: { ...pipelines, component_generation: publicPipeline },
                }
              : publicPipeline && envelope.pipeline_id === "typical_application"
                ? { pipelines: { ...pipelines, typical_application: publicPipeline } }
                : {}),
          })
        }
        atomicWriteJsonSync(summaryPath, summary)
        return summary
      })
      .catch((error) => {
        stopHeartbeat()
        const summary: LocalRunSummary = {
          ...initialSummary,
          status: "failed",
          completed_at: new Date().toISOString(),
          error_message: error instanceof Error ? error.message : String(error),
        }
        atomicWriteJsonSync(summaryPath, summary)
        if (modelRunId) {
          const current = input.context.modelRunStore.getModelRun(modelRunId)
          if (current && !current.is_complete) {
            input.context.modelRunStore.finishSegment(modelRunId, {
              status: "failed",
              is_complete: true,
              has_errors: true,
              error_message: summary.error_message,
              completed_at: summary.completed_at,
            })
          }
        } else {
          input.context.jobStore.updateJob(input.targetJobId, {
            display_status: "failed",
            is_complete: true,
            has_errors: true,
            error_message: summary.error_message,
            completed_at: summary.completed_at,
          })
        }
        throw error
      })
      .finally(() => {
        stopHeartbeat()
        if (modelRunId) input.context.modelRunStore.releaseModelExecution(modelRunId)
        else input.context.jobStore.releasePipelineExecution(input.targetJobId, envelope.pipeline_id)
      })
    return execution
  }
  return { summary: initialSummary, execute }
}
