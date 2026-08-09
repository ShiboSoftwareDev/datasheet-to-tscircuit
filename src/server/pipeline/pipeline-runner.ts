import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { appendFile, mkdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  CreatePipelineArtifactInput,
  DeepReadonly,
  PipelineArtifact,
  PipelineDefinition,
  PipelineDependencyOutputs,
  PipelineDiagnostic,
  PipelineEvent,
  PipelineExecutionTarget,
  PipelineJsonValue,
  PipelineOutputMap,
  PipelineRunResult,
  PipelineRunSnapshot,
  PipelineRunStatus,
  PipelineSnapshotCallback,
  PipelineStageDefinition,
  PipelineStageMetrics,
  PipelineStageOutcome,
  PipelineStageResult,
  PipelineStageResults,
  PipelineTaskInputEnvelope,
  PipelineTaskInputFiles,
  RegisteredPipelineStage,
} from "@/shared/pipeline-types"
import { snapshotPipelineArtifacts } from "./artifact-snapshot"
import { getPipelineCauseChain, PipelineError, toPipelineError } from "./pipeline-error"
import { retainPipelineTaskInputFiles } from "./task-input-files"

const STABLE_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

type StageId<Outputs extends PipelineOutputMap> = keyof Outputs & string

type TerminalStageResult<Output> = Extract<
  PipelineStageResult<Output>,
  { readonly status: "completed" | "skipped" | "failed" | "cancelled" }
>

type PipelineEventInput = PipelineEvent extends infer Event
  ? Event extends PipelineEvent
    ? Omit<Event, "run_id" | "pipeline_id" | "sequence" | "timestamp">
    : never
  : never

type MutableStageResults<Outputs extends PipelineOutputMap> = Partial<
  Record<StageId<Outputs>, PipelineStageResult<Outputs[StageId<Outputs>]>>
>

interface StageDebugMetrics {
  readonly stage_id: string
  readonly status: string
  readonly started_at?: string
  readonly completed_at?: string
  readonly duration_ms?: number
  readonly artifact_count: number
  readonly diagnostic_count: number
  readonly stage_metrics: PipelineStageMetrics
}

export interface RunPipelineOptions<
  Outputs extends PipelineOutputMap,
  Context extends object,
  Services extends object,
> {
  readonly definition: PipelineDefinition<Outputs, Context, Services>
  readonly run_id: string
  readonly workspace_dir: string
  readonly context: Readonly<Context>
  readonly services: Readonly<Services>
  readonly target?: PipelineExecutionTarget<Outputs>
  readonly signal?: AbortSignal
  readonly on_snapshot?: PipelineSnapshotCallback<Outputs>
  readonly snapshot_timeout_ms?: number
  readonly now?: () => Date
  /**
   * Runtime coordination completed before the independently runnable task input
   * filesystem is captured. It must not perform task work or mutate task output.
   */
  readonly before_stage_start?: (input: {
    readonly stage_id: keyof Outputs & string
    readonly signal: AbortSignal
  }) => void | Promise<void>
  /** Filesystem root whose exact pre-task contents make this task independently replayable. */
  readonly task_input_root?: string
  /** Top-level task_input_root directories that are runtime services rather than task inputs. */
  readonly task_input_excluded_roots?: readonly string[]
}

const deepFreeze = <Value>(value: Value, seen = new WeakSet<object>()): DeepReadonly<Value> => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value) && !seen.has(value)) {
    seen.add(value)
    for (const child of Object.values(value)) deepFreeze(child, seen)
    Object.freeze(value)
  }
  return value as DeepReadonly<Value>
}

const writeJson = async (path: string, value: unknown): Promise<void> => {
  const json = JSON.stringify(value, null, 2)
  if (json === undefined) {
    throw new PipelineError({
      code: "debug_value_not_serializable",
      message: `Could not serialize debug value for ${path}`,
      stage_id: null,
      operation: "write_debug_bundle",
      artifact_refs: [{ path }],
    })
  }
  await writeFile(path, `${json}\n`, "utf8")
}

const serializeExecutionContext = (context: object): Readonly<Record<string, PipelineJsonValue>> => {
  const serialized = JSON.parse(JSON.stringify(context)) as unknown
  if (serialized === null || typeof serialized !== "object" || Array.isArray(serialized)) {
    throw new PipelineError({
      code: "task_context_not_serializable",
      message: "Pipeline task execution context must serialize to a JSON object",
      stage_id: null,
      operation: "serialize_task_input",
    })
  }
  return deepFreeze(serialized as Record<string, PipelineJsonValue>)
}

const getCancellationReason = (signal: AbortSignal): string => {
  if (signal.reason instanceof Error) return signal.reason.message
  if (typeof signal.reason === "string" && signal.reason.length > 0) {
    return signal.reason
  }
  return "Pipeline run was cancelled"
}

const getDuration = (started_ms: number, completed_ms: number): number =>
  Math.max(0, completed_ms - started_ms)

const emptyArtifacts = (): readonly PipelineArtifact[] => Object.freeze([])
const emptyDiagnostics = (): readonly PipelineDiagnostic[] => Object.freeze([])
const emptyMetrics = (): PipelineStageMetrics => Object.freeze({})

const validateArtifacts = (
  artifacts: readonly PipelineArtifact[],
  stage_id: string,
): readonly PipelineArtifact[] => {
  const artifact_ids = new Set<string>()
  for (const artifact of artifacts) {
    if (!artifact.artifact_id.trim()) {
      throw new PipelineError({
        code: "invalid_stage_artifact",
        message: `Stage ${stage_id} returned an artifact without an artifact_id`,
        stage_id,
        operation: "validate_stage_artifacts",
      })
    }
    if (artifact_ids.has(artifact.artifact_id)) {
      throw new PipelineError({
        code: "duplicate_stage_artifact_id",
        message: `Stage ${stage_id} returned duplicate artifact_id ${artifact.artifact_id}`,
        stage_id,
        operation: "validate_stage_artifacts",
        artifact_refs: [{ artifact_id: artifact.artifact_id, path: artifact.path }],
      })
    }
    if (!artifact.path.trim() || !SHA256_PATTERN.test(artifact.hash.value)) {
      throw new PipelineError({
        code: "invalid_stage_artifact",
        message: `Stage ${stage_id} returned invalid metadata for artifact ${artifact.artifact_id}`,
        stage_id,
        operation: "validate_stage_artifacts",
        artifact_refs: [{ artifact_id: artifact.artifact_id, path: artifact.path }],
      })
    }
    if (
      artifact.hash.algorithm !== "sha256" ||
      !Number.isInteger(artifact.size_bytes) ||
      artifact.size_bytes < 0 ||
      !artifact.media_type.includes("/") ||
      !artifact.role.trim()
    ) {
      throw new PipelineError({
        code: "invalid_stage_artifact",
        message: `Stage ${stage_id} returned invalid metadata for artifact ${artifact.artifact_id}`,
        stage_id,
        operation: "validate_stage_artifacts",
        artifact_refs: [{ artifact_id: artifact.artifact_id, path: artifact.path }],
      })
    }
    artifact_ids.add(artifact.artifact_id)
  }
  return deepFreeze([...artifacts])
}

const makeDebugDir = (
  pipeline_dir: string,
  stage_index: number,
  stage_count: number,
  stage_id: string,
): string => {
  const width = Math.max(2, String(stage_count).length)
  return join(pipeline_dir, "stages", `${String(stage_index + 1).padStart(width, "0")}-${stage_id}`)
}

const freezeResults = <Outputs extends PipelineOutputMap>(
  mutable_results: MutableStageResults<Outputs>,
): PipelineStageResults<Outputs> => Object.freeze({ ...mutable_results }) as PipelineStageResults<Outputs>

const getDependencyState = <
  Outputs extends PipelineOutputMap,
  Context extends object,
  Services extends object,
>(
  stage: RegisteredPipelineStage<Outputs, Context, Services>,
  results: MutableStageResults<Outputs>,
  provided_outputs?: Readonly<Record<string, PipelineJsonValue>>,
  inherited_outputs?: Readonly<Record<string, PipelineJsonValue>>,
): {
  readonly dependency_outputs: Readonly<Record<string, PipelineJsonValue>>
  readonly dependency_statuses: Readonly<Record<string, string>>
  readonly incomplete_dependencies: readonly string[]
} => {
  if (provided_outputs) {
    const required = new Set<string>(stage.depends_on)
    const provided = Object.keys(provided_outputs)
    const missing = stage.depends_on.filter((dependency_id) => !(dependency_id in provided_outputs))
    const unexpected = provided.filter((dependency_id) => !required.has(dependency_id))
    if (missing.length > 0 || unexpected.length > 0) {
      throw new PipelineError({
        code: "invalid_isolated_stage_input",
        message: [
          `The isolated input for ${stage.id} does not match its declared dependencies.`,
          ...(missing.length > 0 ? [`Missing: ${missing.join(", ")}.`] : []),
          ...(unexpected.length > 0 ? [`Unexpected: ${unexpected.join(", ")}.`] : []),
        ].join(" "),
        stage_id: stage.id,
        operation: "resolve_isolated_stage_input",
        entity_refs: [...missing, ...unexpected].map((dependency_id) => ({
          entity_type: "pipeline_stage",
          entity_id: dependency_id,
        })),
        hint: "Use the dependency_outputs from this stage's persisted input.json bundle.",
      })
    }
    return {
      dependency_outputs: deepFreeze({ ...provided_outputs }),
      dependency_statuses: deepFreeze(
        Object.fromEntries(stage.depends_on.map((dependency_id) => [dependency_id, "provided"])),
      ),
      incomplete_dependencies: Object.freeze([]),
    }
  }

  const dependency_outputs: Record<string, PipelineJsonValue> = {}
  const dependency_statuses: Record<string, string> = {}
  const incomplete_dependencies: string[] = []

  for (const dependency_id of stage.depends_on) {
    const result = results[dependency_id]
    if (!result) {
      throw new PipelineError({
        code: "missing_dependency_result",
        message: `No result exists for dependency ${dependency_id} of stage ${stage.id}`,
        stage_id: stage.id,
        operation: "resolve_stage_dependencies",
      })
    }
    dependency_statuses[dependency_id] = result.status
    if (result.status === "completed") {
      dependency_outputs[dependency_id] = result.output
    } else if (inherited_outputs && dependency_id in inherited_outputs) {
      dependency_statuses[dependency_id] = "provided"
      dependency_outputs[dependency_id] = inherited_outputs[dependency_id]!
    } else {
      incomplete_dependencies.push(dependency_id)
    }
  }

  return {
    dependency_outputs: deepFreeze(dependency_outputs),
    dependency_statuses: deepFreeze(dependency_statuses),
    incomplete_dependencies: Object.freeze(incomplete_dependencies),
  }
}

const writeInitialDebugBundle = async (
  debug_dir: string,
  input: PipelineTaskInputEnvelope,
  started_at?: string,
): Promise<void> => {
  await mkdir(debug_dir, { recursive: true })
  await Promise.all([
    writeJson(join(debug_dir, "input.json"), input),
    writeJson(join(debug_dir, "output.json"), null),
    writeJson(join(debug_dir, "error.json"), null),
    writeJson(join(debug_dir, "metrics.json"), {
      stage_id: input.task_id,
      status: started_at === undefined ? "pending" : "running",
      ...(started_at === undefined ? {} : { started_at }),
      artifact_count: 0,
      diagnostic_count: 0,
      stage_metrics: {},
    } satisfies StageDebugMetrics),
  ])
}

const writeTerminalDebugBundle = async (
  debug_dir: string,
  result: TerminalStageResult<PipelineJsonValue>,
): Promise<void> => {
  const output =
    result.status === "completed"
      ? {
          status: result.status,
          output: result.output,
          artifacts: result.artifacts,
          diagnostics: result.diagnostics,
        }
      : {
          status: result.status,
          artifacts: result.artifacts,
          diagnostics: result.diagnostics,
        }
  const error = result.status === "failed" ? result.error : null
  const metrics = {
    stage_id: result.stage_id,
    status: result.status,
    completed_at: result.completed_at,
    ...(result.status === "completed" || result.status === "failed"
      ? { started_at: result.started_at }
      : !("started_at" in result) || result.started_at === undefined
        ? {}
        : { started_at: result.started_at }),
    ...(result.status === "completed" || result.status === "failed"
      ? { duration_ms: result.duration_ms }
      : !("duration_ms" in result) || result.duration_ms === undefined
        ? {}
        : { duration_ms: result.duration_ms }),
    artifact_count: result.artifacts.length,
    diagnostic_count: result.diagnostics.length,
    stage_metrics: result.metrics,
  } satisfies StageDebugMetrics

  await Promise.all([
    writeJson(join(debug_dir, "output.json"), output),
    writeJson(join(debug_dir, "metrics.json"), metrics),
    writeJson(join(debug_dir, "error.json"), error),
  ])
}

export const createPipelineStageFactory =
  <Outputs extends PipelineOutputMap, Context extends object, Services extends object>() =>
  <StageIdValue extends StageId<Outputs>, const Dependencies extends readonly StageId<Outputs>[]>(
    definition: PipelineStageDefinition<Outputs, Context, Services, StageIdValue, Dependencies>,
  ): PipelineStageDefinition<Outputs, Context, Services, StageIdValue, Dependencies> => {
    Object.freeze(definition.depends_on)
    return Object.freeze(definition)
  }

export const validatePipelineDefinition = <
  Outputs extends PipelineOutputMap,
  Context extends object,
  Services extends object,
>(
  definition: PipelineDefinition<Outputs, Context, Services>,
): void => {
  if (!STABLE_ID_PATTERN.test(definition.pipeline_id)) {
    throw new PipelineError({
      code: "invalid_pipeline_id",
      message: `Pipeline id must be stable snake_case: ${definition.pipeline_id}`,
      stage_id: null,
      operation: "validate_pipeline_definition",
      hint: "Use lowercase letters, digits, and single underscores.",
    })
  }
  if (definition.stages.length === 0) {
    throw new PipelineError({
      code: "pipeline_has_no_stages",
      message: `Pipeline ${definition.pipeline_id} has no stages`,
      stage_id: null,
      operation: "validate_pipeline_definition",
    })
  }

  const seen_stage_ids = new Set<string>()
  for (const stage of definition.stages) {
    if (!STABLE_ID_PATTERN.test(stage.id)) {
      throw new PipelineError({
        code: "invalid_stage_id",
        message: `Stage id must be stable snake_case: ${stage.id}`,
        stage_id: stage.id,
        operation: "validate_pipeline_definition",
        hint: "Use lowercase letters, digits, and single underscores.",
      })
    }
    if (seen_stage_ids.has(stage.id)) {
      throw new PipelineError({
        code: "duplicate_stage_id",
        message: `Pipeline ${definition.pipeline_id} contains duplicate stage ${stage.id}`,
        stage_id: stage.id,
        operation: "validate_pipeline_definition",
      })
    }

    const seen_dependencies = new Set<string>()
    for (const dependency_id of stage.depends_on) {
      if (seen_dependencies.has(dependency_id)) {
        throw new PipelineError({
          code: "duplicate_stage_dependency",
          message: `Stage ${stage.id} declares dependency ${dependency_id} more than once`,
          stage_id: stage.id,
          operation: "validate_pipeline_definition",
          entity_refs: [{ entity_type: "pipeline_stage", entity_id: dependency_id }],
        })
      }
      if (!seen_stage_ids.has(dependency_id)) {
        throw new PipelineError({
          code: "stage_dependency_not_prior",
          message: `Stage ${stage.id} depends on ${dependency_id}, which is not an earlier stage`,
          stage_id: stage.id,
          operation: "validate_pipeline_definition",
          entity_refs: [{ entity_type: "pipeline_stage", entity_id: dependency_id }],
          hint: "Declare every dependency before the stage that consumes it.",
        })
      }
      seen_dependencies.add(dependency_id)
    }
    seen_stage_ids.add(stage.id)
  }
}

export const createPipelineArtifact = async (
  input: CreatePipelineArtifactInput,
): Promise<PipelineArtifact> => {
  const file_stat = await stat(input.path)
  if (!file_stat.isFile()) {
    throw new PipelineError({
      code: "artifact_is_not_file",
      message: `Pipeline artifact is not a file: ${input.path}`,
      stage_id: null,
      operation: "create_pipeline_artifact",
      artifact_refs: [{ artifact_id: input.artifact_id, path: input.path }],
    })
  }
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(input.path)) hash.update(chunk)

  return deepFreeze({
    artifact_id: input.artifact_id,
    path: input.path,
    hash: {
      algorithm: "sha256" as const,
      value: hash.digest("hex"),
    },
    size_bytes: file_stat.size,
    media_type: input.media_type,
    role: input.role,
  })
}

export const runPipeline = async <
  Outputs extends PipelineOutputMap,
  Context extends object,
  Services extends object,
>(
  options: RunPipelineOptions<Outputs, Context, Services>,
): Promise<PipelineRunResult<Outputs>> => {
  const stages = Object.freeze([...options.definition.stages])
  validatePipelineDefinition({
    pipeline_id: options.definition.pipeline_id,
    stages,
  })

  const now = options.now ?? (() => new Date())
  const target = options.target ?? ({ mode: "pipeline" } as const)
  const target_index =
    target.mode === "pipeline" ? 0 : stages.findIndex((stage) => stage.id === target.stage_id)
  if (target_index < 0) {
    throw new PipelineError({
      code: "pipeline_stage_not_found",
      message: `Pipeline ${options.definition.pipeline_id} has no stage ${target.mode === "pipeline" ? "" : target.stage_id}`,
      stage_id: target.mode === "pipeline" ? null : target.stage_id,
      operation: "select_pipeline_execution_target",
    })
  }
  const signal = options.signal ?? new AbortController().signal
  const executionContext = serializeExecutionContext(options.context)
  const pipeline_dir = join(options.workspace_dir, ".pipeline")
  const events_path = join(pipeline_dir, "events.ndjson")
  const observer_errors_path = join(pipeline_dir, "observer-errors.ndjson")
  await mkdir(join(pipeline_dir, "stages"), { recursive: true })

  const started_at = now().toISOString()
  const mutable_results: MutableStageResults<Outputs> = {}
  const stage_count = stages.length
  for (const [index, stage] of stages.entries()) {
    mutable_results[stage.id] = Object.freeze({
      stage_id: stage.id,
      debug_dir: makeDebugDir(pipeline_dir, index, stage_count, stage.id),
      status: "pending",
      artifacts: emptyArtifacts(),
      diagnostics: emptyDiagnostics(),
      metrics: emptyMetrics(),
    })
  }

  let sequence = 0
  let run_status: PipelineRunStatus = "running"

  const snapshot = (updated_at: string): PipelineRunSnapshot<Outputs> =>
    Object.freeze({
      run_id: options.run_id,
      pipeline_id: options.definition.pipeline_id,
      status: run_status,
      sequence,
      started_at,
      updated_at,
      stage_results: freezeResults(mutable_results),
    })

  const emit = async (event: PipelineEventInput): Promise<void> => {
    const timestamp = now().toISOString()
    sequence += 1
    const persisted_event = deepFreeze({
      ...event,
      run_id: options.run_id,
      pipeline_id: options.definition.pipeline_id,
      sequence,
      timestamp,
    }) as PipelineEvent
    await appendFile(events_path, `${JSON.stringify(persisted_event)}\n`, "utf8")
    try {
      if (options.on_snapshot) {
        const timeout_ms = Math.max(1, options.snapshot_timeout_ms ?? 5_000)
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            Promise.resolve().then(() => options.on_snapshot?.(snapshot(timestamp))),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () => reject(new Error(`Pipeline snapshot observer exceeded ${timeout_ms} ms`)),
                timeout_ms,
              )
            }),
          ])
        } finally {
          if (timeout) clearTimeout(timeout)
        }
      }
    } catch (error) {
      const observer_error = error instanceof Error ? error : new Error(String(error))
      await appendFile(
        observer_errors_path,
        `${JSON.stringify({
          timestamp,
          sequence,
          event_type: persisted_event.event_type,
          name: observer_error.name,
          message: observer_error.message,
          stack: observer_error.stack,
        })}\n`,
        "utf8",
      ).catch(() => undefined)
    }
  }

  await emit({ event_type: "pipeline_started", status: "running" })

  let has_failed_stage = false
  let has_cancelled_stage = false
  let has_committed_stage = false

  const recordPostCommitTraceFailure = async (input: {
    stage_id: string
    operation: string
    error: unknown
  }): Promise<void> => {
    const trace_error = input.error instanceof Error ? input.error : new Error(String(input.error))
    await appendFile(
      observer_errors_path,
      `${JSON.stringify({
        timestamp: now().toISOString(),
        sequence,
        event_type: "post_commit_trace_failure",
        stage_id: input.stage_id,
        operation: input.operation,
        name: trace_error.name,
        message: trace_error.message,
        stack: trace_error.stack,
      })}\n`,
      "utf8",
    ).catch(() => undefined)
  }

  for (const [stage_index, stage] of stages.entries()) {
    const prior_result = mutable_results[stage.id]
    if (!prior_result) {
      throw new PipelineError({
        code: "missing_stage_result",
        message: `No pending result exists for stage ${stage.id}`,
        stage_id: stage.id,
        operation: "run_pipeline",
      })
    }
    const debug_dir = prior_result.debug_dir
    const selected =
      target.mode === "pipeline" ||
      stage_index === target_index ||
      (target.mode === "from_stage" && stage_index > target_index)
    if (!selected) {
      const is_continuation_candidate = stage_index > target_index
      const dependency_state = is_continuation_candidate
        ? getDependencyState(stage, mutable_results, undefined, target.dependency_outputs)
        : undefined
      let input_files: PipelineTaskInputFiles | undefined
      if (dependency_state?.incomplete_dependencies.length === 0 && options.task_input_root) {
        await mkdir(debug_dir, { recursive: true })
        input_files = await retainPipelineTaskInputFiles({
          root_dir: options.task_input_root,
          debug_dir,
          objects_dir: join(pipeline_dir, "input-objects"),
          excluded_roots: options.task_input_excluded_roots,
        })
      }
      const completed_at = now().toISOString()
      const reason = "Stage was not selected for this isolated pipeline invocation"
      const result = Object.freeze({
        stage_id: stage.id,
        debug_dir,
        status: "skipped" as const,
        reason,
        completed_at,
        artifacts: emptyArtifacts(),
        diagnostics: emptyDiagnostics(),
        metrics: emptyMetrics(),
      })
      mutable_results[stage.id] = result
      const debug_input = deepFreeze({
        version: 2,
        kind: "pipeline_task_input",
        pipeline_id: options.definition.pipeline_id,
        task_id: stage.id,
        run_id: options.run_id,
        execution_context: executionContext,
        depends_on: [...stage.depends_on],
        dependency_statuses: dependency_state?.dependency_statuses ?? {},
        dependency_outputs: dependency_state?.dependency_outputs ?? {},
        ...(input_files ? { input_files } : {}),
      } satisfies PipelineTaskInputEnvelope)
      await writeInitialDebugBundle(debug_dir, debug_input)
      await writeTerminalDebugBundle(debug_dir, result)
      await emit({
        event_type: "stage_skipped",
        stage_id: stage.id,
        status: "skipped",
        debug_dir,
        reason,
      })
      continue
    }
    const provided_outputs =
      target.mode !== "pipeline" && stage_index === target_index ? target.dependency_outputs : undefined
    const dependency_state = getDependencyState(
      stage,
      mutable_results,
      provided_outputs,
      target.mode === "pipeline" ? undefined : target.dependency_outputs,
    )
    const debug_input = deepFreeze({
      version: 2,
      kind: "pipeline_task_input",
      pipeline_id: options.definition.pipeline_id,
      task_id: stage.id,
      run_id: options.run_id,
      execution_context: executionContext,
      depends_on: [...stage.depends_on],
      dependency_statuses: dependency_state.dependency_statuses,
      dependency_outputs: dependency_state.dependency_outputs,
    } satisfies PipelineTaskInputEnvelope)

    if (signal.aborted || has_cancelled_stage) {
      const completed_at = now().toISOString()
      const reason = getCancellationReason(signal)
      const result = Object.freeze({
        stage_id: stage.id,
        debug_dir,
        status: "cancelled" as const,
        reason,
        completed_at,
        artifacts: emptyArtifacts(),
        diagnostics: emptyDiagnostics(),
        metrics: emptyMetrics(),
      })
      mutable_results[stage.id] = result
      has_cancelled_stage = true
      await writeInitialDebugBundle(debug_dir, debug_input)
      await writeTerminalDebugBundle(debug_dir, result)
      await emit({
        event_type: "stage_cancelled",
        stage_id: stage.id,
        status: "cancelled",
        debug_dir,
        reason,
      })
      continue
    }

    if (dependency_state.incomplete_dependencies.length > 0) {
      const completed_at = now().toISOString()
      const dependencies = dependency_state.incomplete_dependencies.join(", ")
      const reason = `Dependencies did not complete: ${dependencies}`
      const diagnostic = deepFreeze({
        code: "dependency_not_completed",
        severity: "warning" as const,
        message: reason,
        stage_id: stage.id,
        operation: "resolve_stage_dependencies",
        entity_refs: dependency_state.incomplete_dependencies.map((dependency_id) => ({
          entity_type: "pipeline_stage",
          entity_id: dependency_id,
        })),
        artifact_refs: [],
        cause_chain: [],
        hint: "Inspect the dependency stage result and its debug bundle.",
        retryable: false,
      })
      const result = Object.freeze({
        stage_id: stage.id,
        debug_dir,
        status: "skipped" as const,
        reason,
        completed_at,
        artifacts: emptyArtifacts(),
        diagnostics: Object.freeze([diagnostic]),
        metrics: emptyMetrics(),
      })
      mutable_results[stage.id] = result
      await writeInitialDebugBundle(debug_dir, debug_input)
      await writeTerminalDebugBundle(debug_dir, result)
      await emit({
        event_type: "stage_skipped",
        stage_id: stage.id,
        status: "skipped",
        debug_dir,
        reason,
      })
      continue
    }

    await options.before_stage_start?.({ stage_id: stage.id, signal })
    if (signal.aborted) {
      const completed_at = now().toISOString()
      const reason = getCancellationReason(signal)
      const result = Object.freeze({
        stage_id: stage.id,
        debug_dir,
        status: "cancelled" as const,
        reason,
        completed_at,
        artifacts: emptyArtifacts(),
        diagnostics: emptyDiagnostics(),
        metrics: emptyMetrics(),
      })
      mutable_results[stage.id] = result
      has_cancelled_stage = true
      await writeInitialDebugBundle(debug_dir, debug_input)
      await writeTerminalDebugBundle(debug_dir, result)
      await emit({
        event_type: "stage_cancelled",
        stage_id: stage.id,
        status: "cancelled",
        debug_dir,
        reason,
      })
      continue
    }

    const started_ms = now().getTime()
    const stage_started_at = new Date(started_ms).toISOString()
    await mkdir(debug_dir, { recursive: true })
    const input_files = options.task_input_root
      ? await retainPipelineTaskInputFiles({
          root_dir: options.task_input_root,
          debug_dir,
          objects_dir: join(pipeline_dir, "input-objects"),
          excluded_roots: options.task_input_excluded_roots,
        })
      : undefined
    const runnable_debug_input = deepFreeze({
      ...debug_input,
      ...(input_files ? { input_files } : {}),
    } satisfies PipelineTaskInputEnvelope)
    mutable_results[stage.id] = Object.freeze({
      stage_id: stage.id,
      debug_dir,
      status: "running",
      started_at: stage_started_at,
      artifacts: emptyArtifacts(),
      diagnostics: emptyDiagnostics(),
      metrics: emptyMetrics(),
    })
    await writeInitialDebugBundle(debug_dir, runnable_debug_input, stage_started_at)
    await emit({
      event_type: "stage_started",
      stage_id: stage.id,
      status: "running",
      debug_dir,
    })

    let crossed_commit_barrier = false
    let committed_outcome: Extract<
      PipelineStageOutcome<Outputs[typeof stage.id]>,
      { readonly status: "completed" }
    > | null = null
    let committed_output: DeepReadonly<Outputs[typeof stage.id]> | null = null
    let committed_artifacts: readonly PipelineArtifact[] = emptyArtifacts()
    let committed_diagnostics: readonly PipelineDiagnostic[] = emptyDiagnostics()
    let committed_metrics: PipelineStageMetrics = emptyMetrics()
    try {
      const outcome = (await stage.execute({
        run_id: options.run_id,
        pipeline_id: options.definition.pipeline_id,
        stage_id: stage.id,
        debug_dir,
        context: options.context,
        services: options.services,
        dependency_outputs: dependency_state.dependency_outputs as PipelineDependencyOutputs<
          Outputs,
          typeof stage.depends_on
        >,
        signal,
      })) as PipelineStageOutcome<Outputs[typeof stage.id]>

      const completed_ms = now().getTime()
      const completed_at = new Date(completed_ms).toISOString()
      const duration_ms = getDuration(started_ms, completed_ms)

      crossed_commit_barrier = outcome.status === "completed" && outcome.commit_state === "committed"
      if (crossed_commit_barrier && outcome.status === "completed") {
        has_committed_stage = true
        committed_outcome = outcome
        committed_output = deepFreeze(outcome.output)
      }
      if (signal.aborted && !crossed_commit_barrier) {
        const reason = getCancellationReason(signal)
        const result = Object.freeze({
          stage_id: stage.id,
          debug_dir,
          status: "cancelled" as const,
          reason,
          started_at: stage_started_at,
          completed_at,
          duration_ms,
          artifacts: emptyArtifacts(),
          diagnostics: emptyDiagnostics(),
          metrics: emptyMetrics(),
        })
        mutable_results[stage.id] = result
        has_cancelled_stage = true
        await writeTerminalDebugBundle(debug_dir, result)
        await emit({
          event_type: "stage_cancelled",
          stage_id: stage.id,
          status: "cancelled",
          debug_dir,
          reason,
        })
        continue
      }

      const declared_artifacts = validateArtifacts(outcome.artifacts ?? [], stage.id)
      const artifacts = await snapshotPipelineArtifacts({
        artifacts: declared_artifacts,
        debug_dir,
        stage_id: stage.id,
      })
      const diagnostics = deepFreeze([...(outcome.diagnostics ?? [])])
      const metrics = deepFreeze({ ...(outcome.metrics ?? {}) })
      if (crossed_commit_barrier) {
        committed_artifacts = artifacts
        committed_diagnostics = diagnostics
        committed_metrics = metrics
      }

      if (outcome.status === "skipped") {
        const result = Object.freeze({
          stage_id: stage.id,
          debug_dir,
          status: "skipped" as const,
          reason: outcome.reason,
          started_at: stage_started_at,
          completed_at,
          duration_ms,
          artifacts,
          diagnostics,
          metrics,
        })
        mutable_results[stage.id] = result
        await writeTerminalDebugBundle(debug_dir, result)
        await emit({
          event_type: "stage_skipped",
          stage_id: stage.id,
          status: "skipped",
          debug_dir,
          reason: outcome.reason,
        })
        continue
      }

      const result = Object.freeze({
        stage_id: stage.id,
        debug_dir,
        status: "completed" as const,
        output: deepFreeze(outcome.output),
        started_at: stage_started_at,
        completed_at,
        duration_ms,
        artifacts,
        diagnostics,
        metrics,
      })
      mutable_results[stage.id] = result
      await writeTerminalDebugBundle(debug_dir, result)
      await emit({
        event_type: "stage_completed",
        stage_id: stage.id,
        status: "completed",
        debug_dir,
        duration_ms,
      })
    } catch (error) {
      const completed_ms = now().getTime()
      const completed_at = new Date(completed_ms).toISOString()
      const duration_ms = getDuration(started_ms, completed_ms)

      if (crossed_commit_barrier && committed_outcome) {
        const trace_diagnostic = deepFreeze({
          code: "post_commit_trace_failure",
          severity: "warning" as const,
          message:
            "The stage publication committed successfully, but its terminal trace could not be fully recorded.",
          stage_id: stage.id,
          operation: "record_committed_stage_result",
          entity_refs: [],
          artifact_refs: [],
          cause_chain: getPipelineCauseChain(error),
          hint: "Inspect observer-errors.ndjson and verify storage health. The committed publication remains authoritative.",
          retryable: false,
        })
        const result = Object.freeze({
          stage_id: stage.id,
          debug_dir,
          status: "completed" as const,
          output: committed_output ?? deepFreeze(committed_outcome.output),
          started_at: stage_started_at,
          completed_at,
          duration_ms,
          artifacts: committed_artifacts,
          diagnostics: Object.freeze([...committed_diagnostics, trace_diagnostic]),
          metrics: committed_metrics,
        })
        mutable_results[stage.id] = result
        await recordPostCommitTraceFailure({
          stage_id: stage.id,
          operation: "record_committed_stage_result",
          error,
        })
        await writeTerminalDebugBundle(debug_dir, result).catch((trace_error) =>
          recordPostCommitTraceFailure({
            stage_id: stage.id,
            operation: "write_committed_stage_debug_bundle",
            error: trace_error,
          }),
        )
        continue
      }

      if (signal.aborted && !crossed_commit_barrier) {
        const reason = getCancellationReason(signal)
        const result = Object.freeze({
          stage_id: stage.id,
          debug_dir,
          status: "cancelled" as const,
          reason,
          started_at: stage_started_at,
          completed_at,
          duration_ms,
          artifacts: emptyArtifacts(),
          diagnostics: emptyDiagnostics(),
          metrics: emptyMetrics(),
        })
        mutable_results[stage.id] = result
        has_cancelled_stage = true
        await writeTerminalDebugBundle(debug_dir, result)
        await emit({
          event_type: "stage_cancelled",
          stage_id: stage.id,
          status: "cancelled",
          debug_dir,
          reason,
        })
        continue
      }

      const pipeline_error = toPipelineError(error, {
        code: "stage_execution_failed",
        fallback_message: `Stage ${stage.id} failed`,
        stage_id: stage.id,
        operation: "execute_stage",
        retryable: false,
      })
      const diagnostic = pipeline_error.diagnostic
      const result = Object.freeze({
        stage_id: stage.id,
        debug_dir,
        status: "failed" as const,
        error: diagnostic,
        started_at: stage_started_at,
        completed_at,
        duration_ms,
        artifacts: emptyArtifacts(),
        diagnostics: Object.freeze([diagnostic]),
        metrics: emptyMetrics(),
      })
      mutable_results[stage.id] = result
      has_failed_stage = true
      await writeTerminalDebugBundle(debug_dir, result)
      await emit({
        event_type: "stage_failed",
        stage_id: stage.id,
        status: "failed",
        debug_dir,
        diagnostic,
      })
    }
  }

  run_status = has_cancelled_stage ? "cancelled" : has_failed_stage ? "failed" : "completed"
  const completed_at = now().toISOString()
  try {
    await emit({
      event_type:
        run_status === "completed"
          ? "pipeline_completed"
          : run_status === "failed"
            ? "pipeline_failed"
            : "pipeline_cancelled",
      status: run_status,
    })
  } catch (error) {
    if (!has_committed_stage) throw error
    await recordPostCommitTraceFailure({
      stage_id: "pipeline",
      operation: "record_pipeline_terminal_event",
      error,
    })
  }

  return Object.freeze({
    ...snapshot(completed_at),
    status: run_status,
    completed_at,
    pipeline_dir,
    events_path,
  })
}
