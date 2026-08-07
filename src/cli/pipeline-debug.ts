import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import type { PublicPipelineSnapshot } from "@/shared/job-types"
import type { LocalRunMode, LocalRunSummary } from "@/shared/local-run"
import type { PipelineJsonValue, PipelineTaskInputEnvelope } from "@/shared/pipeline-types"
import { JobStore } from "../server/job-store"
import { restorePersistedJobs } from "../server/job-restorer"
import { isLocalRunId, listLocalRuns, readLocalRunSummary } from "../server/local-runs"
import { ModelRunStore } from "../server/model-run-store"
import {
  loadPipelineTaskInput,
  loadPipelineTaskInputBundle,
  retainPipelineTaskInputFiles,
  type PipelineTaskInputBundle,
} from "../server/pipeline"
import {
  PIPELINE_REGISTRY,
  PIPELINE_TASK_CATALOG,
  type RegisteredPipelineId,
} from "../server/pipeline-registry"
import { runPipelineLocal } from "../server/pipeline-local-run"

const HELP = `datasheet pipeline debugger

Commands:
  debug catalog
  debug job list [--root <repo>]
  debug local list [--root <repo>]
  debug local run <job-or-local-run-id> --pipeline <id> [--task <id> | --from <id>] [--output <dir>]
  debug task inspect --input <input.json>
  debug task run --input <input.json> [--output <dir>]
  debug pipeline run --input <input.json> [--output <dir>]

Every command writes machine-readable JSON. Local runs materialize the exact retained
task input in a fresh workspace under .runtime/local unless --output is supplied.
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
  // Discovery and input selection are read-only. Local runs get separate stores
  // backed by the cloned workspace after its input has been resolved.
  const jobStore = new JobStore({ checkpoint_writer: () => undefined })
  const modelRunStore = new ModelRunStore({ checkpoint_writer: () => undefined })
  const restored = await restorePersistedJobs({
    jobs_root: jobsRoot,
    job_store: jobStore,
    model_run_store: modelRunStore,
  })
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

async function resolveLocalRunInput(input: {
  rootDir: string
  localRunId: string
  pipelineId: RegisteredPipelineId
  taskId: string
}): Promise<{ inputPath: string; source: LocalRunSummary }> {
  const source = await readLocalRunSummary(join(input.rootDir, ".runtime", "local"), input.localRunId)
  if (source.status === "running") {
    throw new Error(`Local run ${input.localRunId} is still running`)
  }
  if (source.pipeline_id !== input.pipelineId) {
    throw new Error(`Local run ${input.localRunId} belongs to ${source.pipeline_id}, not ${input.pipelineId}`)
  }
  if (!isRecord(source.stage_results)) {
    throw new Error(`Local run ${input.localRunId} has no retained stage results`)
  }
  const stage = source.stage_results[input.taskId]
  if (!isRecord(stage) || stage.stage_id !== input.taskId || typeof stage.debug_dir !== "string") {
    throw new Error(
      `Local run ${input.localRunId} has no retained input for ${input.pipelineId}/${input.taskId}`,
    )
  }
  const executionRoot = resolve(source.execution_dir)
  const debugDir = resolve(stage.debug_dir)
  const debugRef = relative(executionRoot, debugDir)
  if (debugRef.startsWith("..") || isAbsolute(debugRef)) {
    throw new Error(`Local run ${input.localRunId} has an invalid debug directory`)
  }
  return {
    inputPath: await resolveInputPath({ jobDir: executionRoot, debugRef }),
    source,
  }
}

function asPipelineJsonValue(value: unknown, path: string): PipelineJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    return value.map((entry, index) => asPipelineJsonValue(entry, `${path}[${index}]`))
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, asPipelineJsonValue(entry, `${path}.${key}`)]),
    )
  }
  throw new Error(`Local run has a non-JSON value at ${path}`)
}

function taskInputExcludedRoots(pipelineId: RegisteredPipelineId): readonly string[] | undefined {
  return pipelineId === "spice_generation" ? undefined : ["spice"]
}

async function loadLocalRunTaskBundle(input: {
  source: LocalRunSummary
  inputPath: string
  pipelineId: RegisteredPipelineId
  taskId: string
}): Promise<{ bundle: PipelineTaskInputBundle; cleanup?: () => Promise<void> }> {
  const envelope = await loadPipelineTaskInput(input.inputPath)
  if (envelope.input_files) {
    return { bundle: await loadPipelineTaskInputBundle(input.inputPath) }
  }
  if (!isRecord(input.source.stage_results)) {
    throw new Error(`Local run ${input.source.local_run_id} has no retained stage results`)
  }

  const dependencyStatuses: Record<string, string> = {}
  const dependencyOutputs: Record<string, PipelineJsonValue> = {}
  for (const dependencyId of envelope.depends_on) {
    const dependency = input.source.stage_results[dependencyId]
    if (!isRecord(dependency) || typeof dependency.status !== "string") {
      throw new Error(`Local run ${input.source.local_run_id} has no result for dependency ${dependencyId}`)
    }
    dependencyStatuses[dependencyId] = dependency.status
    if (dependency.status !== "completed" || !("output" in dependency)) {
      throw new Error(
        `Local run ${input.source.local_run_id} cannot continue at ${input.taskId}: dependency ${dependencyId} is ${dependency.status}`,
      )
    }
    dependencyOutputs[dependencyId] = asPipelineJsonValue(
      dependency.output,
      `stage_results.${dependencyId}.output`,
    )
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "pipeline-local-continuation-"))
  try {
    const debugDir = join(temporaryRoot, "stages", input.taskId)
    await mkdir(debugDir, { recursive: true })
    const inputFiles = await retainPipelineTaskInputFiles({
      root_dir: input.source.workspace_dir,
      debug_dir: debugDir,
      objects_dir: join(temporaryRoot, "input-objects"),
      excluded_roots: taskInputExcludedRoots(input.pipelineId),
    })
    const derivedEnvelope: PipelineTaskInputEnvelope = {
      ...envelope,
      dependency_statuses: dependencyStatuses,
      dependency_outputs: dependencyOutputs,
      input_files: inputFiles,
    }
    const derivedInputPath = join(debugDir, "input.json")
    await writeFile(derivedInputPath, `${JSON.stringify(derivedEnvelope, null, 2)}\n`, "utf8")
    const bundle = await loadPipelineTaskInputBundle(derivedInputPath)
    return {
      bundle,
      cleanup: () => rm(temporaryRoot, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true })
    throw error
  }
}

async function runLocalJob({ args, rootDir }: { args: readonly string[]; rootDir: string }) {
  const jobId = args[2]
  if (!jobId || jobId.startsWith("--")) throw new Error("local run requires a job id")
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
  const jobDir = state.jobStore.getJobDir(jobId)
  let bundle: PipelineTaskInputBundle
  let parentLocalRunId: string | undefined
  let protectedDirs: readonly string[] | undefined
  let cleanup: (() => Promise<void>) | undefined
  if (jobDir) {
    const snapshot = snapshotForPipeline({
      pipelineId: registeredPipelineId,
      jobId,
      jobStore: state.jobStore,
      modelRunStore: state.modelRunStore,
    })
    const retainedTask = snapshot?.stage_results[taskId]
    if (!retainedTask) throw new Error(`Job ${jobId} has no retained input for ${pipelineId}/${taskId}`)
    const inputPath = await resolveInputPath({ jobDir, debugRef: retainedTask.debug_ref })
    bundle = await loadPipelineTaskInputBundle(inputPath)
  } else if (isLocalRunId(jobId)) {
    const localInput = await resolveLocalRunInput({
      rootDir,
      localRunId: jobId,
      pipelineId: registeredPipelineId,
      taskId,
    })
    const localBundle = await loadLocalRunTaskBundle({
      source: localInput.source,
      inputPath: localInput.inputPath,
      pipelineId: registeredPipelineId,
      taskId,
    })
    bundle = localBundle.bundle
    cleanup = localBundle.cleanup
    parentLocalRunId = localInput.source.local_run_id
    protectedDirs = [localInput.source.execution_dir]
  } else {
    throw new Error(`Job or Local run ${jobId} was not found`)
  }
  if (bundle.envelope.pipeline_id !== registeredPipelineId || bundle.envelope.task_id !== taskId) {
    await cleanup?.()
    throw new Error("Retained task input identity does not match the requested task")
  }
  try {
    return await runPipelineLocal({
      rootDir,
      bundle,
      mode,
      taskId: mode === "pipeline" ? undefined : taskId,
      outputDir: option({ args, name: "--output" }),
      ...(parentLocalRunId ? { parentLocalRunId } : {}),
      ...(protectedDirs ? { protectedDirs } : {}),
    })
  } finally {
    await cleanup?.()
  }
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
    assertArguments({ args, positional_count: 2, allowed_options: ["--input", "--output", "--root"] })
    const bundle = await loadPipelineTaskInputBundle(requiredOption({ args, name: "--input" }))
    return runPipelineLocal({
      rootDir,
      bundle,
      mode: "task",
      taskId: bundle.envelope.task_id,
      outputDir: option({ args, name: "--output" }),
    })
  }
  if (args[0] === "pipeline" && args[1] === "run") {
    assertArguments({ args, positional_count: 2, allowed_options: ["--input", "--output", "--root"] })
    const bundle = await loadPipelineTaskInputBundle(requiredOption({ args, name: "--input" }))
    return runPipelineLocal({
      rootDir,
      bundle,
      mode: "pipeline",
      outputDir: option({ args, name: "--output" }),
    })
  }
  if (args[0] === "local" && args[1] === "run") {
    assertArguments({
      args,
      positional_count: 3,
      allowed_options: ["--pipeline", "--task", "--from", "--output", "--root"],
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
