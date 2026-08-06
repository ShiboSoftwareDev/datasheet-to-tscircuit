export type PipelineJsonPrimitive = string | number | boolean | null

export type PipelineJsonValue =
  | PipelineJsonPrimitive
  | { readonly [key: string]: PipelineJsonValue }
  | readonly PipelineJsonValue[]

export type PipelineOutputMap = Readonly<Record<string, PipelineJsonValue>>

export interface PipelineTaskInputFiles {
  readonly kind: "pipeline_task_files"
  /** Relative to the directory containing input.json. */
  readonly manifest_path: "input-files.json"
  /** Relative to the directory containing input.json. */
  readonly objects_path: "../../input-objects"
}

/**
 * The complete serializable input required to execute one pipeline task again.
 * Runtime services such as process launchers and credentials are deliberately
 * excluded; all workflow state belongs in this envelope.
 */
export interface PipelineTaskInputEnvelope {
  readonly version: 2
  readonly kind: "pipeline_task_input"
  readonly pipeline_id: string
  readonly task_id: string
  readonly run_id: string
  readonly execution_context: Readonly<Record<string, PipelineJsonValue>>
  readonly depends_on: readonly string[]
  readonly dependency_statuses: Readonly<Record<string, string>>
  readonly dependency_outputs: Readonly<Record<string, PipelineJsonValue>>
  /** Present only when this retained task has a complete independently runnable input bundle. */
  readonly input_files?: PipelineTaskInputFiles
}

export type DeepReadonly<Value> = Value extends PipelineJsonPrimitive
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value

export type PipelineStageStatus = "pending" | "running" | "completed" | "skipped" | "failed" | "cancelled"

export type PipelineRunStatus = "running" | "completed" | "failed" | "cancelled"

export interface PipelineArtifactHash {
  readonly algorithm: "sha256"
  readonly value: string
}

export interface PipelineArtifact {
  readonly artifact_id: string
  readonly path: string
  readonly hash: PipelineArtifactHash
  readonly size_bytes: number
  readonly media_type: string
  readonly role: string
}

export interface PipelineDiagnosticCause {
  readonly name: string
  readonly message: string
  readonly stack?: string
}

export interface PipelineEntityReference {
  readonly entity_type: string
  readonly entity_id: string
}

export interface PipelineArtifactReference {
  readonly artifact_id?: string
  readonly path?: string
}

export interface PipelineDiagnostic {
  readonly code: string
  readonly severity: "info" | "warning" | "error"
  readonly message: string
  readonly stage_id: string | null
  readonly operation: string
  readonly entity_refs: readonly PipelineEntityReference[]
  readonly artifact_refs: readonly PipelineArtifactReference[]
  readonly cause_chain: readonly PipelineDiagnosticCause[]
  readonly hint?: string
  readonly retryable: boolean
}

export type PipelineStageMetricValue = string | number | boolean | null

export type PipelineStageMetrics = Readonly<Record<string, PipelineStageMetricValue>>

interface PipelineStageResultBase {
  readonly stage_id: string
  readonly debug_dir: string
  readonly artifacts: readonly PipelineArtifact[]
  readonly diagnostics: readonly PipelineDiagnostic[]
  readonly metrics: PipelineStageMetrics
}

export interface PipelineStagePendingResult extends PipelineStageResultBase {
  readonly status: "pending"
}

export interface PipelineStageRunningResult extends PipelineStageResultBase {
  readonly status: "running"
  readonly started_at: string
}

export interface PipelineStageCompletedResult<Output> extends PipelineStageResultBase {
  readonly status: "completed"
  readonly output: DeepReadonly<Output>
  readonly started_at: string
  readonly completed_at: string
  readonly duration_ms: number
}

export interface PipelineStageSkippedResult extends PipelineStageResultBase {
  readonly status: "skipped"
  readonly reason: string
  readonly completed_at: string
  readonly started_at?: string
  readonly duration_ms?: number
}

export interface PipelineStageFailedResult extends PipelineStageResultBase {
  readonly status: "failed"
  readonly error: PipelineDiagnostic
  readonly started_at: string
  readonly completed_at: string
  readonly duration_ms: number
}

export interface PipelineStageCancelledResult extends PipelineStageResultBase {
  readonly status: "cancelled"
  readonly reason: string
  readonly completed_at: string
  readonly started_at?: string
  readonly duration_ms?: number
}

export type PipelineStageResult<Output> =
  | PipelineStagePendingResult
  | PipelineStageRunningResult
  | PipelineStageCompletedResult<Output>
  | PipelineStageSkippedResult
  | PipelineStageFailedResult
  | PipelineStageCancelledResult

export type PipelineStageResults<Outputs extends PipelineOutputMap> = {
  readonly [StageId in keyof Outputs]: PipelineStageResult<Outputs[StageId]>
}

export interface PipelineStageCompletedOutcome<Output> {
  readonly status: "completed"
  readonly output: Output
  /** Set only after an irreversible publication has crossed its cancellation barrier. */
  readonly commit_state?: "committed"
  readonly artifacts?: readonly PipelineArtifact[]
  readonly diagnostics?: readonly PipelineDiagnostic[]
  readonly metrics?: PipelineStageMetrics
}

export interface PipelineStageSkippedOutcome {
  readonly status: "skipped"
  readonly reason: string
  readonly artifacts?: readonly PipelineArtifact[]
  readonly diagnostics?: readonly PipelineDiagnostic[]
  readonly metrics?: PipelineStageMetrics
}

export type PipelineStageOutcome<Output> = PipelineStageCompletedOutcome<Output> | PipelineStageSkippedOutcome

export type PipelineDependencyOutputs<
  Outputs extends PipelineOutputMap,
  Dependencies extends readonly (keyof Outputs & string)[],
> = DeepReadonly<Pick<Outputs, Dependencies[number]>>

export interface PipelineStageExecutionInput<
  Outputs extends PipelineOutputMap,
  Context extends object,
  Services extends object,
  StageId extends keyof Outputs & string,
  Dependencies extends readonly (keyof Outputs & string)[],
> {
  readonly run_id: string
  readonly pipeline_id: string
  readonly stage_id: StageId
  readonly debug_dir: string
  readonly context: Readonly<Context>
  readonly services: Readonly<Services>
  readonly dependency_outputs: PipelineDependencyOutputs<Outputs, Dependencies>
  readonly signal: AbortSignal
}

export interface PipelineStageDefinition<
  Outputs extends PipelineOutputMap,
  Context extends object,
  Services extends object,
  StageId extends keyof Outputs & string,
  Dependencies extends readonly (keyof Outputs & string)[],
> {
  readonly id: StageId
  readonly depends_on: Dependencies
  execute(
    input: PipelineStageExecutionInput<Outputs, Context, Services, StageId, Dependencies>,
  ): PipelineStageOutcome<Outputs[StageId]> | Promise<PipelineStageOutcome<Outputs[StageId]>>
}

export type RegisteredPipelineStage<
  Outputs extends PipelineOutputMap,
  Context extends object,
  Services extends object,
> = PipelineStageDefinition<
  Outputs,
  Context,
  Services,
  keyof Outputs & string,
  readonly (keyof Outputs & string)[]
>

export interface PipelineDefinition<
  Outputs extends PipelineOutputMap,
  Context extends object,
  Services extends object,
> {
  readonly pipeline_id: string
  readonly stages: readonly RegisteredPipelineStage<Outputs, Context, Services>[]
}

export type PipelineExecutionTarget<Outputs extends PipelineOutputMap> =
  | {
      readonly mode: "pipeline"
    }
  | {
      /** Execute exactly one stage with an explicit, persisted dependency input. */
      readonly mode: "stage"
      readonly stage_id: keyof Outputs & string
      readonly dependency_outputs: Readonly<Record<string, PipelineJsonValue>>
    }
  | {
      /** Execute the selected stage and every stage after it. */
      readonly mode: "from_stage"
      readonly stage_id: keyof Outputs & string
      readonly dependency_outputs: Readonly<Record<string, PipelineJsonValue>>
    }

interface PipelineEventBase {
  readonly run_id: string
  readonly pipeline_id: string
  readonly sequence: number
  readonly timestamp: string
}

export type PipelineEvent =
  | (PipelineEventBase & {
      readonly event_type: "pipeline_started"
      readonly status: "running"
    })
  | (PipelineEventBase & {
      readonly event_type: "stage_started"
      readonly stage_id: string
      readonly status: "running"
      readonly debug_dir: string
    })
  | (PipelineEventBase & {
      readonly event_type: "stage_completed"
      readonly stage_id: string
      readonly status: "completed"
      readonly debug_dir: string
      readonly duration_ms: number
    })
  | (PipelineEventBase & {
      readonly event_type: "stage_skipped"
      readonly stage_id: string
      readonly status: "skipped"
      readonly debug_dir: string
      readonly reason: string
    })
  | (PipelineEventBase & {
      readonly event_type: "stage_failed"
      readonly stage_id: string
      readonly status: "failed"
      readonly debug_dir: string
      readonly diagnostic: PipelineDiagnostic
    })
  | (PipelineEventBase & {
      readonly event_type: "stage_cancelled"
      readonly stage_id: string
      readonly status: "cancelled"
      readonly debug_dir: string
      readonly reason: string
    })
  | (PipelineEventBase & {
      readonly event_type: "pipeline_completed" | "pipeline_failed" | "pipeline_cancelled"
      readonly status: "completed" | "failed" | "cancelled"
    })

export interface PipelineRunSnapshot<Outputs extends PipelineOutputMap> {
  readonly run_id: string
  readonly pipeline_id: string
  readonly status: PipelineRunStatus
  readonly sequence: number
  readonly started_at: string
  readonly updated_at: string
  readonly stage_results: PipelineStageResults<Outputs>
}

export interface PipelineRunResult<Outputs extends PipelineOutputMap> extends PipelineRunSnapshot<Outputs> {
  readonly status: "completed" | "failed" | "cancelled"
  readonly completed_at: string
  readonly pipeline_dir: string
  readonly events_path: string
}

export type PipelineSnapshotCallback<Outputs extends PipelineOutputMap> = (
  snapshot: PipelineRunSnapshot<Outputs>,
) => void | Promise<void>

export interface CreatePipelineArtifactInput {
  readonly artifact_id: string
  readonly path: string
  readonly media_type: string
  readonly role: string
}
