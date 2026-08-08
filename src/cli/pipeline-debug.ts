import { lstat, mkdir, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import type { PublicPipelineSnapshot } from "@/shared/job-types"
import type { LocalRunMode } from "@/shared/local-run"
import { JobStore } from "../server/job-store"
import { restorePersistedJobs } from "../server/job-restorer"
import { atomicWriteJsonSync } from "../server/infrastructure/persistence/atomic-write"
import { listLocalRuns } from "../server/local-runs"
import { ModelRunStore } from "../server/model-run-store"
import { loadPipelineTaskInputBundle } from "../server/pipeline"
import {
  PIPELINE_REGISTRY,
  PIPELINE_TASK_CATALOG,
  type RegisteredPipelineId,
} from "../server/pipeline-registry"
import { clonePipelineJob, createPipelineJobRun, validateLocalInput } from "../server/pipeline-local-run"

const HELP = `datasheet pipeline debugger

Commands:
  debug catalog
  debug job list [--root <repo>]
  debug local list [--root <repo>]
  debug local run <job-id> --pipeline <id> [--task <id> | --from <id>]
  debug local run --job <source-job-id> --pipeline <id> [--task <id> | --from <id>]
  debug task inspect --input <input.json>
  debug task run --input <input.json>
  debug pipeline run --input <input.json>

Every command writes machine-readable JSON. A positional job is the in-place target.
--job is a source reference and creates a new regular job before execution.
`

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

async function restoredState(rootDir: string) {
  const jobsRoot = join(rootDir, ".runtime", "jobs")
  await mkdir(jobsRoot, { recursive: true })
  let restorationComplete = false
  const checkpointWriter = (path: string, value: unknown) => {
    if (restorationComplete) atomicWriteJsonSync(path, value)
  }
  const jobStore = new JobStore({ checkpoint_writer: checkpointWriter })
  const modelRunStore = new ModelRunStore({ checkpoint_writer: checkpointWriter })
  const restored = await restorePersistedJobs({
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

async function runLocalJob({ args, rootDir }: { args: readonly string[]; rootDir: string }) {
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
  const taskOption = option({ args, name: "--task" })
  const fromOption = option({ args, name: "--from" })
  if (taskOption && fromOption) throw new Error("Use either --task or --from, not both")
  const definition = PIPELINE_REGISTRY[registeredPipelineId]
  const mode: LocalRunMode = taskOption ? "task" : fromOption ? "from_task" : "pipeline"
  const taskId = taskOption ?? fromOption ?? definition.stages[0]?.id
  if (!taskId || !definition.stages.some(({ id }) => id === taskId)) {
    throw new Error(`Pipeline ${pipelineId} has no task ${taskId}`)
  }

  const state = await restoredState(rootDir)
  const jobDir = state.jobStore.getJobDir(sourceJobId)
  if (!jobDir) throw new Error(`Job ${sourceJobId} was not found`)
  const snapshot = snapshotForPipeline({
    pipelineId: registeredPipelineId,
    jobId: sourceJobId,
    jobStore: state.jobStore,
    modelRunStore: state.modelRunStore,
  })
  const retainedTask = snapshot?.stage_results[taskId]
  if (!retainedTask) {
    throw new Error(`Job ${sourceJobId} has no retained input for ${pipelineId}/${taskId}`)
  }
  const inputPath = await resolveInputPath({ jobDir, debugRef: retainedTask.debug_ref })
  let bundle = await loadPipelineTaskInputBundle(inputPath)
  if (bundle.envelope.pipeline_id !== registeredPipelineId || bundle.envelope.task_id !== taskId) {
    throw new Error("Retained task input identity does not match the requested task")
  }
  const executionContext = {
    rootDir,
    jobsRoot: state.jobsRoot,
    localRunsRoot: join(rootDir, ".runtime", "local"),
    jobStore: state.jobStore,
    modelRunStore: state.modelRunStore,
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
  }
  return (
    await createPipelineJobRun({
      context: executionContext,
      bundle,
      targetJobId: executionTargetJobId,
      sourceJobId,
      executionKind,
      mode,
      taskId: mode === "pipeline" ? undefined : taskId,
    })
  ).execute()
}

async function runReferencedInput(input: {
  rootDir: string
  bundle: Awaited<ReturnType<typeof loadPipelineTaskInputBundle>>
  mode: LocalRunMode
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
  const state = await restoredState(input.rootDir)
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
    })
  ).execute()
}

export async function runDebugCli(args = Bun.argv.slice(2)): Promise<unknown> {
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
    return { local_runs_root: localRunsRoot, local_runs: await listLocalRuns(localRunsRoot) }
  }
  if (args[0] === "task" && args[1] === "inspect") {
    assertArguments({ args, positional_count: 2, allowed_options: ["--input"] })
    return inspectInput(requiredOption({ args, name: "--input" }))
  }
  if (args[0] === "task" && args[1] === "run") {
    assertArguments({ args, positional_count: 2, allowed_options: ["--input", "--root"] })
    const bundle = await loadPipelineTaskInputBundle(requiredOption({ args, name: "--input" }))
    return runReferencedInput({ rootDir, bundle, mode: "task" })
  }
  if (args[0] === "pipeline" && args[1] === "run") {
    assertArguments({ args, positional_count: 2, allowed_options: ["--input", "--root"] })
    const bundle = await loadPipelineTaskInputBundle(requiredOption({ args, name: "--input" }))
    return runReferencedInput({ rootDir, bundle, mode: "pipeline" })
  }
  if (args[0] === "local" && args[1] === "run") {
    const hasTarget = Boolean(args[2] && !args[2].startsWith("--"))
    assertArguments({
      args,
      positional_count: hasTarget ? 3 : 2,
      allowed_options: ["--job", "--pipeline", "--task", "--from", "--root"],
    })
    return runLocalJob({ args, rootDir })
  }
  throw new Error(`Unknown command.\n\n${HELP}`)
}

if (import.meta.main) {
  runDebugCli()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      if (isRecord(result) && (result.status === "failed" || result.status === "cancelled")) {
        process.exitCode = 1
      }
    })
    .catch((error) => {
      process.stdout.write(
        `${JSON.stringify(
          {
            error: {
              name: error instanceof Error ? error.name : "Error",
              message: error instanceof Error ? error.message : String(error),
            },
          },
          null,
          2,
        )}\n`,
      )
      process.exitCode = 1
    })
}
