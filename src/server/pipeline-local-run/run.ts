import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { LocalRunMode, LocalRunSummary } from "@/shared/local-run"
import type {
  PipelineDefinition,
  PipelineExecutionTarget,
  PipelineJsonValue,
  PipelineOutputMap,
  PipelineRunResult,
} from "@/shared/pipeline-types"
import { APPLICATION_PIPELINE, COMPONENT_PIPELINE } from "../component-workflow"
import type {
  ApplicationPipelineOutputs,
  ComponentPipelineContext,
  ComponentPipelineOutputs,
  ComponentPipelineServices,
} from "../component-workflow/types"
import { TsciAgentClient } from "../infrastructure/agent"
import { atomicWriteJsonSync } from "../infrastructure/persistence/atomic-write"
import { BunProcessRunner } from "../infrastructure/process"
import { JobStore } from "../job-store"
import { restorePersistedJobs } from "../job-restorer"
import { ModelRunStore } from "../model-run-store"
import { MODEL_PIPELINE } from "../model-workflow"
import type {
  ModelPipelineContext,
  ModelPipelineOutputs,
  ModelPipelineServices,
} from "../model-workflow/types"
import { ModelStrategyRegistry } from "../modeling"
import {
  loadPipelineTaskInputBundle,
  PipelineError,
  runPipeline,
  type PipelineTaskInputBundle,
} from "../pipeline"
import { executeLocalNgspice } from "../spice-validation"
import { createLocalWorkspace, type LocalWorkspace } from "./workspace"

function requiredString({
  record,
  key,
}: {
  record: Readonly<Record<string, PipelineJsonValue>>
  key: string
}): string {
  const value = record[key]
  if (typeof value !== "string" || !value.trim()) throw new Error(`Task context requires ${key}`)
  return value
}

function requiredBoolean({
  record,
  key,
}: {
  record: Readonly<Record<string, PipelineJsonValue>>
  key: string
}): boolean {
  const value = record[key]
  if (typeof value !== "boolean") throw new Error(`Task context requires boolean ${key}`)
  return value
}

function requiredNumber({
  record,
  key,
}: {
  record: Readonly<Record<string, PipelineJsonValue>>
  key: string
}): number {
  const value = record[key]
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Task context requires numeric ${key}`)
  }
  return value
}

function componentContext(record: Readonly<Record<string, PipelineJsonValue>>): ComponentPipelineContext {
  const additionalInstructions = record.additional_instructions
  return {
    job_id: requiredString({ record, key: "job_id" }),
    job_dir: requiredString({ record, key: "job_dir" }),
    use_openai: requiredBoolean({ record, key: "use_openai" }),
    invocation_id: requiredString({ record, key: "invocation_id" }),
    ...(typeof additionalInstructions === "string"
      ? { additional_instructions: additionalInstructions }
      : {}),
  }
}

function modelContext(record: Readonly<Record<string, PipelineJsonValue>>): ModelPipelineContext {
  return {
    model_run_id: requiredString({ record, key: "model_run_id" }),
    job_id: requiredString({ record, key: "job_id" }),
    job_dir: requiredString({ record, key: "job_dir" }),
    model_dir: requiredString({ record, key: "model_dir" }),
    use_openai: requiredBoolean({ record, key: "use_openai" }),
    max_repair_attempts: requiredNumber({ record, key: "max_repair_attempts" }),
    invocation_id: requiredString({ record, key: "invocation_id" }),
  }
}

function executionTarget<
  Outputs extends PipelineOutputMap,
  Context extends object,
  Services extends object,
>(input: {
  definition: PipelineDefinition<Outputs, Context, Services>
  mode: LocalRunMode
  taskId?: string
  dependencyOutputs: Readonly<Record<string, PipelineJsonValue>>
}): PipelineExecutionTarget<Outputs> {
  if (input.mode === "pipeline") return { mode: "pipeline" }
  const task = input.definition.stages.find(({ id }) => id === input.taskId)
  if (!task) throw new Error(`Pipeline ${input.definition.pipeline_id} has no task ${input.taskId}`)
  return {
    mode: input.mode === "task" ? "stage" : "from_stage",
    stage_id: task.id,
    dependency_outputs: input.dependencyOutputs,
  }
}

function taskResult<Outputs extends PipelineOutputMap>({
  result,
  taskId,
}: {
  result: PipelineRunResult<Outputs>
  taskId: string | undefined
}) {
  if (!taskId) return undefined
  return result.stage_results[taskId]
}

function validateLocalInput(input: { bundle: PipelineTaskInputBundle; mode: LocalRunMode; taskId?: string }) {
  if (input.mode !== "pipeline" && !input.taskId) {
    throw new Error(`${input.mode} Local run requires a task id`)
  }
  const envelope = input.bundle.envelope
  const definition =
    envelope.pipeline_id === "component_generation"
      ? COMPONENT_PIPELINE
      : envelope.pipeline_id === "typical_application"
        ? APPLICATION_PIPELINE
        : envelope.pipeline_id === "spice_generation"
          ? MODEL_PIPELINE
          : undefined
  if (!definition) throw new Error(`Unknown pipeline ${envelope.pipeline_id}`)
  const retainedTask = definition.stages.find(({ id }) => id === envelope.task_id)
  if (!retainedTask) {
    throw new PipelineError({
      code: "invalid_task_input",
      message: `Pipeline ${definition.pipeline_id} has no retained task ${envelope.task_id}`,
      stage_id: envelope.task_id,
      operation: "validate_local_input",
    })
  }
  if (
    retainedTask.depends_on.length !== envelope.depends_on.length ||
    retainedTask.depends_on.some((dependency_id, index) => envelope.depends_on[index] !== dependency_id)
  ) {
    throw new PipelineError({
      code: "invalid_task_input",
      message: `The retained dependency contract for ${retainedTask.id} does not match the registered task`,
      stage_id: retainedTask.id,
      operation: "validate_local_input",
    })
  }
  const requiredDependencies = new Set<string>(retainedTask.depends_on)
  const providedDependencies = Object.keys(envelope.dependency_outputs)
  const missingDependencies = retainedTask.depends_on.filter(
    (dependency_id) => !(dependency_id in envelope.dependency_outputs),
  )
  const unexpectedDependencies = providedDependencies.filter(
    (dependency_id) => !requiredDependencies.has(dependency_id),
  )
  if (missingDependencies.length > 0 || unexpectedDependencies.length > 0) {
    throw new PipelineError({
      code: "invalid_isolated_stage_input",
      message: [
        `The isolated input for ${retainedTask.id} does not match its declared dependencies.`,
        ...(missingDependencies.length > 0 ? [`Missing: ${missingDependencies.join(", ")}.`] : []),
        ...(unexpectedDependencies.length > 0 ? [`Unexpected: ${unexpectedDependencies.join(", ")}.`] : []),
      ].join(" "),
      stage_id: retainedTask.id,
      operation: "validate_local_input",
    })
  }
  if (input.mode === "pipeline" && envelope.task_id !== definition.stages[0]?.id) {
    throw new PipelineError({
      code: "invalid_pipeline_input",
      message: `A whole-pipeline Local run requires the retained input for ${definition.stages[0]?.id}`,
      stage_id: envelope.task_id,
      operation: "validate_local_input",
    })
  }
  if (input.mode !== "pipeline" && input.taskId !== retainedTask.id) {
    throw new PipelineError({
      code: "invalid_task_input",
      message: `Retained input for ${retainedTask.id} cannot execute ${input.taskId}`,
      stage_id: input.taskId ?? null,
      operation: "validate_local_input",
    })
  }
  return definition
}

async function executePipeline(input: {
  rootDir: string
  local: LocalWorkspace
  jobStore: JobStore
  modelRunStore: ModelRunStore
  pipelineId: string
  mode: LocalRunMode
  taskId?: string
  runDir: string
}): Promise<PipelineRunResult<PipelineOutputMap>> {
  const processRunner = new BunProcessRunner()
  const agentClient = new TsciAgentClient({
    process_runner: processRunner,
    agent_bin: process.env.TSCI_AGENT_BIN ?? join(input.rootDir, "node_modules", ".bin", "tsci-agent"),
    env: process.env.PI_CODING_AGENT_DIR
      ? undefined
      : { PI_CODING_AGENT_DIR: join(input.rootDir, ".runtime", "pi-agent") },
  })
  const tsciBin = process.env.TSCI_BIN ?? join(input.rootDir, "node_modules", ".bin", "tsci")

  if (input.pipelineId === "component_generation") {
    const services: ComponentPipelineServices = {
      job_store: input.jobStore,
      agent_client: agentClient,
      process_runner: processRunner,
      tsci_bin: tsciBin,
    }
    return (await runPipeline({
      definition: COMPONENT_PIPELINE,
      run_id: input.local.localRunId,
      workspace_dir: input.runDir,
      context: componentContext(input.local.context),
      services,
      task_input_root: input.local.jobDir,
      task_input_excluded_roots: ["spice"],
      target: executionTarget<ComponentPipelineOutputs, ComponentPipelineContext, ComponentPipelineServices>({
        definition: COMPONENT_PIPELINE,
        mode: input.mode,
        taskId: input.taskId,
        dependencyOutputs: input.local.dependencyOutputs,
      }),
    })) as PipelineRunResult<PipelineOutputMap>
  }
  if (input.pipelineId === "typical_application") {
    const services: ComponentPipelineServices = {
      job_store: input.jobStore,
      agent_client: agentClient,
      process_runner: processRunner,
      tsci_bin: tsciBin,
    }
    return (await runPipeline({
      definition: APPLICATION_PIPELINE,
      run_id: input.local.localRunId,
      workspace_dir: input.runDir,
      context: componentContext(input.local.context),
      services,
      task_input_root: input.local.jobDir,
      task_input_excluded_roots: ["spice"],
      target: executionTarget<
        ApplicationPipelineOutputs,
        ComponentPipelineContext,
        ComponentPipelineServices
      >({
        definition: APPLICATION_PIPELINE,
        mode: input.mode,
        taskId: input.taskId,
        dependencyOutputs: input.local.dependencyOutputs,
      }),
    })) as PipelineRunResult<PipelineOutputMap>
  }
  if (input.pipelineId === "spice_generation") {
    const services: ModelPipelineServices = {
      job_store: input.jobStore,
      model_run_store: input.modelRunStore,
      agent_client: agentClient,
      process_runner: processRunner,
      strategy_registry: new ModelStrategyRegistry(),
      tsci_bin: tsciBin,
      ngspice_bin: process.env.NGSPICE_BIN?.trim() || "ngspice",
      ngspice_executor: executeLocalNgspice,
    }
    return (await runPipeline({
      definition: MODEL_PIPELINE,
      run_id: input.local.localRunId,
      workspace_dir: input.runDir,
      context: modelContext(input.local.context),
      services,
      task_input_root: input.local.jobDir,
      target: executionTarget<ModelPipelineOutputs, ModelPipelineContext, ModelPipelineServices>({
        definition: MODEL_PIPELINE,
        mode: input.mode,
        taskId: input.taskId,
        dependencyOutputs: input.local.dependencyOutputs,
      }),
    })) as PipelineRunResult<PipelineOutputMap>
  }
  throw new Error(`Unknown pipeline ${input.pipelineId}`)
}

export interface PreparedPipelineLocalRun {
  readonly summary: LocalRunSummary
  execute(): Promise<LocalRunSummary>
}

export async function createPipelineLocalRun(input: {
  rootDir: string
  bundle: PipelineTaskInputBundle
  mode: LocalRunMode
  taskId?: string
  outputDir?: string
  localRunId?: string
  parentLocalRunId?: string
  protectedDirs?: readonly string[]
}): Promise<PreparedPipelineLocalRun> {
  validateLocalInput(input)
  const envelope = input.bundle.envelope
  const localRunId = input.localRunId ?? `local-${crypto.randomUUID()}`
  if (!/^local-[a-zA-Z0-9-]{16,80}$/.test(localRunId)) throw new Error("Invalid Local run id")
  const local = await createLocalWorkspace({
    bundle: input.bundle,
    localRunId,
    executionDir: input.outputDir ?? join(input.rootDir, ".runtime", "local", localRunId),
    protectedDirs: [join(input.rootDir, ".runtime", "jobs"), ...(input.protectedDirs ?? [])],
  })
  // Verify the retained copy before advertising the run as independently runnable.
  await loadPipelineTaskInputBundle(local.inputPath)

  const jobStore = new JobStore()
  const modelRunStore = new ModelRunStore()
  await restorePersistedJobs({
    jobs_root: local.jobsRoot,
    job_store: jobStore,
    model_run_store: modelRunStore,
  })
  const jobId = requiredString({ record: local.context, key: "job_id" })
  const job = jobStore.getJob(jobId)
  if (!job) throw new Error(`Local workspace could not restore job ${jobId}`)

  const runDir = join(local.executionDir, "run")
  const pipelineDir = join(runDir, ".pipeline")
  const eventsPath = join(pipelineDir, "events.ndjson")
  const summaryPath = join(local.executionDir, "summary.json")
  await mkdir(runDir, { recursive: true })
  const initialSummary: LocalRunSummary = {
    version: 1,
    local_run_id: local.localRunId,
    mode: input.mode,
    pipeline_id: envelope.pipeline_id,
    ...(input.taskId ? { task_id: input.taskId } : {}),
    source_run_id: envelope.run_id,
    source_job_id: jobId,
    ...(input.parentLocalRunId ? { parent_local_run_id: input.parentLocalRunId } : {}),
    file_name: job.file_name,
    status: "running",
    created_at: new Date().toISOString(),
    execution_dir: local.executionDir,
    workspace_dir: local.jobDir,
    input_path: local.inputPath,
    pipeline_dir: pipelineDir,
    events_path: eventsPath,
    summary_path: summaryPath,
    stage_results: {},
  }
  atomicWriteJsonSync(summaryPath, initialSummary)

  let execution: Promise<LocalRunSummary> | undefined
  const execute = (): Promise<LocalRunSummary> => {
    if (execution) return execution
    execution = executePipeline({
      rootDir: input.rootDir,
      local,
      jobStore,
      modelRunStore,
      pipelineId: envelope.pipeline_id,
      mode: input.mode,
      taskId: input.taskId,
      runDir,
    })
      .then((result) => {
        const summary: LocalRunSummary = {
          ...initialSummary,
          status: result.status,
          completed_at: new Date().toISOString(),
          pipeline_dir: result.pipeline_dir,
          events_path: result.events_path,
          stage_results: result.stage_results,
          ...(input.taskId ? { selected_task_result: taskResult({ result, taskId: input.taskId }) } : {}),
        }
        atomicWriteJsonSync(summaryPath, summary)
        return summary
      })
      .catch((error) => {
        const summary: LocalRunSummary = {
          ...initialSummary,
          status: "failed",
          completed_at: new Date().toISOString(),
          error_message: error instanceof Error ? error.message : String(error),
        }
        atomicWriteJsonSync(summaryPath, summary)
        throw error
      })
    return execution
  }
  return { summary: initialSummary, execute }
}

export async function runPipelineLocal(input: {
  rootDir: string
  bundle: PipelineTaskInputBundle
  mode: LocalRunMode
  taskId?: string
  outputDir?: string
  parentLocalRunId?: string
  protectedDirs?: readonly string[]
}): Promise<LocalRunSummary> {
  return (await createPipelineLocalRun(input)).execute()
}
