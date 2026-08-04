import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type {
  JobLog,
  JobLogStream,
  ModelPreviewOption,
  ModelProgress,
  ModelRun,
  ModelRunEvent,
  ModelRunStatus,
  ModelRunSummary,
} from "@/shared/job-types"
import { hasRetainedAcceptedModel } from "@/shared/model-warnings"
import { atomicWriteJsonSync, type CheckpointWriter } from "./infrastructure/persistence/atomic-write"
import {
  appendBoundedLogEvent,
  capRecentLogs,
  type LogEventWriter,
  prepareBoundedLogEvent,
} from "./infrastructure/persistence/bounded-log"

type ModelRunSubscriber = (event: ModelRunEvent) => void
type ModelRunListSubscriber = (summary: ModelRunSummary) => void

interface ModelRunRecord extends ModelRun {
  model_dir: string
  cancellation_controller: AbortController
  subscriber_set: Set<ModelRunSubscriber>
}

export interface CreateModelRunInput {
  model_run_id: string
  job_id: string
  model_dir: string
  use_openai?: boolean
  effort_multiplier: number
}

export interface ModelRunStoreOptions {
  checkpoint_writer?: CheckpointWriter
  log_writer?: LogEventWriter
}

export interface RestoreModelRunInput {
  model_dir: string
  model_run: ModelRun
  logs: JobLog[]
}

export interface CommittedModelProjectionResult {
  model_run: ModelRun
  checkpoint_error?: string
}

export type ModelRunUpdate = Partial<
  Pick<
    ModelRun,
    | "status"
    | "is_complete"
    | "has_errors"
    | "error_message"
    | "warnings"
    | "completed_at"
    | "current_invocation_id"
    | "iteration"
    | "model_source"
    | "manifest"
    | "validation"
    | "model_card"
    | "use_openai"
    | "pipeline"
  >
>

export type ModelRunCancellationResult = "requested" | "already_requested" | "already_complete" | "not_found"

export type CreateModelRunResult =
  | { status: "created"; model_run: ModelRun }
  | { status: "already_exists"; model_run: ModelRun }

export type ExtendModelRunResult =
  | { status: "extended"; model_run: ModelRun; should_start: boolean }
  | { status: "invalid_effort"; model_run: ModelRun }
  | { status: "busy"; model_run: ModelRun }
  | { status: "not_found" }

export type ModelRunRetryResult =
  | { status: "retried"; model_run: ModelRun }
  | { status: "busy"; model_run: ModelRun }
  | { status: "not_retryable"; model_run: ModelRun }
  | { status: "not_found" }

const ACTIVE_STATUSES = new Set<ModelRunStatus>([
  "queued",
  "setting_up",
  "waiting_for_component",
  "running",
  "validating",
  "cancelling",
])

const RESTARTABLE_STATUSES = new Set<ModelRunStatus>(["cancelled", "complete", "failed", "timed_out"])

function computeElapsedTime(record: ModelRunRecord, now = Date.now()): number {
  if (!record.segment_started_at) return record.elapsed_time_ms
  const segment_start = new Date(record.segment_started_at).valueOf()
  if (!Number.isFinite(segment_start)) return record.elapsed_time_ms
  return record.elapsed_time_ms + Math.max(0, now - segment_start)
}

function getPublicModelRun(record: ModelRunRecord): ModelRun {
  return {
    model_run_id: record.model_run_id,
    job_id: record.job_id,
    use_openai: record.use_openai,
    created_at: record.created_at,
    updated_at: record.updated_at,
    completed_at: record.completed_at,
    status: record.status,
    is_complete: record.is_complete,
    has_errors: record.has_errors,
    error_message: record.error_message,
    warnings: [...(record.warnings ?? [])],
    effort_multiplier: record.effort_multiplier,
    elapsed_time_ms: record.elapsed_time_ms,
    segment_started_at: record.segment_started_at,
    current_invocation_id: record.current_invocation_id,
    iteration: record.iteration,
    logs: [...record.logs],
    model_source: record.model_source,
    manifest: record.manifest,
    validation: record.validation,
    model_card: record.model_card,
    progress: record.progress,
    progress_history: [...record.progress_history],
    circuit_preview: record.circuit_preview,
    reference_preview: record.reference_preview,
    preview_options: [...record.preview_options],
    pipeline: record.pipeline,
  }
}

function getModelRunSummary(record: ModelRunRecord): ModelRunSummary {
  return {
    model_run_id: record.model_run_id,
    job_id: record.job_id,
    status: record.status,
    is_complete: record.is_complete,
    has_errors: record.has_errors,
    error_message: record.error_message,
    has_model: Boolean(record.model_source),
    has_retained_accepted_model: hasRetainedAcceptedModel(record),
  }
}

function cloneModelRunRecord(record: ModelRunRecord): ModelRunRecord {
  return {
    ...record,
    warnings: [...(record.warnings ?? [])],
    logs: [...record.logs],
    progress_history: [...record.progress_history],
    preview_options: [...record.preview_options],
    cancellation_controller: record.cancellation_controller,
    subscriber_set: record.subscriber_set,
  }
}

export class ModelRunStore {
  private run_map = new Map<string, ModelRunRecord>()
  private job_run_map = new Map<string, string>()
  private active_execution_ids = new Set<string>()
  private run_list_subscriber_set = new Set<ModelRunListSubscriber>()
  private readonly checkpoint_writer: CheckpointWriter
  private readonly log_writer: LogEventWriter

  constructor(options: ModelRunStoreOptions = {}) {
    this.checkpoint_writer = options.checkpoint_writer ?? atomicWriteJsonSync
    this.log_writer = options.log_writer ?? appendBoundedLogEvent
  }

  createModelRun(input: CreateModelRunInput): ModelRun {
    const result = this.createModelRunIfAbsent(input)
    if (result.status === "already_exists") {
      throw new Error(`Job ${input.job_id} already has a model run`)
    }
    return result.model_run
  }

  createModelRunIfAbsent(input: CreateModelRunInput): CreateModelRunResult {
    const existing_id = this.job_run_map.get(input.job_id)
    const existing = existing_id ? this.run_map.get(existing_id) : undefined
    if (existing) return { status: "already_exists", model_run: getPublicModelRun(existing) }
    const now = new Date().toISOString()
    const record: ModelRunRecord = {
      model_run_id: input.model_run_id,
      job_id: input.job_id,
      model_dir: input.model_dir,
      use_openai: input.use_openai ?? false,
      created_at: now,
      updated_at: now,
      status: "queued",
      is_complete: false,
      has_errors: false,
      warnings: [],
      effort_multiplier: input.effort_multiplier,
      elapsed_time_ms: 0,
      iteration: 0,
      logs: [],
      progress_history: [],
      preview_options: [],
      cancellation_controller: new AbortController(),
      subscriber_set: new Set(),
    }
    mkdirSync(record.model_dir, { recursive: true })
    this.persist(record)
    this.run_map.set(record.model_run_id, record)
    this.job_run_map.set(record.job_id, record.model_run_id)
    const model_run = getPublicModelRun(record)
    this.publishModelRunList(getModelRunSummary(record))
    return { status: "created", model_run }
  }

  restoreModelRun(input: RestoreModelRunInput): ModelRun {
    const existing = this.run_map.get(input.model_run.model_run_id)
    if (existing) return getPublicModelRun(existing)
    const was_active = ACTIVE_STATUSES.has(input.model_run.status)
    const segment_started_at = input.model_run.segment_started_at
      ? new Date(input.model_run.segment_started_at).valueOf()
      : Number.NaN
    const interrupted_segment_ms =
      was_active && Number.isFinite(segment_started_at) ? Math.max(0, Date.now() - segment_started_at) : 0
    const record: ModelRunRecord = {
      ...input.model_run,
      model_dir: input.model_dir,
      use_openai: input.model_run.use_openai,
      status: was_active ? "failed" : input.model_run.status,
      is_complete: was_active ? true : input.model_run.is_complete,
      has_errors: was_active ? true : input.model_run.has_errors,
      error_message: was_active
        ? "The server restarted while this model run was active. Retry to continue from its checkpoints."
        : input.model_run.error_message,
      warnings: input.model_run.warnings ?? [],
      completed_at: was_active ? new Date().toISOString() : input.model_run.completed_at,
      elapsed_time_ms: input.model_run.elapsed_time_ms + interrupted_segment_ms,
      segment_started_at: undefined,
      logs: capRecentLogs(input.logs),
      progress_history: input.model_run.progress_history ?? [],
      preview_options: input.model_run.preview_options ?? [],
      cancellation_controller: new AbortController(),
      subscriber_set: new Set(),
    }
    this.persist(record)
    this.run_map.set(record.model_run_id, record)
    this.job_run_map.set(record.job_id, record.model_run_id)
    const model_run = getPublicModelRun(record)
    this.publishModelRunList(getModelRunSummary(record))
    return model_run
  }

  getModelRun(model_run_id: string): ModelRun | undefined {
    const record = this.run_map.get(model_run_id)
    return record ? getPublicModelRun(record) : undefined
  }

  getModelRunForJob(job_id: string): ModelRun | undefined {
    const model_run_id = this.job_run_map.get(job_id)
    return model_run_id ? this.getModelRun(model_run_id) : undefined
  }

  getModelRunIdForJob(job_id: string): string | undefined {
    return this.job_run_map.get(job_id)
  }

  getModelDir(model_run_id: string): string | undefined {
    return this.run_map.get(model_run_id)?.model_dir
  }

  getCancellationSignal(model_run_id: string): AbortSignal | undefined {
    return this.run_map.get(model_run_id)?.cancellation_controller.signal
  }

  claimModelExecution(model_run_id: string): boolean {
    if (!this.run_map.has(model_run_id) || this.active_execution_ids.has(model_run_id)) return false
    this.active_execution_ids.add(model_run_id)
    return true
  }

  releaseModelExecution(model_run_id: string): void {
    this.active_execution_ids.delete(model_run_id)
  }

  startSegment(model_run_id: string): ModelRun {
    const record = this.requireRecord(model_run_id)
    if (record.segment_started_at) return getPublicModelRun(record)
    return this.mutateAndPublish(record, (candidate) => {
      candidate.segment_started_at = new Date().toISOString()
      candidate.completed_at = undefined
      candidate.status = "running"
      candidate.is_complete = false
      candidate.has_errors = false
      candidate.error_message = undefined
    })
  }

  finishSegment(model_run_id: string, update: ModelRunUpdate): ModelRun {
    const record = this.requireRecord(model_run_id)
    const elapsed_time_ms = computeElapsedTime(record)
    return this.mutateAndPublish(record, (candidate) => {
      candidate.elapsed_time_ms = elapsed_time_ms
      candidate.segment_started_at = undefined
      Object.assign(candidate, update)
    })
  }

  /**
   * Projects artifacts selected by an already-durable publication pointer.
   * Restart recovery can reconstruct this live view if its compatibility
   * checkpoint fails, so that failure must not roll memory back.
   */
  projectCommittedPublication(
    model_run_id: string,
    input: {
      update: ModelRunUpdate
      preview_options: ModelPreviewOption[]
      previews: Pick<ModelRun, "circuit_preview" | "reference_preview">
    },
  ): CommittedModelProjectionResult {
    const record = this.requireRecord(model_run_id)
    return this.mutateCommittedAndPublish(record, (candidate) => {
      Object.assign(candidate, input.update)
      candidate.preview_options = input.preview_options
      candidate.circuit_preview = input.previews.circuit_preview
      candidate.reference_preview = input.previews.reference_preview
    })
  }

  /** Finalizes the invocation that crossed an external durable commit barrier. */
  finishCommittedSegment(model_run_id: string, update: ModelRunUpdate): CommittedModelProjectionResult {
    const record = this.requireRecord(model_run_id)
    const elapsed_time_ms = computeElapsedTime(record)
    return this.mutateCommittedAndPublish(record, (candidate) => {
      candidate.elapsed_time_ms = elapsed_time_ms
      candidate.segment_started_at = undefined
      Object.assign(candidate, update)
    })
  }

  updateModelRun(model_run_id: string, update: ModelRunUpdate): ModelRun {
    const record = this.requireRecord(model_run_id)
    return this.mutateAndPublish(record, (candidate) => Object.assign(candidate, update))
  }

  updateProgress(model_run_id: string, progress: ModelProgress): ModelRun {
    const record = this.requireRecord(model_run_id)
    return this.mutateAndPublish(record, (candidate) => {
      candidate.progress = progress
      if (progress.iteration !== undefined) {
        candidate.iteration = Math.max(candidate.iteration, progress.iteration)
      }
      const last_event = candidate.progress_history.at(-1)
      if (
        !last_event ||
        last_event.sequence !== progress.sequence ||
        last_event.phase !== progress.phase ||
        last_event.message !== progress.message ||
        last_event.updated_at !== progress.updated_at
      ) {
        candidate.progress_history.push({
          sequence: progress.sequence,
          phase: progress.phase,
          message: progress.message,
          updated_at: progress.updated_at,
          iteration: progress.iteration,
        })
        candidate.progress_history = candidate.progress_history.slice(-50)
      }
    })
  }

  updatePreviews(
    model_run_id: string,
    previews: Pick<ModelRun, "circuit_preview" | "reference_preview">,
  ): ModelRun {
    const record = this.requireRecord(model_run_id)
    return this.mutateAndPublish(record, (candidate) => {
      candidate.circuit_preview = previews.circuit_preview
      candidate.reference_preview = previews.reference_preview
    })
  }

  updatePreviewOptions(model_run_id: string, preview_options: ModelPreviewOption[]): ModelRun {
    const record = this.requireRecord(model_run_id)
    if (JSON.stringify(record.preview_options) === JSON.stringify(preview_options)) {
      return getPublicModelRun(record)
    }
    return this.mutateAndPublish(record, (candidate) => {
      candidate.preview_options = preview_options
    })
  }

  /** Publishes the source crop/curve while model generation is still pending. */
  projectReferenceDraft(
    model_run_id: string,
    input: {
      preview_options: ModelPreviewOption[]
      reference_preview: NonNullable<ModelRun["reference_preview"]>
    },
  ): ModelRun {
    const record = this.requireRecord(model_run_id)
    return this.mutateAndPublish(record, (candidate) => {
      candidate.preview_options = input.preview_options
      candidate.circuit_preview = undefined
      candidate.reference_preview = input.reference_preview
    })
  }

  /**
   * Atomically projects a fully persisted, non-accepted candidate validation
   * bundle into the live view. Accepted model fields remain untouched until the
   * publication commit barrier is crossed.
   */
  projectCandidateValidation(
    model_run_id: string,
    input: {
      validation: NonNullable<ModelRun["validation"]>
      preview_options: ModelPreviewOption[]
      previews: Pick<ModelRun, "circuit_preview" | "reference_preview">
    },
  ): ModelRun {
    const record = this.requireRecord(model_run_id)
    return this.mutateAndPublish(record, (candidate) => {
      candidate.validation = input.validation
      candidate.preview_options = input.preview_options
      candidate.circuit_preview = input.previews.circuit_preview
      candidate.reference_preview = input.previews.reference_preview
    })
  }

  extendModelRun(model_run_id: string, additional_effort: number): ExtendModelRunResult {
    const record = this.run_map.get(model_run_id)
    if (!record) return { status: "not_found" }
    if (
      record.status === "validating" ||
      record.status === "cancelling" ||
      (!ACTIVE_STATUSES.has(record.status) && this.active_execution_ids.has(model_run_id))
    ) {
      return { status: "busy", model_run: getPublicModelRun(record) }
    }
    if (
      !Number.isInteger(additional_effort) ||
      additional_effort < 1 ||
      record.effort_multiplier + additional_effort > 8
    ) {
      return { status: "invalid_effort", model_run: getPublicModelRun(record) }
    }
    const should_start = !ACTIVE_STATUSES.has(record.status)
    const model_run = this.mutateAndPublish(record, (candidate) => {
      candidate.effort_multiplier += additional_effort
      if (should_start) {
        candidate.status = "queued"
        candidate.is_complete = false
        candidate.has_errors = false
        candidate.error_message = undefined
        candidate.completed_at = undefined
        candidate.cancellation_controller = new AbortController()
      }
    })
    return { status: "extended", model_run, should_start }
  }

  retryModelRun(model_run_id: string): ModelRunRetryResult {
    const record = this.run_map.get(model_run_id)
    if (!record) return { status: "not_found" }
    if (!RESTARTABLE_STATUSES.has(record.status)) {
      return { status: "not_retryable", model_run: getPublicModelRun(record) }
    }
    if (this.active_execution_ids.has(model_run_id)) {
      return { status: "busy", model_run: getPublicModelRun(record) }
    }
    const model_run = this.mutateAndPublish(record, (candidate) => {
      candidate.status = "queued"
      candidate.is_complete = false
      candidate.has_errors = false
      candidate.error_message = undefined
      candidate.completed_at = undefined
      candidate.segment_started_at = undefined
      candidate.cancellation_controller = new AbortController()
    })
    return { status: "retried", model_run }
  }

  requestCancellation(model_run_id: string): ModelRunCancellationResult {
    const record = this.run_map.get(model_run_id)
    if (!record) return "not_found"
    if (record.is_complete) return "already_complete"
    if (record.cancellation_controller.signal.aborted) return "already_requested"
    const candidate = cloneModelRunRecord(record)
    candidate.status = "cancelling"
    candidate.updated_at = new Date().toISOString()
    try {
      this.persist(candidate)
    } catch (error) {
      record.cancellation_controller.abort()
      throw error
    }
    Object.assign(record, candidate)
    record.cancellation_controller.abort()
    this.publish(record, { event_type: "model_run_updated", model_run: getPublicModelRun(record) })
    this.publishModelRunList(getModelRunSummary(record))
    return "requested"
  }

  async appendLog(model_run_id: string, input: { stream: JobLogStream; message: string }): Promise<JobLog> {
    const record = this.requireRecord(model_run_id)
    const log = prepareBoundedLogEvent({
      log_id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      stream: input.stream,
      message: input.message,
    })
    await this.log_writer(join(record.model_dir, "model-agent.log"), log)
    record.logs = capRecentLogs([...record.logs, log])
    record.updated_at = log.created_at
    this.publish(record, { event_type: "log", log })
    return log
  }

  subscribe(model_run_id: string, subscriber: ModelRunSubscriber): (() => void) | undefined {
    const record = this.run_map.get(model_run_id)
    if (!record) return undefined
    record.subscriber_set.add(subscriber)
    return () => record.subscriber_set.delete(subscriber)
  }

  subscribeToModelRunList(subscriber: ModelRunListSubscriber): () => void {
    this.run_list_subscriber_set.add(subscriber)
    return () => this.run_list_subscriber_set.delete(subscriber)
  }

  getModelRunSummaryForJob(job_id: string): ModelRunSummary | undefined {
    const model_run_id = this.job_run_map.get(job_id)
    const record = model_run_id ? this.run_map.get(model_run_id) : undefined
    return record ? getModelRunSummary(record) : undefined
  }

  deleteModelRunForJob(job_id: string): void {
    const model_run_id = this.job_run_map.get(job_id)
    if (!model_run_id) return
    this.run_map.delete(model_run_id)
    this.job_run_map.delete(job_id)
  }

  private requireRecord(model_run_id: string): ModelRunRecord {
    const record = this.run_map.get(model_run_id)
    if (!record) throw new Error(`Model run ${model_run_id} was not found`)
    return record
  }

  private mutateAndPublish(record: ModelRunRecord, mutate: (candidate: ModelRunRecord) => void): ModelRun {
    const candidate = cloneModelRunRecord(record)
    mutate(candidate)
    candidate.updated_at = new Date().toISOString()
    this.persist(candidate)
    Object.assign(record, candidate)
    this.publish(record, { event_type: "model_run_updated", model_run: getPublicModelRun(record) })
    this.publishModelRunList(getModelRunSummary(record))
    return getPublicModelRun(record)
  }

  private mutateCommittedAndPublish(
    record: ModelRunRecord,
    mutate: (candidate: ModelRunRecord) => void,
  ): CommittedModelProjectionResult {
    const candidate = cloneModelRunRecord(record)
    mutate(candidate)
    candidate.updated_at = new Date().toISOString()
    let checkpoint_error: string | undefined
    try {
      this.persist(candidate)
    } catch (error) {
      checkpoint_error = error instanceof Error ? error.message : String(error)
    }
    Object.assign(record, candidate)
    this.publish(record, { event_type: "model_run_updated", model_run: getPublicModelRun(record) })
    this.publishModelRunList(getModelRunSummary(record))
    return {
      model_run: getPublicModelRun(record),
      ...(checkpoint_error ? { checkpoint_error } : {}),
    }
  }

  private persist(record: ModelRunRecord): void {
    const { logs: _logs, ...snapshot } = getPublicModelRun(record)
    this.checkpoint_writer(join(record.model_dir, "model-run.json"), snapshot)
  }

  private publish(record: ModelRunRecord, event: ModelRunEvent): void {
    for (const subscriber of [...record.subscriber_set]) {
      try {
        subscriber(event)
      } catch {
        record.subscriber_set.delete(subscriber)
      }
    }
  }

  private publishModelRunList(summary: ModelRunSummary): void {
    for (const subscriber of [...this.run_list_subscriber_set]) {
      try {
        subscriber(summary)
      } catch {
        this.run_list_subscriber_set.delete(subscriber)
      }
    }
  }
}
