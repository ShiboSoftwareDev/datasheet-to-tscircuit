import { appendFile } from "node:fs/promises"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type {
  JobLog,
  JobLogStream,
  ModelManifest,
  ModelProgress,
  ModelPreviewOption,
  ModelRun,
  ModelRunEvent,
  ModelRunStatus,
  ModelValidationSummary,
} from "@/shared/job-types"
import type { BenchmarkLock } from "./model-benchmark-lock"

type ModelRunSubscriber = (event: ModelRunEvent) => void

interface ModelRunRecord extends ModelRun {
  model_dir: string
  benchmark_lock?: BenchmarkLock
  validation_run_count: number
  validation_canary_ms?: number
  cancellation_controller: AbortController
  subscriber_set: Set<ModelRunSubscriber>
}

export interface CreateModelRunInput {
  model_run_id: string
  job_id: string
  model_dir: string
  use_openai?: boolean
  effort_multiplier: number
  base_effort_ms: number
}

export interface RestoreModelRunInput {
  model_dir: string
  model_run: ModelRun
  logs: JobLog[]
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
    | "iteration"
    | "model_source"
    | "manifest"
    | "validation"
    | "model_card"
    | "use_openai"
  >
>

export type ModelRunCancellationResult = "requested" | "already_requested" | "already_complete" | "not_found"

export interface ExtendModelRunResult {
  model_run: ModelRun
  should_start: boolean
}

export type ModelRunRetryResult = "retried" | "not_failed" | "not_found"

const ACTIVE_STATUSES = new Set<ModelRunStatus>([
  "queued",
  "setting_up",
  "waiting_for_component",
  "running",
  "validating",
  "cancelling",
])

function computeElapsedTime(record: ModelRunRecord, now = Date.now()): number {
  if (!record.segment_started_at) return record.elapsed_time_ms
  const segment_start = new Date(record.segment_started_at).valueOf()
  if (!Number.isFinite(segment_start)) return record.elapsed_time_ms
  return record.elapsed_time_ms + Math.max(0, now - segment_start)
}

function computeValidationReserve(): number {
  // Evidence setup, benchmark repair, and independent validation are server-owned
  // work. They pause the refinement segment instead of consuming user effort.
  return 0
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
    base_effort_ms: record.base_effort_ms,
    allocated_time_ms: record.allocated_time_ms,
    elapsed_time_ms: record.elapsed_time_ms,
    segment_started_at: record.segment_started_at,
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
  }
}

export class ModelRunStore {
  private run_map = new Map<string, ModelRunRecord>()
  private job_run_map = new Map<string, string>()

  createModelRun(input: CreateModelRunInput): ModelRun {
    if (this.job_run_map.has(input.job_id)) throw new Error(`Job ${input.job_id} already has a model run`)
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
      base_effort_ms: input.base_effort_ms,
      allocated_time_ms: input.base_effort_ms * input.effort_multiplier,
      elapsed_time_ms: 0,
      iteration: 0,
      logs: [],
      progress_history: [],
      preview_options: [],
      validation_run_count: 0,
      cancellation_controller: new AbortController(),
      subscriber_set: new Set(),
    }
    this.run_map.set(record.model_run_id, record)
    this.job_run_map.set(record.job_id, record.model_run_id)
    mkdirSync(record.model_dir, { recursive: true })
    this.persist(record)
    this.writeRunControl(record)
    return getPublicModelRun(record)
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
      elapsed_time_ms: Math.min(
        input.model_run.allocated_time_ms,
        input.model_run.elapsed_time_ms + interrupted_segment_ms,
      ),
      segment_started_at: undefined,
      logs: input.logs,
      progress_history: input.model_run.progress_history ?? [],
      preview_options: input.model_run.preview_options ?? [],
      validation_run_count: 0,
      cancellation_controller: new AbortController(),
      subscriber_set: new Set(),
    }
    this.run_map.set(record.model_run_id, record)
    this.job_run_map.set(record.job_id, record.model_run_id)
    this.persist(record)
    this.writeRunControl(record)
    return getPublicModelRun(record)
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

  rememberBenchmarkLock(model_run_id: string, benchmark_lock: BenchmarkLock): void {
    this.requireRecord(model_run_id).benchmark_lock = structuredClone(benchmark_lock)
  }

  getRememberedBenchmarkLock(model_run_id: string): BenchmarkLock | undefined {
    const benchmark_lock = this.run_map.get(model_run_id)?.benchmark_lock
    return benchmark_lock ? structuredClone(benchmark_lock) : undefined
  }

  getRemainingTimeMs(model_run_id: string): number | undefined {
    const record = this.run_map.get(model_run_id)
    if (!record) return undefined
    return Math.max(0, record.allocated_time_ms - computeElapsedTime(record))
  }

  getFinalizationReserveMs(model_run_id: string, simulation_run_count = 0): number | undefined {
    const record = this.run_map.get(model_run_id)
    return record ? computeValidationReserve() : undefined
  }

  setValidationProfile(
    model_run_id: string,
    profile: { simulation_run_count: number; canary_duration_ms?: number },
  ): ModelRun {
    const record = this.requireRecord(model_run_id)
    record.validation_run_count = Math.max(0, Math.floor(profile.simulation_run_count))
    record.validation_canary_ms = profile.canary_duration_ms
    this.touchAndPublish(record)
    return getPublicModelRun(record)
  }

  startSegment(model_run_id: string): ModelRun {
    const record = this.requireRecord(model_run_id)
    if (record.segment_started_at) return getPublicModelRun(record)
    record.segment_started_at = new Date().toISOString()
    record.completed_at = undefined
    record.status = "running"
    record.is_complete = false
    record.has_errors = false
    record.error_message = undefined
    this.touchAndPublish(record)
    return getPublicModelRun(record)
  }

  pauseSegment(model_run_id: string): ModelRun {
    const record = this.requireRecord(model_run_id)
    if (record.segment_started_at) record.elapsed_time_ms = computeElapsedTime(record)
    record.segment_started_at = undefined
    this.touchAndPublish(record)
    return getPublicModelRun(record)
  }

  restartSegment(model_run_id: string): ModelRun {
    const record = this.requireRecord(model_run_id)
    record.elapsed_time_ms = 0
    record.segment_started_at = new Date().toISOString()
    record.completed_at = undefined
    record.status = "running"
    record.is_complete = false
    record.has_errors = false
    record.error_message = undefined
    this.touchAndPublish(record)
    return getPublicModelRun(record)
  }

  finishSegment(model_run_id: string, update: ModelRunUpdate): ModelRun {
    const record = this.requireRecord(model_run_id)
    record.elapsed_time_ms = computeElapsedTime(record)
    record.segment_started_at = undefined
    Object.assign(record, update)
    this.touchAndPublish(record)
    return getPublicModelRun(record)
  }

  updateModelRun(model_run_id: string, update: ModelRunUpdate): ModelRun {
    const record = this.requireRecord(model_run_id)
    Object.assign(record, update)
    this.touchAndPublish(record)
    return getPublicModelRun(record)
  }

  updateProgress(model_run_id: string, progress: ModelProgress): ModelRun {
    const record = this.requireRecord(model_run_id)
    record.progress = progress
    if (progress.iteration !== undefined) {
      record.iteration = Math.max(record.iteration, progress.iteration)
    }
    const last_event = record.progress_history.at(-1)
    if (
      !last_event ||
      last_event.sequence !== progress.sequence ||
      last_event.phase !== progress.phase ||
      last_event.message !== progress.message ||
      last_event.updated_at !== progress.updated_at
    ) {
      record.progress_history.push({
        sequence: progress.sequence,
        phase: progress.phase,
        message: progress.message,
        updated_at: progress.updated_at,
        iteration: progress.iteration,
      })
      record.progress_history = record.progress_history.slice(-50)
    }
    this.touchAndPublish(record)
    return getPublicModelRun(record)
  }

  updatePreviews(
    model_run_id: string,
    previews: Pick<ModelRun, "circuit_preview" | "reference_preview">,
  ): ModelRun {
    const record = this.requireRecord(model_run_id)
    record.circuit_preview = previews.circuit_preview
    record.reference_preview = previews.reference_preview
    this.touchAndPublish(record)
    return getPublicModelRun(record)
  }

  updatePreviewOptions(model_run_id: string, preview_options: ModelPreviewOption[]): ModelRun {
    const record = this.requireRecord(model_run_id)
    if (JSON.stringify(record.preview_options) === JSON.stringify(preview_options)) {
      return getPublicModelRun(record)
    }
    record.preview_options = preview_options
    this.touchAndPublish(record)
    return getPublicModelRun(record)
  }

  extendModelRun(model_run_id: string, additional_effort: number): ExtendModelRunResult {
    const record = this.requireRecord(model_run_id)
    const should_start = !ACTIVE_STATUSES.has(record.status)
    record.effort_multiplier += additional_effort
    record.allocated_time_ms += record.base_effort_ms * additional_effort
    if (should_start) {
      record.status = "queued"
      record.is_complete = false
      record.has_errors = false
      record.error_message = undefined
      record.completed_at = undefined
      record.cancellation_controller = new AbortController()
    }
    this.touchAndPublish(record)
    return { model_run: getPublicModelRun(record), should_start }
  }

  retryModelRun(model_run_id: string): ModelRunRetryResult {
    const record = this.run_map.get(model_run_id)
    if (!record) return "not_found"
    if (record.status !== "failed") return "not_failed"
    record.status = "queued"
    record.is_complete = false
    record.has_errors = false
    record.error_message = undefined
    record.completed_at = undefined
    record.segment_started_at = undefined
    record.cancellation_controller = new AbortController()
    this.touchAndPublish(record)
    return "retried"
  }

  requestCancellation(model_run_id: string): ModelRunCancellationResult {
    const record = this.run_map.get(model_run_id)
    if (!record) return "not_found"
    if (record.is_complete) return "already_complete"
    if (record.cancellation_controller.signal.aborted) return "already_requested"
    record.status = "cancelling"
    record.cancellation_controller.abort()
    this.touchAndPublish(record)
    return "requested"
  }

  async appendLog(model_run_id: string, input: { stream: JobLogStream; message: string }): Promise<JobLog> {
    const record = this.requireRecord(model_run_id)
    const log: JobLog = {
      log_id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      stream: input.stream,
      message: input.message,
    }
    record.logs.push(log)
    record.updated_at = log.created_at
    await appendFile(
      join(record.model_dir, "model-agent.log"),
      `[${log.created_at}] [${input.stream}] ${input.message}`,
      "utf8",
    )
    this.persist(record)
    this.publish(record, { event_type: "log", log })
    return log
  }

  subscribe(model_run_id: string, subscriber: ModelRunSubscriber): (() => void) | undefined {
    const record = this.run_map.get(model_run_id)
    if (!record) return undefined
    record.subscriber_set.add(subscriber)
    return () => record.subscriber_set.delete(subscriber)
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

  private touchAndPublish(record: ModelRunRecord): void {
    record.updated_at = new Date().toISOString()
    this.persist(record)
    this.writeRunControl(record)
    this.publish(record, { event_type: "model_run_updated", model_run: getPublicModelRun(record) })
  }

  private persist(record: ModelRunRecord): void {
    const { logs: _logs, ...snapshot } = getPublicModelRun(record)
    writeFileSync(join(record.model_dir, "model-run.json"), `${JSON.stringify(snapshot, null, 2)}\n`)
  }

  private writeRunControl(record: ModelRunRecord): void {
    const remaining_time_ms = Math.max(0, record.allocated_time_ms - computeElapsedTime(record))
    const deadline_at = record.segment_started_at
      ? new Date(Date.now() + remaining_time_ms).toISOString()
      : undefined
    writeFileSync(
      join(record.model_dir, "run-control.json"),
      `${JSON.stringify(
        {
          version: 1,
          effort_multiplier: record.effort_multiplier,
          allocated_time_ms: record.allocated_time_ms,
          elapsed_time_ms: computeElapsedTime(record),
          remaining_time_ms,
          deadline_at,
          finalization_reserve_ms: computeValidationReserve(),
          instruction:
            "Re-read this file before every refinement iteration; only agent refinement consumes effort, while server validation is untimed.",
        },
        null,
        2,
      )}\n`,
    )
  }

  private publish(record: ModelRunRecord, event: ModelRunEvent): void {
    for (const subscriber of record.subscriber_set) subscriber(event)
  }
}
