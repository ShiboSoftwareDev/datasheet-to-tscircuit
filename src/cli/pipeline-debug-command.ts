import { lstat, mkdir, realpath, rm } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import type { PublicPipelineSnapshot } from "@/shared/job-types"
import type { LocalRunMode } from "@/shared/local-run"
import { atomicWriteJsonSync } from "../server/infrastructure/persistence/atomic-write"
import { restorePersistedJob, restorePersistedJobs } from "../server/job-restorer"
import { JobStore } from "../server/job-store"
import { reconcileInterruptedLocalRuns } from "../server/local-runs"
import { ModelRunStore } from "../server/model-run-store"
import { loadPipelineTaskInputBundle } from "../server/pipeline"
import {
  clonePipelineJob,
  createPipelineJobRun,
  deriveApplicationInputBundle,
  deriveSpiceInputBundle,
  type LocalRunProgressEvent,
  validateLocalInput,
} from "../server/pipeline-local-run"
import {
  PIPELINE_REGISTRY,
  PIPELINE_TASK_CATALOG,
  type RegisteredPipelineId,
} from "../server/pipeline-registry"

const HELP = `datasheet pipeline debugger

Commands:
  debug catalog
  debug job list [--root <repo>]
  debug local list [--root <repo>]
  debug local run <job-id> --pipeline <id> [--task <id> | --from <id>] [--repair-minutes <n>]
  debug local run --job <source-job-id> --pipeline <id> [--task <id> | --from <id>] [--repair-minutes <n>]
  debug task inspect --input <input.json>
  debug task run --input <input.json>
  debug pipeline run --input <input.json>

Every command writes machine-readable JSON. Local run stdout is a compact result;
the complete result is retained at summary_path. A positional job is the in-place target.
--job is a source reference and creates a new regular job before execution.
`

export interface DebugCliOptions {
  signal?: AbortSignal
  on_progress?: (event: LocalRunProgressEvent) => void
}

function option({ args, name }: { args: readonly string[]; name: string }): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  return value
}

function requiredOption({ args, name }: { args: readonly string[]; name: string }): string {
  const value = option({ args, name })
  if (!value) throw new Error(`Missing required option ${name}`)
  return value
}

function assertArguments(input: {
  args: readonly string[]
  positional_count: number
  allowed_options: readonly string[]
}): void {
  const allowed = new Set(input.allowed_options)
  const seen = new Set<string>()
  for (let index = input.positional_count; index < input.args.length; index += 2) {
    const name = input.args[index]
    if (!name?.startsWith("--") || !allowed.has(name)) {
      throw new Error(`Unknown option ${name ?? ""}`.trim())
    }
    if (seen.has(name)) throw new Error(`Option ${name} may be specified only once`)
    seen.add(name)
    const value = input.args[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function resolveInputPath({ jobDir, debugRef }: { jobDir: string; debugRef: string }): Promise<string> {
  const jobRoot = await realpath(jobDir)
  const unresolvedInputPath = resolve(jobRoot, debugRef, "input.json")
  const inputMetadata = await lstat(unresolvedInputPath)
  if (inputMetadata.isSymbolicLink() || !inputMetadata.isFile()) {
    throw new Error("Retained task input must be a regular file")
  }
  const inputPath = await realpath(unresolvedInputPath)
  const pathFromJob = relative(jobRoot, inputPath)
  if (pathFromJob.startsWith("..") || isAbsolute(pathFromJob)) {
    throw new Error("Retained task input escapes the job workspace")
  }
  return inputPath
}

async function restoredState(rootDir: string, selectedJobId?: string) {
  const jobsRoot = join(rootDir, ".runtime", "jobs")
  await mkdir(jobsRoot, { recursive: true })
  let restorationComplete = false
  const checkpointWriter = (path: string, value: unknown) => {
    if (restorationComplete) atomicWriteJsonSync(path, value)
  }
  const jobStore = new JobStore({ checkpoint_writer: checkpointWriter })
  const modelRunStore = new ModelRunStore({ checkpoint_writer: checkpointWriter })
  const restored = selectedJobId
    ? await (async () => {
        const jobDir = join(jobsRoot, selectedJobId)
        const metadata = await lstat(jobDir).catch((error) => {
          if (isRecord(error) && error.code === "ENOENT") return undefined
          throw error
        })
        // Portable retained-input commands can clone a source job that no
        // longer exists locally. In-place/--job commands reject it below.
        if (!metadata) return { jobs_restored: 0, model_runs_restored: 0 }
        const { job, model_run } = await restorePersistedJob({
          job_id: selectedJobId,
          job_dir: jobDir,
          job_store: jobStore,
          model_run_store: modelRunStore,
        })
        return {
          jobs_restored: job ? 1 : 0,
          model_runs_restored: model_run ? 1 : 0,
        }
      })()
    : await restorePersistedJobs({
        jobs_root: jobsRoot,
        job_store: jobStore,
        model_run_store: modelRunStore,
      })
  restorationComplete = true
  return { jobsRoot, jobStore, modelRunStore, restored }
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

async function inspectInput(path: string) {
  const bundle = await loadPipelineTaskInputBundle(path)
  return {
    input_path: bundle.input_path,
    envelope: bundle.envelope,
    retained_files: {
      count: bundle.manifest.files.length,
      total_bytes: bundle.manifest.files.reduce((sum, file) => sum + file.size_bytes, 0),
      manifest_path: join(bundle.input_dir, "input-files.json"),
      objects_path: bundle.objects_dir,
    },
  }
}

async function runLocalJob({
  args,
  rootDir,
  options,
}: {
  args: readonly string[]
  rootDir: string
  options: DebugCliOptions
}) {
  const targetJobId = args[2] && !args[2].startsWith("--") ? args[2] : undefined
  const referencedJobId = option({ args, name: "--job" })
  if (targetJobId && referencedJobId) {
    throw new Error("Select a positional job for in-place execution or use --job to clone, not both")
  }
  const sourceJobId = targetJobId ?? referencedJobId
  if (!sourceJobId) {
    throw new Error("local run requires a target job or a source reference through --job")
  }
  const pipelineId = requiredOption({ args, name: "--pipeline" })
  if (!(pipelineId in PIPELINE_REGISTRY)) throw new Error(`Unknown pipeline ${pipelineId}`)
  const registeredPipelineId = pipelineId as RegisteredPipelineId
  const repairMinutesValue = option({ args, name: "--repair-minutes" })
  const repairMinutes = repairMinutesValue === undefined ? undefined : Number(repairMinutesValue)
  if (repairMinutes !== undefined && (!Number.isFinite(repairMinutes) || repairMinutes <= 0)) {
    throw new Error("--repair-minutes must be a positive number")
  }
  if (repairMinutes !== undefined && registeredPipelineId !== "spice_generation") {
    throw new Error("--repair-minutes is available only for the spice_generation pipeline")
  }
  const taskOption = option({ args, name: "--task" })
  const fromOption = option({ args, name: "--from" })
  if (taskOption && fromOption) throw new Error("Use either --task or --from, not both")
  const definition = PIPELINE_REGISTRY[registeredPipelineId]
  const mode: LocalRunMode = taskOption ? "task" : fromOption ? "from_task" : "pipeline"
  const taskId = taskOption ?? fromOption ?? definition.stages[0]?.id
  if (!taskId || !definition.stages.some(({ id }) => id === taskId)) {
    throw new Error(`Pipeline ${pipelineId} has no task ${taskId}`)
  }

  // A selected debug run is isolated from every unrelated persisted job.
  // Full-store restoration belongs to list/server startup paths; requiring it
  // here can make one local task hang or fail on another job's publication.
  const state = await restoredState(rootDir, sourceJobId)
  const jobDir = state.jobStore.getJobDir(sourceJobId)
  if (!jobDir) throw new Error(`Job ${sourceJobId} was not found`)
  const snapshot = snapshotForPipeline({
    pipelineId: registeredPipelineId,
    jobId: sourceJobId,
    jobStore: state.jobStore,
    modelRunStore: state.modelRunStore,
  })
  const selectedTask = snapshot?.stage_results[taskId]
  // A pipeline snapshot advertises every stage before execution. Pending
  // stages have a debug_ref for UI projection but no captured input boundary
  // yet, so an initial full run must derive its input from the current job.
  const retainedTask = selectedTask?.status === "pending" ? undefined : selectedTask
  const sourceJob = state.jobStore.getJob(sourceJobId)
  if (!sourceJob) throw new Error(`Job ${sourceJobId} was not found`)
  const derivedModelRunId =
    !retainedTask &&
    mode === "pipeline" &&
    registeredPipelineId === "spice_generation" &&
    taskId === "find_reference_graphs"
      ? crypto.randomUUID()
      : undefined
  const derivedInput =
    !retainedTask &&
    mode === "pipeline" &&
    registeredPipelineId === "typical_application" &&
    taskId === "extract_application_evidence"
      ? await deriveApplicationInputBundle({
          sourceJobId,
          sourceJobDir: jobDir,
          localRunsRoot: join(rootDir, ".runtime", "local"),
          useOpenai: sourceJob.use_openai ?? false,
          additionalInstructions: state.jobStore.getJobRetrySource(sourceJobId)?.additional_instructions,
        })
      : derivedModelRunId
        ? await deriveSpiceInputBundle({
            sourceJobId,
            sourceJobDir: jobDir,
            localRunsRoot: join(rootDir, ".runtime", "local"),
            modelRunId: derivedModelRunId,
            useOpenai: sourceJob.use_openai ?? false,
            additionalInstructions: state.jobStore.getJobRetrySource(sourceJobId)?.additional_instructions,
          })
        : undefined
  if (!retainedTask && !derivedInput) {
    throw new Error(`Job ${sourceJobId} has no retained input for ${pipelineId}/${taskId}`)
  }
  const executionContext = {
    rootDir,
    jobsRoot: state.jobsRoot,
    localRunsRoot: join(rootDir, ".runtime", "local"),
    jobStore: state.jobStore,
    modelRunStore: state.modelRunStore,
  }
  let createdModelRun = false
  let executionStarted = false
  try {
    let bundle
    if (retainedTask) {
      const inputPath = await resolveInputPath({ jobDir, debugRef: retainedTask.debug_ref })
      bundle = await loadPipelineTaskInputBundle(inputPath)
    } else {
      if (!derivedInput) throw new Error("Application input derivation did not produce a bundle")
      bundle = derivedInput.bundle
    }
    if (bundle.envelope.pipeline_id !== registeredPipelineId || bundle.envelope.task_id !== taskId) {
      throw new Error("Retained task input identity does not match the requested task")
    }
    let executionTargetJobId = sourceJobId
    let executionKind: "in_place" | "clone" = "in_place"
    if (referencedJobId) {
      const clone = await clonePipelineJob({
        context: executionContext,
        sourceJobId,
        bundle,
      })
      executionTargetJobId = clone.jobId
      bundle = clone.bundle
      executionKind = "clone"
    } else if (derivedModelRunId) {
      state.modelRunStore.createModelRun({
        model_run_id: derivedModelRunId,
        job_id: sourceJobId,
        model_dir: join(jobDir, "spice"),
        use_openai: sourceJob.use_openai,
        effort_multiplier: 1,
      })
      createdModelRun = true
    }
    if (repairMinutes !== undefined) {
      bundle = {
        ...bundle,
        envelope: {
          ...bundle.envelope,
          execution_context: {
            ...bundle.envelope.execution_context,
            repair_budget_ms: Math.round(repairMinutes * 60_000),
          },
        },
      }
    }
    const prepared = await createPipelineJobRun({
      context: executionContext,
      bundle,
      targetJobId: executionTargetJobId,
      sourceJobId,
      executionKind,
      mode,
      taskId: mode === "pipeline" ? undefined : taskId,
      signal: options.signal,
      on_progress: options.on_progress,
    })
    executionStarted = true
    return await prepared.execute()
  } catch (error) {
    if (createdModelRun && !executionStarted) {
      state.modelRunStore.deleteModelRunForJob(sourceJobId)
      await rm(join(jobDir, "spice"), { recursive: true, force: true }).catch(() => undefined)
    }
    throw error
  } finally {
    await derivedInput?.cleanup()
  }
}

async function runReferencedInput(input: {
  rootDir: string
  bundle: Awaited<ReturnType<typeof loadPipelineTaskInputBundle>>
  mode: LocalRunMode
  options: DebugCliOptions
}) {
  validateLocalInput({
    bundle: input.bundle,
    mode: input.mode,
    ...(input.mode === "task" ? { taskId: input.bundle.envelope.task_id } : {}),
  })
  const sourceJobId = input.bundle.envelope.execution_context.job_id
  if (typeof sourceJobId !== "string" || !sourceJobId.trim()) {
    throw new Error("Retained input has no source job id")
  }
  const state = await restoredState(input.rootDir, sourceJobId)
  const executionContext = {
    rootDir: input.rootDir,
    jobsRoot: state.jobsRoot,
    localRunsRoot: join(input.rootDir, ".runtime", "local"),
    jobStore: state.jobStore,
    modelRunStore: state.modelRunStore,
  }
  const clone = await clonePipelineJob({
    context: executionContext,
    sourceJobId,
    bundle: input.bundle,
  })
  return (
    await createPipelineJobRun({
      context: executionContext,
      bundle: clone.bundle,
      targetJobId: clone.jobId,
      sourceJobId,
      executionKind: "clone",
      mode: input.mode,
      ...(input.mode === "task" ? { taskId: input.bundle.envelope.task_id } : {}),
      signal: input.options.signal,
      on_progress: input.options.on_progress,
    })
  ).execute()
}

export async function runDebugCli(args = Bun.argv.slice(2), options: DebugCliOptions = {}): Promise<unknown> {
  if (args.length === 0 || args.includes("--help") || args[0] === "help") return { help: HELP }
  const rootDir = resolve(option({ args, name: "--root" }) ?? process.cwd())

  if (args[0] === "catalog") {
    assertArguments({ args, positional_count: 1, allowed_options: [] })
    return { pipelines: PIPELINE_TASK_CATALOG }
  }
  if (args[0] === "job" && args[1] === "list") {
    assertArguments({ args, positional_count: 2, allowed_options: ["--root"] })
    const state = await restoredState(rootDir)
    return {
      jobs_root: state.jobsRoot,
      restored: state.restored,
      jobs: state.jobStore.listJobs().map((summary) => {
        const job = state.jobStore.getJob(summary.job_id)
        const modelRunId = state.modelRunStore.getModelRunIdForJob(summary.job_id)
        return {
          ...summary,
          pipelines: {
            component_generation: job?.pipelines?.component_generation ?? job?.pipeline,
            typical_application: job?.pipelines?.typical_application,
            spice_generation: modelRunId ? state.modelRunStore.getModelRun(modelRunId)?.pipeline : undefined,
          },
        }
      }),
    }
  }
  if (args[0] === "local" && args[1] === "list") {
    assertArguments({ args, positional_count: 2, allowed_options: ["--root"] })
    const localRunsRoot = join(rootDir, ".runtime", "local")
    return {
      local_runs_root: localRunsRoot,
      local_runs: await reconcileInterruptedLocalRuns(localRunsRoot),
    }
  }
  if (args[0] === "task" && args[1] === "inspect") {
    assertArguments({ args, positional_count: 2, allowed_options: ["--input"] })
    return inspectInput(requiredOption({ args, name: "--input" }))
  }
  if (args[0] === "task" && args[1] === "run") {
    assertArguments({ args, positional_count: 2, allowed_options: ["--input", "--root"] })
    const bundle = await loadPipelineTaskInputBundle(requiredOption({ args, name: "--input" }))
    return runReferencedInput({ rootDir, bundle, mode: "task", options })
  }
  if (args[0] === "pipeline" && args[1] === "run") {
    assertArguments({ args, positional_count: 2, allowed_options: ["--input", "--root"] })
    const bundle = await loadPipelineTaskInputBundle(requiredOption({ args, name: "--input" }))
    return runReferencedInput({ rootDir, bundle, mode: "pipeline", options })
  }
  if (args[0] === "local" && args[1] === "run") {
    const hasTarget = Boolean(args[2] && !args[2].startsWith("--"))
    assertArguments({
      args,
      positional_count: hasTarget ? 3 : 2,
      allowed_options: ["--job", "--pipeline", "--task", "--from", "--repair-minutes", "--root"],
    })
    return runLocalJob({ args, rootDir, options })
  }
  throw new Error(`Unknown command.\n\n${HELP}`)
}
