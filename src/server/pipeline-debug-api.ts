import { mkdir, readFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import type { PublicPipelineSnapshot } from "@/shared/job-types"
import { type DebugPipelineId, type DebugRunMode, PIPELINE_DEBUG_CATALOG } from "@/shared/pipeline-debug"
import type {
  PipelineDefinition,
  PipelineExecutionTarget,
  PipelineJsonValue,
  PipelineOutputMap,
} from "@/shared/pipeline-types"
import { APPLICATION_PIPELINE, COMPONENT_PIPELINE } from "./component-workflow/component-pipeline"
import type {
  ApplicationPipelineOutputs,
  ComponentPipelineContext,
  ComponentPipelineOutputs,
  ComponentPipelineServices,
  JobRunnerContext,
} from "./component-workflow/types"
import { TsciAgentClient } from "./infrastructure/agent"
import { BunProcessRunner } from "./infrastructure/process"
import type { JobStore } from "./job-store"
import type { ModelRunStore } from "./model-run-store"
import { MODEL_PIPELINE } from "./model-workflow/model-pipeline"
import type {
  ModelPipelineContext,
  ModelPipelineOutputs,
  ModelPipelineServices,
  ModelRunnerContext,
} from "./model-workflow/types"
import { ModelStrategyRegistry } from "./modeling"
import { projectPublicPipelineSnapshot, runPipeline } from "./pipeline"
import { executeLocalNgspice } from "./spice-validation"

interface PipelineDebugApiContext extends JobRunnerContext, ModelRunnerContext {
  job_store: JobStore
  model_run_store: ModelRunStore
}

interface DebugRunRequest {
  job_id: string
  pipeline_id: DebugPipelineId
  mode: DebugRunMode
  stage_id?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseRequest(value: unknown): DebugRunRequest | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.job_id !== "string" || !value.job_id.trim()) return undefined
  if (
    value.pipeline_id !== "component_generation" &&
    value.pipeline_id !== "typical_application" &&
    value.pipeline_id !== "spice_generation"
  ) {
    return undefined
  }
  if (value.mode !== "pipeline" && value.mode !== "stage" && value.mode !== "from_stage") {
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

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { error_code: code, message } }, { status })
}

function resolveDebugInputPath(job_dir: string, debug_ref: string): string {
  const resolved_job_dir = resolve(job_dir)
  const input_path = resolve(resolved_job_dir, debug_ref, "input.json")
  const path_from_job = relative(resolved_job_dir, input_path)
  if (path_from_job.startsWith("..") || isAbsolute(path_from_job)) {
    throw new Error("The selected stage debug reference escapes the job workspace")
  }
  return input_path
}

async function createExecutionTarget<
  Outputs extends PipelineOutputMap,
  Context extends object,
  Services extends object,
>(input: {
  definition: PipelineDefinition<Outputs, Context, Services>
  mode: DebugRunMode
  stage_id?: string
  snapshot?: PublicPipelineSnapshot
  job_dir: string
}): Promise<PipelineExecutionTarget<Outputs>> {
  if (input.mode === "pipeline") return { mode: "pipeline" }
  const stage = input.definition.stages.find(({ id }) => id === input.stage_id)
  if (!stage) throw new Error(`Pipeline ${input.definition.pipeline_id} has no stage ${input.stage_id}`)
  let dependency_outputs: Record<string, PipelineJsonValue> = {}
  if (stage.depends_on.length > 0) {
    const public_stage = input.snapshot?.stage_results[stage.id]
    if (!public_stage) {
      throw new Error(
        `Stage ${stage.id} has no retained input yet. Run the full ${input.definition.pipeline_id} pipeline first.`,
      )
    }
    const parsed = JSON.parse(
      await readFile(resolveDebugInputPath(input.job_dir, public_stage.debug_ref), "utf8"),
    ) as unknown
    if (!isRecord(parsed) || !isRecord(parsed.dependency_outputs)) {
      throw new Error(`The retained input bundle for ${stage.id} is malformed`)
    }
    dependency_outputs = parsed.dependency_outputs as Record<string, PipelineJsonValue>
  }
  return {
    mode: input.mode,
    stage_id: stage.id,
    dependency_outputs,
  } as PipelineExecutionTarget<Outputs>
}

function selectedStageIds<Outputs extends PipelineOutputMap, Context extends object, Services extends object>(
  definition: PipelineDefinition<Outputs, Context, Services>,
  target: PipelineExecutionTarget<Outputs>,
): ReadonlySet<string> {
  if (target.mode === "pipeline") return new Set(definition.stages.map(({ id }) => id))
  const start_index = definition.stages.findIndex(({ id }) => id === target.stage_id)
  return new Set(
    definition.stages
      .slice(target.mode === "stage" ? start_index : Math.max(0, start_index))
      .filter((_stage, index) => target.mode === "from_stage" || index === 0)
      .map(({ id }) => id),
  )
}

export function mergeDebugSnapshot(
  previous: PublicPipelineSnapshot | undefined,
  current: PublicPipelineSnapshot,
  selected_stage_ids: ReadonlySet<string>,
): PublicPipelineSnapshot {
  if (!previous) return current
  return {
    ...current,
    stage_results: Object.fromEntries(
      Object.entries(current.stage_results).map(([stage_id, stage]) => [
        stage_id,
        selected_stage_ids.has(stage_id) ? stage : (previous.stage_results[stage_id] ?? stage),
      ]),
    ),
  }
}

function createComponentServices(context: PipelineDebugApiContext): ComponentPipelineServices {
  const process_runner = context.process_runner ?? new BunProcessRunner()
  const agent_client =
    context.agent_client ??
    new TsciAgentClient({
      process_runner,
      agent_bin: context.agent_bin,
      max_attempts: context.agent_transport_retry_limit,
      retry_base_delay_ms: context.agent_transport_retry_base_delay_ms,
    })
  return { job_store: context.job_store, agent_client, process_runner, tsci_bin: context.tsci_bin }
}

async function runComponentDebugPipeline<Outputs extends PipelineOutputMap>(input: {
  definition: PipelineDefinition<Outputs, ComponentPipelineContext, ComponentPipelineServices>
  target: PipelineExecutionTarget<Outputs>
  job_id: string
  context: PipelineDebugApiContext
  snapshot_key: "component_generation" | "typical_application"
  base_snapshot?: PublicPipelineSnapshot
}): Promise<void> {
  const job_dir = input.context.job_store.getJobDir(input.job_id)
  const job = input.context.job_store.getJob(input.job_id)
  if (!job_dir || !job) throw new Error(`Job ${input.job_id} was not found`)
  const invocation_id = `debug-${crypto.randomUUID()}`
  const invocation_dir = join(job_dir, "runs", input.definition.pipeline_id, invocation_id)
  const selected_stage_ids = selectedStageIds(input.definition, input.target)
  await mkdir(invocation_dir, { recursive: true })
  const result = await runPipeline({
    definition: input.definition,
    run_id: input.job_id,
    workspace_dir: invocation_dir,
    context: {
      job_id: input.job_id,
      job_dir,
      use_openai: job.use_openai ?? input.context.use_openai ?? false,
      invocation_id,
    },
    services: createComponentServices(input.context),
    target: input.target,
    signal: new AbortController().signal,
    on_snapshot: (snapshot) => {
      const projected = mergeDebugSnapshot(
        input.base_snapshot,
        projectPublicPipelineSnapshot({
          snapshot,
          artifact_root: job_dir,
          private_roots: [invocation_dir],
        }),
        selected_stage_ids,
      )
      const pipelines = input.context.job_store.getJob(input.job_id)?.pipelines ?? {}
      input.context.job_store.updateJob(input.job_id, {
        ...(input.snapshot_key === "component_generation" ? { pipeline: projected } : {}),
        pipelines: { ...pipelines, [input.snapshot_key]: projected },
      })
    },
  })
  const projected = mergeDebugSnapshot(
    input.base_snapshot,
    projectPublicPipelineSnapshot({
      snapshot: result,
      artifact_root: job_dir,
      private_roots: [invocation_dir],
    }),
    selected_stage_ids,
  )
  const pipelines = input.context.job_store.getJob(input.job_id)?.pipelines ?? {}
  input.context.job_store.updateJob(input.job_id, {
    ...(input.snapshot_key === "component_generation" ? { pipeline: projected } : {}),
    pipelines: { ...pipelines, [input.snapshot_key]: projected },
  })
}

function createModelServices(context: PipelineDebugApiContext): ModelPipelineServices {
  const process_runner = context.process_runner ?? new BunProcessRunner()
  const agent_client =
    context.agent_client ??
    new TsciAgentClient({
      process_runner,
      agent_bin: context.agent_bin,
      max_attempts: context.agent_transport_retry_limit,
      retry_base_delay_ms: context.agent_transport_retry_base_delay_ms,
    })
  return {
    job_store: context.job_store,
    model_run_store: context.model_run_store,
    agent_client,
    process_runner,
    strategy_registry: context.strategy_registry ?? new ModelStrategyRegistry(),
    tsci_bin: context.tsci_bin,
    ngspice_bin: context.ngspice_bin ?? (process.env.NGSPICE_BIN?.trim() || "ngspice"),
    ngspice_executor: context.ngspice_executor ?? executeLocalNgspice,
  }
}

async function runSpiceDebugPipeline(input: {
  target: PipelineExecutionTarget<ModelPipelineOutputs>
  job_id: string
  context: PipelineDebugApiContext
}): Promise<void> {
  const model_run_id = input.context.model_run_store.getModelRunIdForJob(input.job_id)
  const model_run = model_run_id ? input.context.model_run_store.getModelRun(model_run_id) : undefined
  const model_dir = model_run_id ? input.context.model_run_store.getModelDir(model_run_id) : undefined
  const job_dir = input.context.job_store.getJobDir(input.job_id)
  if (!model_run_id || !model_run || !model_dir || !job_dir) {
    throw new Error("Create a SPICE run before debugging the spice_generation pipeline")
  }
  if (!input.context.model_run_store.claimModelExecution(model_run_id)) {
    throw new Error("The SPICE pipeline is already running")
  }
  const previous_state = {
    status: model_run.status,
    is_complete: model_run.is_complete,
    has_errors: model_run.has_errors,
    error_message: model_run.error_message,
    completed_at: model_run.completed_at,
  }
  const invocation_id = `debug-${crypto.randomUUID()}`
  const invocation_dir = join(model_dir, "runs", MODEL_PIPELINE.pipeline_id, invocation_id)
  const selected_stage_ids = selectedStageIds(MODEL_PIPELINE, input.target)
  try {
    await mkdir(invocation_dir, { recursive: true })
    const result = await runPipeline({
      definition: MODEL_PIPELINE,
      run_id: model_run_id,
      workspace_dir: invocation_dir,
      context: {
        model_run_id,
        job_id: input.job_id,
        job_dir,
        model_dir,
        use_openai: model_run.use_openai ?? input.context.use_openai ?? false,
        max_repair_attempts: Math.max(1, Math.min(8, model_run.effort_multiplier)),
        invocation_id,
      },
      services: createModelServices(input.context),
      target: input.target,
      signal: new AbortController().signal,
      on_snapshot: (snapshot) => {
        input.context.model_run_store.updateModelRun(model_run_id, {
          pipeline: mergeDebugSnapshot(
            model_run.pipeline,
            projectPublicPipelineSnapshot({
              snapshot,
              artifact_root: job_dir,
              private_roots: [model_dir, invocation_dir],
            }),
            selected_stage_ids,
          ),
        })
      },
    })
    input.context.model_run_store.updateModelRun(model_run_id, {
      ...previous_state,
      pipeline: mergeDebugSnapshot(
        model_run.pipeline,
        projectPublicPipelineSnapshot({
          snapshot: result,
          artifact_root: job_dir,
          private_roots: [model_dir, invocation_dir],
        }),
        selected_stage_ids,
      ),
    })
  } finally {
    input.context.model_run_store.releaseModelExecution(model_run_id)
  }
}

export function createPipelineDebugApiHandler(context: PipelineDebugApiContext) {
  const active_runs = new Set<string>()
  const launch = (active_key: string, run: Promise<void>): void => {
    active_runs.add(active_key)
    void run
      .catch((error) => {
        console.error("[pipeline-debug] invocation failed", {
          active_key,
          cause: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => active_runs.delete(active_key))
  }
  return async (request: Request): Promise<Response | undefined> => {
    const request_url = new URL(request.url)
    if (request_url.pathname === "/api/pipeline/catalog" && request.method === "GET") {
      return Response.json({ pipelines: PIPELINE_DEBUG_CATALOG })
    }
    if (request_url.pathname !== "/api/pipeline/debug-run") return undefined
    if (request.method !== "POST") return errorResponse(405, "method_not_allowed", "Use POST.")
    const parsed = parseRequest(await request.json().catch(() => undefined))
    if (!parsed) return errorResponse(400, "invalid_pipeline_debug_request", "Invalid debug-run request.")
    const job = context.job_store.getJob(parsed.job_id)
    const job_dir = context.job_store.getJobDir(parsed.job_id)
    if (!job || !job_dir) return errorResponse(404, "job_not_found", `No job exists for ${parsed.job_id}.`)
    if (!job.is_complete) {
      return errorResponse(409, "job_is_running", "Wait for the current generation run before debugging it.")
    }
    const active_key = `${parsed.job_id}:${parsed.pipeline_id}`
    if (active_runs.has(active_key)) {
      return errorResponse(409, "pipeline_is_running", `${parsed.pipeline_id} is already running.`)
    }
    try {
      if (parsed.pipeline_id === "component_generation") {
        const target = await createExecutionTarget<
          ComponentPipelineOutputs,
          ComponentPipelineContext,
          ComponentPipelineServices
        >({
          definition: COMPONENT_PIPELINE,
          mode: parsed.mode,
          stage_id: parsed.stage_id,
          snapshot: job.pipelines?.component_generation ?? job.pipeline,
          job_dir,
        })
        launch(
          active_key,
          runComponentDebugPipeline({
            definition: COMPONENT_PIPELINE,
            target,
            job_id: parsed.job_id,
            context,
            snapshot_key: "component_generation",
            base_snapshot: job.pipelines?.component_generation ?? job.pipeline,
          }),
        )
      } else if (parsed.pipeline_id === "typical_application") {
        const target = await createExecutionTarget<
          ApplicationPipelineOutputs,
          ComponentPipelineContext,
          ComponentPipelineServices
        >({
          definition: APPLICATION_PIPELINE,
          mode: parsed.mode,
          stage_id: parsed.stage_id,
          snapshot: job.pipelines?.typical_application,
          job_dir,
        })
        launch(
          active_key,
          runComponentDebugPipeline({
            definition: APPLICATION_PIPELINE,
            target,
            job_id: parsed.job_id,
            context,
            snapshot_key: "typical_application",
            base_snapshot: job.pipelines?.typical_application,
          }),
        )
      } else {
        const model_run_id = context.model_run_store.getModelRunIdForJob(parsed.job_id)
        const model_run = model_run_id ? context.model_run_store.getModelRun(model_run_id) : undefined
        if (!model_run) {
          return errorResponse(409, "spice_run_required", "Create a SPICE run before debugging it.")
        }
        const target = await createExecutionTarget<
          ModelPipelineOutputs,
          ModelPipelineContext,
          ModelPipelineServices
        >({
          definition: MODEL_PIPELINE,
          mode: parsed.mode,
          stage_id: parsed.stage_id,
          snapshot: model_run.pipeline,
          job_dir,
        })
        launch(active_key, runSpiceDebugPipeline({ target, job_id: parsed.job_id, context }))
      }
      return Response.json({ status: "started", pipeline_id: parsed.pipeline_id }, { status: 202 })
    } catch (error) {
      return errorResponse(
        409,
        "pipeline_debug_unavailable",
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}
