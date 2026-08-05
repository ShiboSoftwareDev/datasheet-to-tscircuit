import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  PipelineDefinition,
  PipelineExecutionTarget,
  PipelineJsonValue,
  PipelineOutputMap,
  PipelineRunResult,
  PipelineTaskInputEnvelope,
} from "@/shared/pipeline-types"
import { APPLICATION_PIPELINE, COMPONENT_PIPELINE } from "../component-workflow"
import type {
  ApplicationPipelineOutputs,
  ComponentPipelineContext,
  ComponentPipelineOutputs,
  ComponentPipelineServices,
} from "../component-workflow/types"
import { TsciAgentClient } from "../infrastructure/agent"
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
import { runPipeline } from "../pipeline"
import { executeLocalNgspice } from "../spice-validation"
import { createReplayWorkspace } from "./workspace"

export type ReplayMode = "pipeline" | "task" | "from_task"

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
  mode: ReplayMode
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

export interface PipelineReplaySummary {
  readonly version: 1
  readonly replay_id: string
  readonly mode: ReplayMode
  readonly pipeline_id: string
  readonly task_id?: string
  readonly source_run_id: string
  readonly status: "completed" | "failed" | "cancelled"
  readonly execution_dir: string
  readonly workspace_dir: string
  readonly pipeline_dir: string
  readonly events_path: string
  readonly summary_path: string
  readonly stage_results: unknown
  readonly selected_task_result?: unknown
}

export async function runPipelineReplay(input: {
  rootDir: string
  envelope: PipelineTaskInputEnvelope
  mode: ReplayMode
  taskId?: string
  outputDir?: string
}): Promise<PipelineReplaySummary> {
  if (input.mode !== "pipeline" && !input.taskId) throw new Error(`${input.mode} replay requires a task id`)
  const replay = await createReplayWorkspace({
    rootDir: input.rootDir,
    envelope: input.envelope,
    outputDir: input.outputDir,
  })
  const jobStore = new JobStore()
  const modelRunStore = new ModelRunStore()
  await restorePersistedJobs({
    jobs_root: replay.jobsRoot,
    job_store: jobStore,
    model_run_store: modelRunStore,
  })
  const jobId = requiredString({ record: replay.context, key: "job_id" })
  if (!jobStore.getJob(jobId)) throw new Error(`Replay workspace could not restore job ${jobId}`)

  const processRunner = new BunProcessRunner()
  const agentClient = new TsciAgentClient({
    process_runner: processRunner,
    agent_bin: process.env.TSCI_AGENT_BIN ?? join(input.rootDir, "node_modules", ".bin", "tsci-agent"),
  })
  const tsciBin = process.env.TSCI_BIN ?? join(input.rootDir, "node_modules", ".bin", "tsci")
  const runDir = join(replay.executionDir, "run")
  await mkdir(runDir, { recursive: true })

  let result: PipelineRunResult<PipelineOutputMap>
  if (input.envelope.pipeline_id === "component_generation") {
    const services: ComponentPipelineServices = {
      job_store: jobStore,
      agent_client: agentClient,
      process_runner: processRunner,
      tsci_bin: tsciBin,
    }
    result = (await runPipeline({
      definition: COMPONENT_PIPELINE,
      run_id: replay.replayId,
      workspace_dir: runDir,
      context: componentContext(replay.context),
      services,
      target: executionTarget<ComponentPipelineOutputs, ComponentPipelineContext, ComponentPipelineServices>({
        definition: COMPONENT_PIPELINE,
        mode: input.mode,
        taskId: input.taskId,
        dependencyOutputs: replay.dependencyOutputs,
      }),
    })) as PipelineRunResult<PipelineOutputMap>
  } else if (input.envelope.pipeline_id === "typical_application") {
    const services: ComponentPipelineServices = {
      job_store: jobStore,
      agent_client: agentClient,
      process_runner: processRunner,
      tsci_bin: tsciBin,
    }
    result = (await runPipeline({
      definition: APPLICATION_PIPELINE,
      run_id: replay.replayId,
      workspace_dir: runDir,
      context: componentContext(replay.context),
      services,
      target: executionTarget<
        ApplicationPipelineOutputs,
        ComponentPipelineContext,
        ComponentPipelineServices
      >({
        definition: APPLICATION_PIPELINE,
        mode: input.mode,
        taskId: input.taskId,
        dependencyOutputs: replay.dependencyOutputs,
      }),
    })) as PipelineRunResult<PipelineOutputMap>
  } else if (input.envelope.pipeline_id === "spice_generation") {
    const services: ModelPipelineServices = {
      job_store: jobStore,
      model_run_store: modelRunStore,
      agent_client: agentClient,
      process_runner: processRunner,
      strategy_registry: new ModelStrategyRegistry(),
      tsci_bin: tsciBin,
      ngspice_bin: process.env.NGSPICE_BIN?.trim() || "ngspice",
      ngspice_executor: executeLocalNgspice,
    }
    result = (await runPipeline({
      definition: MODEL_PIPELINE,
      run_id: replay.replayId,
      workspace_dir: runDir,
      context: modelContext(replay.context),
      services,
      target: executionTarget<ModelPipelineOutputs, ModelPipelineContext, ModelPipelineServices>({
        definition: MODEL_PIPELINE,
        mode: input.mode,
        taskId: input.taskId,
        dependencyOutputs: replay.dependencyOutputs,
      }),
    })) as PipelineRunResult<PipelineOutputMap>
  } else {
    throw new Error(`Unknown pipeline ${input.envelope.pipeline_id}`)
  }

  const summaryPath = join(replay.executionDir, "summary.json")
  const summary: PipelineReplaySummary = {
    version: 1,
    replay_id: replay.replayId,
    mode: input.mode,
    pipeline_id: input.envelope.pipeline_id,
    ...(input.taskId ? { task_id: input.taskId } : {}),
    source_run_id: input.envelope.run_id,
    status: result.status,
    execution_dir: replay.executionDir,
    workspace_dir: replay.jobDir,
    pipeline_dir: result.pipeline_dir,
    events_path: result.events_path,
    summary_path: summaryPath,
    stage_results: result.stage_results,
    ...(input.taskId ? { selected_task_result: taskResult({ result, taskId: input.taskId }) } : {}),
  }
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8")
  return summary
}
