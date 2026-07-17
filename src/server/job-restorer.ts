import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import type {
  Job,
  JobDisplayStatus,
  JobLog,
  ModelManifest,
  ModelRun,
  ModelRunStatus,
  ModelValidationSummary,
} from "@/shared/job-types"
import type { JobStore } from "./job-store"
import type { ModelRunStore } from "./model-run-store"
import { hasCompleteVerifiedSimulationReport } from "./model-simulation-validator"

const JOB_STATUSES = new Set<JobDisplayStatus>([
  "queued",
  "agent_running",
  "building",
  "cancelling",
  "cancelled",
  "complete",
  "failed",
])
const ACTIVE_JOB_STATUSES = new Set<JobDisplayStatus>(["queued", "agent_running", "building", "cancelling"])
const MODEL_STATUSES = new Set<ModelRunStatus | "review_required">([
  "queued",
  "setting_up",
  "waiting_for_component",
  "running",
  "validating",
  "cancelling",
  "cancelled",
  "complete",
  "review_required",
  "timed_out",
  "failed",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function readJson(file_path: string): Promise<unknown> {
  return readFile(file_path, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined)
}

export async function readPersistedLogs(file_path: string): Promise<JobLog[]> {
  const text = await readFile(file_path, "utf8").catch(() => "")
  const expression = /^\[([^\]]+)] \[(system|stdout|stderr)] /gm
  const matches = [...text.matchAll(expression)]
  return matches.map((match, index) => {
    const message_start = (match.index ?? 0) + match[0].length
    const message_end = matches[index + 1]?.index ?? text.length
    return {
      log_id: `restored-${index}-${match[1]}`,
      created_at: match[1]!,
      stream: match[2] as JobLog["stream"],
      message: text.slice(message_start, message_end),
    }
  })
}

function isCircuitJson(value: unknown): value is Job["circuit_json"] {
  return (
    Array.isArray(value) &&
    value.every(
      (element) => typeof element === "object" && element !== null && typeof element.type === "string",
    )
  )
}

async function readRestoredCircuitJson(
  job_dir: string,
  artifact: "component" | "typical_application",
): Promise<Job["circuit_json"] | undefined> {
  const candidates =
    artifact === "component"
      ? [
          join(job_dir, "dist", "spice", "component-with-model", "circuit.json"),
          join(job_dir, "dist", "index", "circuit.json"),
        ]
      : [join(job_dir, "dist", "typical-application", "circuit.json")]
  for (const candidate of candidates) {
    const value = await readJson(candidate)
    if (isCircuitJson(value)) return value
  }
  return undefined
}

function inferFileName(logs: JobLog[], job_id: string): string {
  for (const log of logs) {
    const match = log.message.match(/Uploaded (.+) \(\d+ bytes\)\./)
    if (match?.[1]) return match[1]
  }
  return `${job_id}.pdf`
}

async function restoreJobDirectory(input: {
  job_id: string
  job_dir: string
  job_store: JobStore
}): Promise<Job | undefined> {
  if (!(await Bun.file(join(input.job_dir, "datasheet.pdf")).exists())) return undefined
  const [
    snapshot,
    logs,
    component_code,
    circuit_json,
    typical_application_code,
    typical_application_circuit_json,
    directory_stat,
  ] = await Promise.all([
    readJson(join(input.job_dir, "job.json")),
    readPersistedLogs(join(input.job_dir, "agent.log")),
    readFile(join(input.job_dir, "index.circuit.tsx"), "utf8").catch(() => undefined),
    readRestoredCircuitJson(input.job_dir, "component"),
    readFile(join(input.job_dir, "typical-application.circuit.tsx"), "utf8").catch(() => undefined),
    readRestoredCircuitJson(input.job_dir, "typical_application"),
    stat(input.job_dir),
  ])
  const saved = isRecord(snapshot) ? snapshot : undefined
  const saved_status =
    typeof saved?.display_status === "string" && JOB_STATUSES.has(saved.display_status as JobDisplayStatus)
      ? (saved.display_status as JobDisplayStatus)
      : undefined
  const component_ready = Boolean(component_code?.includes("export default") && circuit_json)
  const has_complete_artifact = Boolean(
    component_ready &&
      typical_application_code?.includes("export default") &&
      typical_application_circuit_json,
  )
  const interrupted = !saved_status || ACTIVE_JOB_STATUSES.has(saved_status)
  const display_status: JobDisplayStatus = interrupted
    ? has_complete_artifact
      ? "complete"
      : "failed"
    : saved_status
  const created_at =
    typeof saved?.created_at === "string"
      ? saved.created_at
      : (logs[0]?.created_at ?? directory_stat.birthtime.toISOString())
  const error_message =
    display_status === "failed" && interrupted
      ? "The server restarted before this component task finished. Retry to continue."
      : typeof saved?.error_message === "string"
        ? saved.error_message
        : undefined
  return input.job_store.restoreJob({
    job_id: input.job_id,
    job_dir: input.job_dir,
    file_name: typeof saved?.file_name === "string" ? saved.file_name : inferFileName(logs, input.job_id),
    additional_instructions:
      typeof saved?.additional_instructions === "string" ? saved.additional_instructions : undefined,
    created_at,
    completed_at:
      display_status === "complete" || display_status === "failed" || display_status === "cancelled"
        ? typeof saved?.completed_at === "string"
          ? saved.completed_at
          : directory_stat.mtime.toISOString()
        : undefined,
    display_status,
    is_complete:
      display_status === "complete" || display_status === "failed" || display_status === "cancelled",
    has_errors: display_status === "failed" || Boolean(saved?.has_errors),
    error_message,
    logs,
    component_ready,
    component_code,
    circuit_json,
    typical_application_code,
    typical_application_circuit_json,
  })
}

async function restoreModelDirectory(input: {
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
  const stored_status =
    typeof saved?.status === "string" &&
    MODEL_STATUSES.has(saved.status as ModelRunStatus | "review_required")
      ? saved.status
      : "failed"
  let saved_status: ModelRunStatus =
    stored_status === "review_required" ? "timed_out" : (stored_status as ModelRunStatus)
  const has_verified_simulation = await hasCompleteVerifiedSimulationReport(input.model_dir)
  const invalidated_legacy_completion = saved_status === "complete" && !has_verified_simulation
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
    progress: isRecord(saved?.progress) ? (saved.progress as unknown as ModelRun["progress"]) : undefined,
    progress_history: Array.isArray(saved?.progress_history)
      ? (saved.progress_history as ModelRun["progress_history"])
      : [],
    circuit_preview: isRecord(saved?.circuit_preview)
      ? (saved.circuit_preview as unknown as ModelRun["circuit_preview"])
      : undefined,
    reference_preview: isRecord(saved?.reference_preview)
      ? (saved.reference_preview as unknown as ModelRun["reference_preview"])
      : undefined,
    preview_options: Array.isArray(saved?.preview_options)
      ? (saved.preview_options as ModelRun["preview_options"])
      : [],
  }
  return input.model_run_store.restoreModelRun({ model_dir: input.model_dir, model_run, logs })
}

export async function restorePersistedJobs(input: {
  jobs_root: string
  job_store: JobStore
  model_run_store: ModelRunStore
}): Promise<{ jobs_restored: number; model_runs_restored: number }> {
  const entries = await readdir(input.jobs_root, { withFileTypes: true }).catch(() => [])
  let jobs_restored = 0
  let model_runs_restored = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const job_dir = join(input.jobs_root, entry.name)
    const job = await restoreJobDirectory({ job_id: entry.name, job_dir, job_store: input.job_store })
    if (!job) continue
    jobs_restored += 1
    const model_run = await restoreModelDirectory({
      job_id: entry.name,
      model_dir: join(job_dir, "spice"),
      model_run_store: input.model_run_store,
    })
    if (model_run) model_runs_restored += 1
  }
  return { jobs_restored, model_runs_restored }
}
