import { join } from "node:path"
import type { LocalRunMode, LocalRunSummary } from "@/shared/local-run"
import type { PublicPipelineSnapshot } from "@/shared/job-types"
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
import { BunProcessRunner } from "../infrastructure/process"
import type { JobStore } from "../job-store"
import type { ModelRunStore } from "../model-run-store"
import { MODEL_PIPELINE } from "../model-workflow"
import {
  waitForComponentBeforePublication,
  waitForModelEvidenceBeforeComparison,
} from "../model-workflow/stages/wait-for-component"
import type {
  ModelPipelineContext,
  ModelPipelineOutputs,
  ModelPipelineServices,
} from "../model-workflow/types"
import { ModelStrategyRegistry } from "../modeling"
import {
  PipelineError,
  type PipelineTaskInputBundle,
  projectPublicPipelineSnapshot,
  runPipeline,
} from "../pipeline"
import type { LocalWorkspace } from "./workspace"

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
  const repairBudget = record.repair_budget_ms
  if (repairBudget !== undefined && (typeof repairBudget !== "number" || !Number.isFinite(repairBudget))) {
    throw new Error("Task context repair_budget_ms must be a finite number when provided")
  }
  return {
    model_run_id: requiredString({ record, key: "model_run_id" }),
    job_id: requiredString({ record, key: "job_id" }),
    job_dir: requiredString({ record, key: "job_dir" }),
    model_dir: requiredString({ record, key: "model_dir" }),
    use_openai: requiredBoolean({ record, key: "use_openai" }),
    ...(typeof repairBudget === "number" ? { repair_budget_ms: repairBudget } : {}),
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

export function validateLocalInput(input: {
  bundle: PipelineTaskInputBundle
  mode: LocalRunMode
  taskId?: string
}) {
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

export async function executePipeline(input: {
  rootDir: string
  local: LocalWorkspace
  jobStore: JobStore
  modelRunStore: ModelRunStore
  pipelineId: string
  mode: LocalRunMode
  taskId?: string
  runDir: string
  signal?: AbortSignal
  refresh_job?: () => Promise<void>
  normalize_snapshot?: (snapshot: PublicPipelineSnapshot) => PublicPipelineSnapshot
  on_snapshot?: (snapshot: PublicPipelineSnapshot) => void
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
      signal: input.signal,
      target: executionTarget<ComponentPipelineOutputs, ComponentPipelineContext, ComponentPipelineServices>({
        definition: COMPONENT_PIPELINE,
        mode: input.mode,
        taskId: input.taskId,
        dependencyOutputs: input.local.dependencyOutputs,
      }),
      on_snapshot: (snapshot) => {
        const projected = projectPublicPipelineSnapshot({
          snapshot,
          artifact_root: input.local.jobDir,
          private_roots: [input.runDir],
        })
        const normalized = input.normalize_snapshot?.(projected) ?? projected
        const job = input.jobStore.getJob(componentContext(input.local.context).job_id)
        if (!job) return
        input.jobStore.updateJob(job.job_id, {
          pipeline: normalized,
          pipelines: { ...job.pipelines, component_generation: normalized },
        })
        input.on_snapshot?.(normalized)
      },
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
      signal: input.signal,
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
      on_snapshot: (snapshot) => {
        const projected = projectPublicPipelineSnapshot({
          snapshot,
          artifact_root: input.local.jobDir,
          private_roots: [input.runDir],
        })
        const normalized = input.normalize_snapshot?.(projected) ?? projected
        const job = input.jobStore.getJob(componentContext(input.local.context).job_id)
        if (!job) return
        input.jobStore.updateJob(job.job_id, {
          pipelines: { ...job.pipelines, typical_application: normalized },
        })
        input.on_snapshot?.(normalized)
      },
    })) as PipelineRunResult<PipelineOutputMap>
  }
  if (input.pipelineId === "spice_generation") {
    const context = modelContext(input.local.context)
    const services: ModelPipelineServices = {
      job_store: input.jobStore,
      model_run_store: input.modelRunStore,
      agent_client: agentClient,
      process_runner: processRunner,
      strategy_registry: new ModelStrategyRegistry(),
      tsci_bin: tsciBin,
    }
    return (await runPipeline({
      definition: MODEL_PIPELINE,
      run_id: input.local.localRunId,
      workspace_dir: input.runDir,
      context,
      services,
      task_input_root: input.local.jobDir,
      signal: input.signal,
      target: executionTarget<ModelPipelineOutputs, ModelPipelineContext, ModelPipelineServices>({
        definition: MODEL_PIPELINE,
        mode: input.mode,
        taskId: input.taskId,
        dependencyOutputs: input.local.dependencyOutputs,
      }),
      before_stage_start:
        input.mode === "pipeline"
          ? ({ stage_id, signal }) => {
              if (stage_id === "wait_for_model_evidence") {
                return waitForModelEvidenceBeforeComparison({
                  job_id: context.job_id,
                  model_run_id: context.model_run_id,
                  job_store: input.jobStore,
                  model_run_store: input.modelRunStore,
                  signal,
                  refresh_job: input.refresh_job,
                })
              }
              if (stage_id === "wait_for_component") {
                return waitForComponentBeforePublication({
                  job_id: context.job_id,
                  model_run_id: context.model_run_id,
                  job_store: input.jobStore,
                  model_run_store: input.modelRunStore,
                  signal,
                  refresh_job: input.refresh_job,
                })
              }
            }
          : undefined,
      on_snapshot: (snapshot) => {
        const projected = projectPublicPipelineSnapshot({
          snapshot,
          artifact_root: input.local.jobDir,
          private_roots: [context.model_dir, input.runDir],
        })
        const normalized = input.normalize_snapshot?.(projected) ?? projected
        input.modelRunStore.updateModelRun(context.model_run_id, { pipeline: normalized })
        input.on_snapshot?.(normalized)
      },
    })) as PipelineRunResult<PipelineOutputMap>
  }
  throw new Error(`Unknown pipeline ${input.pipelineId}`)
}

export interface PreparedPipelineLocalRun {
  readonly summary: LocalRunSummary
  execute(): Promise<LocalRunSummary>
}
