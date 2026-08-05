import { mkdir, readFile, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import type { PublicPipelineSnapshot } from "@/shared/job-types"
import type { PipelineJsonValue, PipelineTaskInputEnvelope } from "@/shared/pipeline-types"
import { JobStore } from "../server/job-store"
import { restorePersistedJobs } from "../server/job-restorer"
import { ModelRunStore } from "../server/model-run-store"
import { loadPipelineTaskInput, parsePipelineTaskInput } from "../server/pipeline"
import {
  PIPELINE_REGISTRY,
  PIPELINE_TASK_CATALOG,
  type RegisteredPipelineId,
} from "../server/pipeline-registry"
import { type ReplayMode, runPipelineReplay } from "../server/pipeline-replay"

const HELP = `datasheet pipeline debugger

Commands:
  debug catalog
  debug job list [--root <repo>]
  debug job replay <job-id> --pipeline <id> [--task <id> | --from <id>] [--output <dir>]
  debug task inspect --input <input.json>
  debug task run --input <input.json> [--output <dir>]
  debug pipeline run --input <input.json> [--output <dir>]

Every command writes machine-readable JSON. Replays run in a fresh cloned workspace
under .runtime/replays unless --output is supplied.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function jsonRecord(value: unknown): value is Record<string, PipelineJsonValue> {
  return isRecord(value)
}

function resolveInputPath({ jobDir, debugRef }: { jobDir: string; debugRef: string }): string {
  const jobRoot = resolve(jobDir)
  const inputPath = resolve(jobRoot, debugRef, "input.json")
  const pathFromJob = relative(jobRoot, inputPath)
  if (pathFromJob.startsWith("..") || isAbsolute(pathFromJob)) {
    throw new Error("Retained task input escapes the job workspace")
  }
  return inputPath
}

async function restoredState(rootDir: string) {
  const jobsRoot = join(rootDir, ".runtime", "jobs")
  await mkdir(jobsRoot, { recursive: true })
  // Discovery and input selection are read-only. Replay gets separate stores
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

function contextForLegacyInput(input: {
  pipelineId: RegisteredPipelineId
  jobId: string
  jobStore: JobStore
  modelRunStore: ModelRunStore
}): Readonly<Record<string, PipelineJsonValue>> {
  const job = input.jobStore.getJob(input.jobId)
  const jobDir = input.jobStore.getJobDir(input.jobId)
  if (!job || !jobDir) throw new Error(`Job ${input.jobId} was not found`)
  if (input.pipelineId !== "spice_generation") {
    const retrySource = input.jobStore.getJobRetrySource(input.jobId)
    return {
      job_id: input.jobId,
      job_dir: jobDir,
      use_openai: job.use_openai ?? false,
      invocation_id: `legacy-${crypto.randomUUID()}`,
      ...(retrySource?.additional_instructions
        ? { additional_instructions: retrySource.additional_instructions }
        : {}),
    }
  }
  const modelRunId = input.modelRunStore.getModelRunIdForJob(input.jobId)
  const modelRun = modelRunId ? input.modelRunStore.getModelRun(modelRunId) : undefined
  const modelDir = modelRunId ? input.modelRunStore.getModelDir(modelRunId) : undefined
  if (!modelRunId || !modelRun || !modelDir) throw new Error(`Job ${input.jobId} has no SPICE run`)
  return {
    model_run_id: modelRunId,
    job_id: input.jobId,
    job_dir: jobDir,
    model_dir: modelDir,
    use_openai: modelRun.use_openai ?? false,
    max_repair_attempts: Math.max(1, Math.min(8, modelRun.effort_multiplier)),
    invocation_id: `legacy-${crypto.randomUUID()}`,
  }
}

async function loadReplayEnvelope(input: {
  path: string
  pipelineId: RegisteredPipelineId
  taskId: string
  jobId: string
  jobStore: JobStore
  modelRunStore: ModelRunStore
}): Promise<PipelineTaskInputEnvelope> {
  const raw = JSON.parse(await readFile(input.path, "utf8")) as unknown
  let parseError: unknown
  try {
    const current = parsePipelineTaskInput(raw)
    if (current.pipeline_id !== input.pipelineId || current.task_id !== input.taskId) {
      throw new Error("Retained task input identity does not match the requested task")
    }
    return current
  } catch (error) {
    parseError = error
  }
  if (
    !isRecord(raw) ||
    raw.version !== undefined ||
    !Array.isArray(raw.depends_on) ||
    !isRecord(raw.dependency_statuses) ||
    !jsonRecord(raw.dependency_outputs)
  ) {
    throw parseError
  }
  return {
    version: 1,
    kind: "pipeline_task_input",
    pipeline_id: input.pipelineId,
    task_id: input.taskId,
    run_id: input.jobId,
    execution_context: contextForLegacyInput(input),
    depends_on: raw.depends_on.filter((entry): entry is string => typeof entry === "string"),
    dependency_statuses: Object.fromEntries(
      Object.entries(raw.dependency_statuses).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    dependency_outputs: raw.dependency_outputs,
  }
}

function collectPaths({
  value,
  result = new Set<string>(),
}: {
  value: PipelineJsonValue
  result?: Set<string>
}): Set<string> {
  if (typeof value === "string" && isAbsolute(value)) result.add(value)
  else if (Array.isArray(value)) {
    value.forEach((entry) => collectPaths({ value: entry, result }))
  } else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((entry) => collectPaths({ value: entry, result }))
  }
  return result
}

async function inspectInput(path: string) {
  const envelope = await loadPipelineTaskInput(path)
  const paths = collectPaths({ value: envelope.execution_context })
  collectPaths({ value: envelope.dependency_outputs, result: paths })
  const referencedPaths = await Promise.all(
    [...paths].map(async (referencedPath) => ({
      path: referencedPath,
      exists: await stat(referencedPath)
        .then(() => true)
        .catch(() => false),
    })),
  )
  return { input_path: resolve(path), envelope, referenced_paths: referencedPaths }
}

async function replayOldJob({ args, rootDir }: { args: readonly string[]; rootDir: string }) {
  const jobId = args[2]
  if (!jobId || jobId.startsWith("--")) throw new Error("job replay requires a job id")
  const pipelineId = requiredOption({ args, name: "--pipeline" })
  if (!(pipelineId in PIPELINE_REGISTRY)) throw new Error(`Unknown pipeline ${pipelineId}`)
  const registeredPipelineId = pipelineId as RegisteredPipelineId
  const taskOption = option({ args, name: "--task" })
  const fromOption = option({ args, name: "--from" })
  if (taskOption && fromOption) throw new Error("Use either --task or --from, not both")
  const definition = PIPELINE_REGISTRY[registeredPipelineId]
  const mode: ReplayMode = taskOption ? "task" : fromOption ? "from_task" : "pipeline"
  const taskId = taskOption ?? fromOption ?? definition.stages[0]?.id
  if (!taskId || !definition.stages.some(({ id }) => id === taskId)) {
    throw new Error(`Pipeline ${pipelineId} has no task ${taskId}`)
  }

  const state = await restoredState(rootDir)
  const jobDir = state.jobStore.getJobDir(jobId)
  if (!jobDir) throw new Error(`Job ${jobId} was not found`)
  const snapshot = snapshotForPipeline({
    pipelineId: registeredPipelineId,
    jobId,
    jobStore: state.jobStore,
    modelRunStore: state.modelRunStore,
  })
  const retainedTask = snapshot?.stage_results[taskId]
  if (!retainedTask) throw new Error(`Job ${jobId} has no retained input for ${pipelineId}/${taskId}`)
  const inputPath = resolveInputPath({ jobDir, debugRef: retainedTask.debug_ref })
  const envelope = await loadReplayEnvelope({
    path: inputPath,
    pipelineId: registeredPipelineId,
    taskId,
    jobId,
    jobStore: state.jobStore,
    modelRunStore: state.modelRunStore,
  })
  return runPipelineReplay({
    rootDir,
    envelope,
    mode,
    taskId: mode === "pipeline" ? undefined : taskId,
    outputDir: option({ args, name: "--output" }),
  })
}

export async function runDebugCli(args = Bun.argv.slice(2)): Promise<unknown> {
  if (args.length === 0 || args.includes("--help") || args[0] === "help") return { help: HELP }
  const rootDir = resolve(option({ args, name: "--root" }) ?? process.cwd())

  if (args[0] === "catalog") return { pipelines: PIPELINE_TASK_CATALOG }
  if (args[0] === "job" && args[1] === "list") {
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
  if (args[0] === "task" && args[1] === "inspect") {
    return inspectInput(requiredOption({ args, name: "--input" }))
  }
  if (args[0] === "task" && args[1] === "run") {
    const envelope = await loadPipelineTaskInput(requiredOption({ args, name: "--input" }))
    return runPipelineReplay({
      rootDir,
      envelope,
      mode: "task",
      taskId: envelope.task_id,
      outputDir: option({ args, name: "--output" }),
    })
  }
  if (args[0] === "pipeline" && args[1] === "run") {
    const envelope = await loadPipelineTaskInput(requiredOption({ args, name: "--input" }))
    return runPipelineReplay({
      rootDir,
      envelope,
      mode: "pipeline",
      outputDir: option({ args, name: "--output" }),
    })
  }
  if (args[0] === "job" && args[1] === "replay") return replayOldJob({ args, rootDir })
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
      process.stderr.write(
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
