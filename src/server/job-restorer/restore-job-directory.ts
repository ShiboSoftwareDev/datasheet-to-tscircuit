import { constants } from "node:fs"
import { lstat, open, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import type { Job, JobDisplayStatus } from "@/shared/job-types"
import { hasCommittedEvidence } from "../component-workflow/evidence-commit"
import type { JobStore } from "../job-store"
import { MODEL_PUBLICATION_FILE, readModelPublication, readVerifiedPublicationArtifact } from "../modeling"
import { parsePublicPipelineSnapshot } from "../pipeline"
import { isRecord, readJson, readPersistedLogs } from "./read-persisted-logs"
import { inferFileName, readRestoredCircuitJson } from "./read-restored-circuit-json"
import { ACTIVE_JOB_STATUSES, JOB_STATUSES } from "./restore-types"
import { isJobProvenance, isJobValidation } from "./restored-job-metadata"

export type JobRestoreMarkerErrorCode =
  | "job_marker_invalid"
  | "job_marker_identity_mismatch"
  | "job_marker_missing_with_publication"

export class JobRestoreMarkerError extends Error {
  constructor(
    readonly code: JobRestoreMarkerErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "JobRestoreMarkerError"
  }
}

const JOB_MARKER_BYTE_LIMIT = 2 * 1024 * 1024

function isMissingPath(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT"
}

async function hasPathEntry(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isMissingPath(error)) return false
    throw error
  }
}

async function readJobMarker(path: string, job_id: string): Promise<Record<string, unknown> | undefined> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (isMissingPath(error)) return undefined
    throw new JobRestoreMarkerError(
      "job_marker_invalid",
      `job.json is not a readable regular file for ${job_id}`,
    )
  }

  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size > JOB_MARKER_BYTE_LIMIT) {
      throw new JobRestoreMarkerError(
        "job_marker_invalid",
        `job.json is not a regular file of at most ${JOB_MARKER_BYTE_LIMIT} bytes for ${job_id}`,
      )
    }
    const bytes = new Uint8Array(metadata.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const trailing_byte = new Uint8Array(1)
    const trailing = await handle.read(trailing_byte, 0, 1, offset)
    if (offset !== bytes.length || trailing.bytesRead !== 0) {
      throw new JobRestoreMarkerError("job_marker_invalid", `job.json changed while reading ${job_id}`)
    }
    let snapshot: unknown
    try {
      snapshot = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new JobRestoreMarkerError("job_marker_invalid", `job.json is malformed for ${job_id}`)
    }
    if (!isRecord(snapshot)) {
      throw new JobRestoreMarkerError("job_marker_invalid", `job.json is malformed for ${job_id}`)
    }
    return snapshot
  } finally {
    await handle.close().catch(() => undefined)
  }
}

export async function restoreJobDirectory(input: {
  job_id: string
  job_dir: string
  job_store: JobStore
}): Promise<Job | undefined> {
  const checkpoint_path = join(input.job_dir, "job.json")
  const snapshot = await readJobMarker(checkpoint_path, input.job_id)
  if (!snapshot) {
    if (await hasPathEntry(join(input.job_dir, MODEL_PUBLICATION_FILE))) {
      throw new JobRestoreMarkerError(
        "job_marker_missing_with_publication",
        `${MODEL_PUBLICATION_FILE} exists, but job.json is missing for ${input.job_id}`,
      )
    }
    return undefined
  }
  if (snapshot.job_id !== input.job_id) {
    throw new JobRestoreMarkerError(
      "job_marker_identity_mismatch",
      `job.json belongs to a different job than ${input.job_id}`,
    )
  }
  const saved = snapshot
  const publication = await readModelPublication(input.job_dir, input.job_id)
  if (!(await Bun.file(join(input.job_dir, "datasheet.pdf")).exists())) return undefined
  const readComponentSource = async (): Promise<string | undefined> =>
    publication
      ? new TextDecoder().decode(
          await readVerifiedPublicationArtifact({
            publication,
            bundle: "published_component",
            relative_path: "index.circuit.tsx",
            max_bytes: 2 * 1024 * 1024,
          }),
        )
      : readFile(join(input.job_dir, "index.circuit.tsx"), "utf8").catch(() => undefined)
  const [
    logs,
    component_code,
    circuit_json,
    typical_application_code_candidate,
    typical_application_circuit_json_candidate,
    directory_stat,
    evidence_is_committed,
  ] = await Promise.all([
    readPersistedLogs(join(input.job_dir, "agent.log")),
    readComponentSource(),
    readRestoredCircuitJson(input.job_dir, "component", publication),
    readFile(join(input.job_dir, "typical-application.circuit.tsx"), "utf8").catch(() => undefined),
    readRestoredCircuitJson(input.job_dir, "typical_application"),
    stat(input.job_dir),
    hasCommittedEvidence(input.job_dir),
  ])
  const saved_typical_application_title =
    evidence_is_committed &&
    typeof saved?.typical_application_title === "string" &&
    saved.typical_application_title.trim()
      ? saved.typical_application_title.trim()
      : undefined
  const restored_application_plan = saved_typical_application_title
    ? undefined
    : evidence_is_committed
      ? await readJson(join(input.job_dir, "typical-application-plan.json"))
      : undefined
  const typical_application_title =
    saved_typical_application_title ??
    (isRecord(restored_application_plan) &&
    typeof restored_application_plan.title === "string" &&
    restored_application_plan.title.trim()
      ? restored_application_plan.title.trim()
      : undefined)
  const saved_status =
    typeof saved?.display_status === "string" && JOB_STATUSES.has(saved.display_status as JobDisplayStatus)
      ? (saved.display_status as JobDisplayStatus)
      : undefined
  const saved_validation = isRecord(saved?.validation) ? saved.validation : undefined
  const application_artifact_is_validated =
    saved_validation?.application_build === "passed" &&
    saved_validation?.application_connectivity === "passed" &&
    saved_validation?.application_schematic === "passed" &&
    (saved_validation?.application_visual === "passed" ||
      saved_validation?.application_visual === "inconclusive")
  const typical_application_code = application_artifact_is_validated
    ? typical_application_code_candidate
    : undefined
  const typical_application_circuit_json = application_artifact_is_validated
    ? typical_application_circuit_json_candidate
    : undefined
  const has_component_artifact = Boolean(component_code?.includes("export default") && circuit_json)
  const has_complete_artifact = Boolean(
    has_component_artifact &&
      typical_application_code?.includes("export default") &&
      typical_application_circuit_json,
  )
  const required_component_validations = [
    "component_build",
    "component_drc",
    "footprint",
    "pinout",
    "component_schematic",
  ] as const
  const component_validation_passed =
    required_component_validations.every((field) => saved_validation?.[field] === "passed") &&
    (saved_validation?.component_visual === "passed" || saved_validation?.component_visual === "inconclusive")
  const component_ready = Boolean(
    has_component_artifact &&
      (publication ||
        component_validation_passed ||
        (saved_status === "complete" && saved?.component_ready === true) ||
        has_complete_artifact),
  )
  const restored_pipeline = parsePublicPipelineSnapshot(saved.pipeline)
  const interrupted = !saved_status || ACTIVE_JOB_STATUSES.has(saved_status)
  const published_pipeline_completed = Boolean(
    restored_pipeline?.pipeline_id === "datasheet_component" &&
      restored_pipeline.status === "completed" &&
      restored_pipeline.stage_results.publish?.status === "completed",
  )
  const recover_published_component =
    interrupted && (published_pipeline_completed || Boolean(publication)) && component_ready
  const invalid_saved_completion = saved_status === "complete" && !component_ready
  const display_status: JobDisplayStatus = invalid_saved_completion
    ? "failed"
    : recover_published_component
      ? "complete"
      : interrupted
        ? "failed"
        : saved_status
  const created_at =
    typeof saved?.created_at === "string"
      ? saved.created_at
      : (logs[0]?.created_at ?? directory_stat.birthtime.toISOString())
  const error_message = invalid_saved_completion
    ? "The saved task claimed completion, but its validated component artifacts are missing or inconsistent. Retry to rebuild it."
    : recover_published_component
      ? undefined
      : display_status === "failed" && interrupted
        ? "The server restarted before this component task finished. Retry to continue."
        : typeof saved?.error_message === "string"
          ? saved.error_message
          : undefined
  const restored_validation = isJobValidation(saved_validation) ? saved_validation : undefined
  const restored_job = input.job_store.restoreJob({
    job_id: input.job_id,
    job_dir: input.job_dir,
    file_name: typeof saved.file_name === "string" ? saved.file_name : inferFileName(logs, input.job_id),
    use_openai: typeof saved.use_openai === "boolean" ? saved.use_openai : undefined,
    additional_instructions:
      typeof saved.additional_instructions === "string" ? saved.additional_instructions : undefined,
    retry_source_job_id:
      typeof saved.retry_source_job_id === "string" ? saved.retry_source_job_id : undefined,
    created_at,
    completed_at:
      display_status === "complete" ||
      display_status === "unsupported" ||
      display_status === "failed" ||
      display_status === "cancelled"
        ? typeof saved?.completed_at === "string"
          ? saved.completed_at
          : directory_stat.mtime.toISOString()
        : undefined,
    display_status,
    is_complete:
      display_status === "complete" ||
      display_status === "unsupported" ||
      display_status === "failed" ||
      display_status === "cancelled",
    has_errors:
      display_status === "failed" || (recover_published_component ? false : Boolean(saved?.has_errors)),
    error_message,
    warnings: [
      ...(Array.isArray(saved.warnings)
        ? saved.warnings.filter((warning): warning is string => typeof warning === "string")
        : []),
    ],
    logs,
    component_ready,
    component_code,
    circuit_json,
    typical_application_title,
    typical_application_code,
    typical_application_circuit_json,
    validation: restored_validation,
    provenance: isJobProvenance(saved.provenance) ? saved.provenance : undefined,
    evidence_available: evidence_is_committed,
    pipeline: restored_pipeline,
  })
  return restored_job
}
