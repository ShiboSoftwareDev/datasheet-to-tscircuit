import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import type { ModelManifest, ModelRun, ModelRunStatus, ModelValidationSummary } from "@/shared/job-types"
import type { ModelRunStore } from "../model-run-store"
import { hasCompleteVerifiedSimulationReport } from "../model-simulation-validator"
import { isRecord, readJson, readPersistedLogs } from "./read-persisted-logs"
import { MODEL_STATUSES } from "./restore-types"
import {
  isModelCircuitPreview,
  isModelReferencePreview,
  parseRestoredModelProgress,
} from "./restored-model-metadata"

export async function restoreModelDirectory(input: {
  job_id: string
  model_dir: string
  model_run_store: ModelRunStore
}): Promise<ModelRun | undefined> {
  const directory_stat = await stat(input.model_dir).catch(() => undefined)
  if (!directory_stat?.isDirectory()) return undefined
  const [snapshot, logs, model_source, manifest, validation, model_card] = await Promise.all([
    readJson(join(input.model_dir, "model-run.json")),
    readPersistedLogs(join(input.model_dir, "model-agent.log")),
    readFile(join(input.model_dir, "model.lib"), "utf8").catch(() => undefined),
    readJson(join(input.model_dir, "model-manifest.json")),
    readJson(join(input.model_dir, "validation-report.json")),
    readFile(join(input.model_dir, "model-card.md"), "utf8").catch(() => undefined),
  ])
  const saved = isRecord(snapshot) ? snapshot : undefined
  let saved_status: ModelRunStatus =
    typeof saved?.status === "string" && MODEL_STATUSES.has(saved.status as ModelRunStatus)
      ? (saved.status as ModelRunStatus)
      : "timed_out"
  const saved_warnings = Array.isArray(saved?.warnings)
    ? saved.warnings.filter((warning): warning is string => typeof warning === "string")
    : []
  const has_verified_simulation = await hasCompleteVerifiedSimulationReport(input.model_dir)
  const invalidated_legacy_completion =
    saved_status === "complete" && saved_warnings.length === 0 && !has_verified_simulation
  if (invalidated_legacy_completion) saved_status = "timed_out"
  const run_control = await readJson(join(input.model_dir, "run-control.json"))
  const control = isRecord(run_control) ? run_control : undefined
  const base_effort_ms =
    typeof saved?.base_effort_ms === "number"
      ? saved.base_effort_ms
      : typeof control?.allocated_time_ms === "number" && typeof control.effort_multiplier === "number"
        ? control.allocated_time_ms / Math.max(1, control.effort_multiplier)
        : 30 * 60 * 1_000
  const effort_multiplier =
    typeof saved?.effort_multiplier === "number"
      ? saved.effort_multiplier
      : typeof control?.effort_multiplier === "number"
        ? control.effort_multiplier
        : 1
  const model_run: ModelRun = {
    model_run_id: typeof saved?.model_run_id === "string" ? saved.model_run_id : `restored-${input.job_id}`,
    job_id: input.job_id,
    use_openai: typeof saved?.use_openai === "boolean" ? saved.use_openai : undefined,
    created_at:
      typeof saved?.created_at === "string" ? saved.created_at : directory_stat.birthtime.toISOString(),
    updated_at: typeof saved?.updated_at === "string" ? saved.updated_at : directory_stat.mtime.toISOString(),
    completed_at: typeof saved?.completed_at === "string" ? saved.completed_at : undefined,
    status: saved_status,
    is_complete: typeof saved?.is_complete === "boolean" ? saved.is_complete : saved_status === "failed",
    has_errors:
      saved_status === "timed_out" ||
      (typeof saved?.has_errors === "boolean" ? saved.has_errors : saved_status === "failed"),
    error_message: invalidated_legacy_completion
      ? "This result predates simulator-owned validation. Add effort to revalidate its preserved checkpoint."
      : typeof saved?.error_message === "string"
        ? saved.error_message
        : undefined,
    warnings: saved_warnings,
    effort_multiplier,
    base_effort_ms,
    allocated_time_ms:
      typeof saved?.allocated_time_ms === "number"
        ? saved.allocated_time_ms
        : base_effort_ms * effort_multiplier,
    elapsed_time_ms: typeof saved?.elapsed_time_ms === "number" ? saved.elapsed_time_ms : 0,
    segment_started_at: typeof saved?.segment_started_at === "string" ? saved.segment_started_at : undefined,
    iteration: typeof saved?.iteration === "number" ? saved.iteration : 0,
    logs,
    model_source: typeof saved?.model_source === "string" ? saved.model_source : model_source,
    manifest: (isRecord(saved?.manifest) ? saved.manifest : manifest) as ModelManifest | undefined,
    validation: (isRecord(saved?.validation) ? saved.validation : validation) as
      | ModelValidationSummary
      | undefined,
    model_card: typeof saved?.model_card === "string" ? saved.model_card : model_card,
    progress: parseRestoredModelProgress(saved?.progress),
    progress_history: Array.isArray(saved?.progress_history)
      ? (saved.progress_history as ModelRun["progress_history"])
      : [],
    circuit_preview: isModelCircuitPreview(saved?.circuit_preview) ? saved.circuit_preview : undefined,
    reference_preview: isModelReferencePreview(saved?.reference_preview)
      ? saved.reference_preview
      : undefined,
    preview_options: Array.isArray(saved?.preview_options)
      ? (saved.preview_options as ModelRun["preview_options"])
      : [],
  }
  return input.model_run_store.restoreModelRun({ model_dir: input.model_dir, model_run, logs })
}
