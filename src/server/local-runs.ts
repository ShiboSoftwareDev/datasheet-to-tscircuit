import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { LocalRunMode, LocalRunStatus, LocalRunSummary } from "@/shared/local-run"

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
    (value.version !== 1 && value.version !== 2) ||
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
  if (value.version === 2 && value.execution_kind !== "in_place" && value.execution_kind !== "clone") {
    throw new Error("Local run summary is malformed")
  }
  if (
    value.version === 2 &&
    (typeof value.target_job_id !== "string" || basename(value.target_job_id) !== value.target_job_id)
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
  const recordedPaths =
    summary.version === 1
      ? [
          summary.workspace_dir,
          summary.input_path,
          summary.pipeline_dir,
          summary.events_path,
          summary.summary_path,
        ]
      : [summary.input_path, summary.summary_path]
  for (const candidate of recordedPaths) {
    if (!isWithin(recordedExecutionDir, resolve(candidate))) {
      throw new Error("Local run summary references a path outside its workspace")
    }
  }
  const rebase = (candidate: string) =>
    join(realExecutionDir, relative(recordedExecutionDir, resolve(candidate)))
  if (summary.version === 2) {
    const targetJobId = summary.target_job_id!
    const recordedWorkspace = resolve(summary.workspace_dir)
    if (basename(recordedWorkspace) !== targetJobId) {
      throw new Error("Local run summary has an invalid target workspace")
    }
    for (const candidate of [summary.pipeline_dir, summary.events_path]) {
      if (!isWithin(recordedWorkspace, resolve(candidate))) {
        throw new Error("Local run summary references a path outside its target job")
      }
    }
    const actualWorkspace = resolve(localRoot, "..", "jobs", targetJobId)
    const rebaseWorkspace = (value: unknown) =>
      rebaseRecordedPaths(
        rebaseRecordedPaths(value, recordedExecutionDir, realExecutionDir),
        recordedWorkspace,
        actualWorkspace,
      )
    return {
      ...summary,
      execution_dir: realExecutionDir,
      workspace_dir: actualWorkspace,
      input_path: rebase(summary.input_path),
      pipeline_dir: join(actualWorkspace, relative(recordedWorkspace, resolve(summary.pipeline_dir))),
      events_path: join(actualWorkspace, relative(recordedWorkspace, resolve(summary.events_path))),
      summary_path: rebase(summary.summary_path),
      stage_results: rebaseWorkspace(summary.stage_results),
      ...(summary.selected_task_result
        ? { selected_task_result: rebaseWorkspace(summary.selected_task_result) }
        : {}),
    }
  }
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
