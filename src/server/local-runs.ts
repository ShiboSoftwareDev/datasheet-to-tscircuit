import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { Job, ModelProgress, ModelRun } from "@/shared/job-types"
import type { LocalRunMode, LocalRunStatus, LocalRunSummary } from "@/shared/local-run"
import { JobStore } from "./job-store"
import { restorePersistedJobs } from "./job-restorer"
import { ModelRunStore } from "./model-run-store"

const LOCAL_RUN_ID = /^local-[a-zA-Z0-9-]{16,80}$/
const LOCAL_SUMMARY_MAX_BYTES = 32 * 1024 * 1024
const LOCAL_RUN_MODES = new Set<LocalRunMode>(["pipeline", "task", "from_task"])
const LOCAL_RUN_STATUSES = new Set<LocalRunStatus>(["running", "completed", "failed", "cancelled"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child)
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent))
}

function rebaseRecordedPaths(value: unknown, recordedRoot: string, actualRoot: string): unknown {
  if (typeof value === "string") {
    if (value === recordedRoot) return actualRoot
    if (value.startsWith(`${recordedRoot}${sep}`)) {
      return join(actualRoot, value.slice(recordedRoot.length + 1))
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rebaseRecordedPaths(entry, recordedRoot, actualRoot))
  }
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, rebaseRecordedPaths(entry, recordedRoot, actualRoot)]),
  )
}

export function isLocalRunId(value: string): boolean {
  return LOCAL_RUN_ID.test(value)
}

function parseLocalRunSummary(value: unknown, expectedId: string): LocalRunSummary {
  if (!isRecord(value)) throw new Error("Local run summary is malformed")
  if (
    value.version !== 1 ||
    value.local_run_id !== expectedId ||
    !LOCAL_RUN_MODES.has(value.mode as LocalRunMode) ||
    typeof value.pipeline_id !== "string" ||
    typeof value.source_run_id !== "string" ||
    typeof value.source_job_id !== "string" ||
    basename(value.source_job_id) !== value.source_job_id ||
    typeof value.file_name !== "string" ||
    !LOCAL_RUN_STATUSES.has(value.status as LocalRunStatus) ||
    typeof value.created_at !== "string" ||
    typeof value.execution_dir !== "string" ||
    typeof value.workspace_dir !== "string" ||
    typeof value.input_path !== "string" ||
    typeof value.pipeline_dir !== "string" ||
    typeof value.events_path !== "string" ||
    typeof value.summary_path !== "string"
  ) {
    throw new Error("Local run summary is malformed")
  }
  return value as unknown as LocalRunSummary
}

export async function readLocalRunSummary(localRoot: string, localRunId: string): Promise<LocalRunSummary> {
  if (!isLocalRunId(localRunId)) throw new Error("Invalid Local run id")
  const executionDir = resolve(localRoot, localRunId)
  const metadata = await lstat(executionDir)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Local run is unavailable")
  const summaryPath = join(executionDir, "summary.json")
  const summaryMetadata = await lstat(summaryPath)
  if (
    !summaryMetadata.isFile() ||
    summaryMetadata.isSymbolicLink() ||
    summaryMetadata.size > LOCAL_SUMMARY_MAX_BYTES
  ) {
    throw new Error("Local run summary is unavailable")
  }
  const summary = parseLocalRunSummary(JSON.parse(await readFile(summaryPath, "utf8")) as unknown, localRunId)
  const realExecutionDir = await realpath(executionDir)
  const recordedExecutionDir = resolve(summary.execution_dir)
  if (basename(recordedExecutionDir) !== localRunId) {
    throw new Error("Local run summary has an invalid execution directory")
  }
  const recordedPaths = [
    summary.workspace_dir,
    summary.input_path,
    summary.pipeline_dir,
    summary.events_path,
    summary.summary_path,
  ]
  for (const candidate of recordedPaths) {
    if (!isWithin(recordedExecutionDir, resolve(candidate))) {
      throw new Error("Local run summary references a path outside its workspace")
    }
  }
  const rebase = (candidate: string) =>
    join(realExecutionDir, relative(recordedExecutionDir, resolve(candidate)))
  return {
    ...summary,
    execution_dir: realExecutionDir,
    workspace_dir: rebase(summary.workspace_dir),
    input_path: rebase(summary.input_path),
    pipeline_dir: rebase(summary.pipeline_dir),
    events_path: rebase(summary.events_path),
    summary_path: rebase(summary.summary_path),
    stage_results: rebaseRecordedPaths(summary.stage_results, recordedExecutionDir, realExecutionDir),
    ...(summary.selected_task_result
      ? {
          selected_task_result: rebaseRecordedPaths(
            summary.selected_task_result,
            recordedExecutionDir,
            realExecutionDir,
          ),
        }
      : {}),
  }
}

export async function listLocalRuns(localRoot: string): Promise<LocalRunSummary[]> {
  await mkdir(localRoot, { recursive: true })
  const entries = await readdir(localRoot, { withFileTypes: true })
  const summaries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && isLocalRunId(entry.name))
      .map((entry) => readLocalRunSummary(localRoot, entry.name).catch(() => undefined)),
  )
  return summaries
    .filter((summary): summary is LocalRunSummary => summary !== undefined)
    .sort((first, second) => second.created_at.localeCompare(first.created_at))
}

export interface LocalRunWorkspaceContext {
  readonly summary: LocalRunSummary
  readonly job_store: JobStore
  readonly model_run_store: ModelRunStore
  readonly job: Job
  readonly model_run?: ModelRun
}

export function projectCompletedLocalTaskModelRun(input: { summary: LocalRunSummary; model_run: ModelRun }):
  | {
      update: Pick<
        ModelRun,
        "status" | "is_complete" | "has_errors" | "error_message" | "warnings" | "completed_at"
      >
      progress: ModelProgress
    }
  | undefined {
  if (
    input.summary.pipeline_id !== "spice_generation" ||
    input.summary.mode !== "task" ||
    input.summary.status !== "completed" ||
    !input.summary.task_id
  ) {
    return undefined
  }
  const completed_at = input.summary.completed_at ?? input.model_run.updated_at
  const warning = `Local task ${input.summary.task_id} completed. Later SPICE generation tasks were intentionally not run.`
  return {
    update: {
      status: "complete",
      is_complete: true,
      has_errors: false,
      error_message: undefined,
      warnings: [...new Set([...(input.model_run.warnings ?? []), warning])],
      completed_at,
    },
    progress: {
      sequence: (input.model_run.progress?.sequence ?? 0) + 1,
      phase: "complete",
      message: `Local task ${input.summary.task_id} completed`,
      updated_at: completed_at,
      ...(input.model_run.progress?.iteration === undefined
        ? {}
        : { iteration: input.model_run.progress.iteration }),
    },
  }
}

export async function loadLocalRunWorkspace(
  localRoot: string,
  localRunId: string,
): Promise<LocalRunWorkspaceContext> {
  const summary = await readLocalRunSummary(localRoot, localRunId)
  const executionDir = resolve(localRoot, localRunId)
  const jobsRoot = join(executionDir, "workspace")
  const jobStore = new JobStore({ checkpoint_writer: () => undefined, log_writer: async () => undefined })
  const modelRunStore = new ModelRunStore({
    checkpoint_writer: () => undefined,
    log_writer: async () => undefined,
  })
  await restorePersistedJobs({ jobs_root: jobsRoot, job_store: jobStore, model_run_store: modelRunStore })
  const job = jobStore.getJob(summary.source_job_id)
  if (!job) throw new Error(`Local run ${localRunId} has no displayable job output`)
  const modelRunId = modelRunStore.getModelRunIdForJob(summary.source_job_id)
  if (modelRunId) {
    const modelRun = modelRunStore.getModelRun(modelRunId)
    const projection = modelRun
      ? projectCompletedLocalTaskModelRun({ summary, model_run: modelRun })
      : undefined
    if (projection) {
      modelRunStore.updateProgress(modelRunId, projection.progress)
      modelRunStore.updateModelRun(modelRunId, projection.update)
    }
  }
  const projectedJob: Job = {
    ...job,
    display_status:
      summary.status === "running"
        ? "agent_running"
        : summary.status === "completed"
          ? "complete"
          : summary.status === "cancelled"
            ? "cancelled"
            : "failed",
    is_complete: summary.status !== "running",
    has_errors: summary.status === "failed" || job.has_errors,
    error_message: summary.error_message ?? job.error_message,
    ...(summary.completed_at ? { completed_at: summary.completed_at } : {}),
  }
  return {
    summary,
    job_store: jobStore,
    model_run_store: modelRunStore,
    job: projectedJob,
    ...(modelRunId ? { model_run: modelRunStore.getModelRun(modelRunId) } : {}),
  }
}
