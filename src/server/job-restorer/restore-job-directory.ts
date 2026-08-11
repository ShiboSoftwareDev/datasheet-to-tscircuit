import { constants } from "node:fs"
import { lstat, open, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import type { Job, JobDisplayStatus } from "@/shared/job-types"
import { isCircuitElementArray } from "../component-circuit-json"
import {
  applicationEvidenceFilePath,
  readCommittedApplicationEvidenceSnapshot,
} from "../component-workflow/application-evidence-commit"
import { readCommittedEvidenceSnapshot } from "../component-workflow/evidence-commit"
import { componentPublishedCircuitJsonRelativePath } from "../component-workflow/component-footprint-artifacts"
import {
  componentFootprintPreviewsFromCatalog,
  parseApprovedFootprintCatalogSnapshot,
} from "../component-workflow/stage-helpers"
import type { JobStore } from "../job-store"
import { MODEL_PUBLICATION_FILE, readModelPublication, readVerifiedPublicationArtifact } from "../modeling"
import { parsePublicPipelineSnapshot } from "../pipeline"
import { isRecord, readPersistedLogs } from "./read-persisted-logs"
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
  active_job_state?: "interrupt" | "preserve"
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
  const [publication_result, evidence_result, application_evidence_result, mutable_datasheet_exists] =
    await Promise.all([
      readModelPublication(input.job_dir, input.job_id).then(
        (publication) => ({ publication, publication_integrity_error: undefined }),
        (error: unknown) => ({
          publication: undefined,
          publication_integrity_error: error instanceof Error ? error.message : String(error),
        }),
      ),
      readCommittedEvidenceSnapshot(input.job_dir).then(
        (evidence_snapshot) => ({ evidence_snapshot, evidence_integrity_error: undefined }),
        (error: unknown) => ({
          evidence_snapshot: undefined,
          evidence_integrity_error: error instanceof Error ? error.message : String(error),
        }),
      ),
      readCommittedApplicationEvidenceSnapshot(input.job_dir).then(
        (application_evidence_snapshot) => ({
          application_evidence_snapshot,
          application_evidence_integrity_error: undefined,
        }),
        (error: unknown) => ({
          application_evidence_snapshot: undefined,
          application_evidence_integrity_error: error instanceof Error ? error.message : String(error),
        }),
      ),
      Bun.file(join(input.job_dir, "datasheet.pdf")).exists(),
    ])
  const { publication } = publication_result
  let { publication_integrity_error } = publication_result
  const { evidence_snapshot, evidence_integrity_error } = evidence_result
  const { application_evidence_snapshot, application_evidence_integrity_error } = application_evidence_result
  if (!mutable_datasheet_exists && evidence_snapshot?.version !== 3 && !application_evidence_snapshot) {
    return undefined
  }
  const readBaseComponentSource = async (): Promise<string | undefined> => {
    const component_source = await readFile(join(input.job_dir, "component.circuit.tsx"), "utf8").catch(
      () => undefined,
    )
    if (component_source !== undefined || publication_integrity_error) return component_source
    return readFile(join(input.job_dir, "index.circuit.tsx"), "utf8").catch(() => undefined)
  }
  const readComponentArtifacts = async () => {
    if (!publication) {
      return {
        component_code: await readBaseComponentSource(),
        circuit_json: await readRestoredCircuitJson(input.job_dir, "component", undefined, {
          base_component_only: true,
        }),
      }
    }
    try {
      const [component_source_bytes, circuit_json] = await Promise.all([
        readVerifiedPublicationArtifact({
          publication,
          bundle: "published_component",
          relative_path: "index.circuit.tsx",
          max_bytes: 2 * 1024 * 1024,
        }),
        readRestoredCircuitJson(input.job_dir, "component", publication),
      ])
      return { component_code: new TextDecoder().decode(component_source_bytes), circuit_json }
    } catch (error) {
      publication_integrity_error = error instanceof Error ? error.message : String(error)
      return {
        component_code: await readBaseComponentSource(),
        circuit_json: await readRestoredCircuitJson(input.job_dir, "component", undefined, {
          base_component_only: true,
        }),
      }
    }
  }
  const [
    logs,
    component_artifacts,
    typical_application_code_candidate,
    typical_application_circuit_json_candidate,
    directory_stat,
  ] = await Promise.all([
    readPersistedLogs(join(input.job_dir, "agent.log")),
    readComponentArtifacts(),
    readFile(join(input.job_dir, "typical-application.circuit.tsx"), "utf8").catch(() => undefined),
    readRestoredCircuitJson(input.job_dir, "typical_application"),
    stat(input.job_dir),
  ])
  const { component_code, circuit_json } = component_artifacts
  const component_footprints = evidence_snapshot
    ? await (async () => {
        const catalog = parseApprovedFootprintCatalogSnapshot(evidence_snapshot)
        const metadata = componentFootprintPreviewsFromCatalog(catalog)
        const footprints = await Promise.all(
          metadata.footprints.map(async (footprint) => {
            const raw_circuit_json = await readFile(
              join(input.job_dir, componentPublishedCircuitJsonRelativePath(footprint.footprint_id)),
              "utf8",
            ).catch(() => undefined)
            let restored_circuit_json: unknown
            if (raw_circuit_json) {
              try {
                restored_circuit_json = JSON.parse(raw_circuit_json)
              } catch {
                restored_circuit_json = undefined
              }
            }
            const is_default = footprint.footprint_id === metadata.default_footprint_id
            const variant_circuit_json = isCircuitElementArray(restored_circuit_json)
              ? restored_circuit_json
              : is_default
                ? circuit_json
                : undefined
            return {
              ...footprint,
              ...(variant_circuit_json ? { circuit_json: variant_circuit_json } : {}),
            }
          }),
        )
        return { ...metadata, footprints }
      })()
    : undefined
  const publication_is_usable = Boolean(publication && !publication_integrity_error)
  const evidence_is_committed = evidence_snapshot !== undefined
  let restored_application_plan: unknown
  const application_plan_bytes =
    application_evidence_snapshot?.files.get(applicationEvidenceFilePath("typical-application-plan.json")) ??
    evidence_snapshot?.files.get("typical-application-plan.json")
  if (application_evidence_snapshot && !application_plan_bytes) {
    throw new Error("Committed application evidence is missing typical-application-plan.json")
  }
  if (application_plan_bytes) {
    try {
      restored_application_plan = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(application_plan_bytes),
      )
    } catch (error) {
      throw new Error("Committed typical-application-plan.json is not valid UTF-8 JSON", {
        cause: error,
      })
    }
  }
  const typical_application_title =
    isRecord(restored_application_plan) &&
    restored_application_plan.availability === "documented" &&
    typeof restored_application_plan.title === "string" &&
    restored_application_plan.title.trim()
      ? restored_application_plan.title.trim()
      : undefined
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
      (publication_is_usable ||
        component_validation_passed ||
        (saved_status === "complete" && saved?.component_ready === true) ||
        has_complete_artifact),
  )
  const restored_pipeline = parsePublicPipelineSnapshot(saved.pipeline)
  const saved_pipelines = isRecord(saved.pipelines) ? saved.pipelines : undefined
  const restored_pipelines = {
    component_generation:
      parsePublicPipelineSnapshot(saved_pipelines?.component_generation) ??
      (restored_pipeline?.pipeline_id === "component_generation" ||
      restored_pipeline?.pipeline_id === "datasheet_component"
        ? restored_pipeline
        : undefined),
    typical_application: parsePublicPipelineSnapshot(saved_pipelines?.typical_application),
  }
  const active_job_state = input.active_job_state ?? "interrupt"
  const active_checkpoint = Boolean(saved_status && ACTIVE_JOB_STATUSES.has(saved_status))
  const preserved_active_status =
    saved_status && active_job_state === "preserve" && ACTIVE_JOB_STATUSES.has(saved_status)
      ? saved_status
      : undefined
  const interrupted = !saved_status || (active_job_state === "interrupt" && active_checkpoint)
  const published_pipeline_completed = Boolean(
    (restored_pipelines.component_generation?.pipeline_id === "component_generation" &&
      restored_pipelines.component_generation.status === "completed" &&
      restored_pipelines.component_generation.stage_results.publish_component?.status === "completed") ||
      (restored_pipelines.typical_application?.status === "completed" &&
        restored_pipelines.typical_application.stage_results.publish_application?.status === "completed") ||
      (restored_pipeline?.pipeline_id === "datasheet_component" &&
        restored_pipeline.status === "completed" &&
        restored_pipeline.stage_results.publish?.status === "completed"),
  )
  const recover_published_component =
    interrupted && (published_pipeline_completed || publication_is_usable) && component_ready
  const invalid_saved_completion = saved_status === "complete" && !component_ready
  const display_status: JobDisplayStatus = invalid_saved_completion
    ? "failed"
    : recover_published_component
      ? "complete"
      : preserved_active_status
        ? preserved_active_status
        : interrupted
          ? "failed"
          : saved_status
  const created_at =
    typeof saved?.created_at === "string"
      ? saved.created_at
      : (logs[0]?.created_at ?? directory_stat.birthtime.toISOString())
  const error_message = publication_integrity_error
    ? `The committed model publication failed integrity validation and was not restored: ${publication_integrity_error}`
    : invalid_saved_completion
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
      display_status === "failed" ||
      Boolean(publication_integrity_error) ||
      Boolean(evidence_integrity_error) ||
      Boolean(application_evidence_integrity_error) ||
      (recover_published_component ? false : Boolean(saved?.has_errors)),
    error_message,
    warnings: [
      ...(Array.isArray(saved.warnings)
        ? saved.warnings.filter((warning): warning is string => typeof warning === "string")
        : []),
      ...(evidence_integrity_error
        ? [`Committed evidence failed integrity validation and was not restored: ${evidence_integrity_error}`]
        : []),
      ...(application_evidence_integrity_error
        ? [
            `Committed application evidence failed integrity validation and was not restored: ${application_evidence_integrity_error}`,
          ]
        : []),
      ...(publication_integrity_error
        ? [
            `Committed model publication failed integrity validation; the base component remains available: ${publication_integrity_error}`,
          ]
        : []),
    ],
    logs,
    component_ready,
    component_code,
    circuit_json,
    component_footprints,
    typical_application_title,
    typical_application_code,
    typical_application_circuit_json,
    validation: restored_validation,
    provenance: isJobProvenance(saved.provenance) ? saved.provenance : undefined,
    evidence_available: evidence_is_committed,
    pipeline: restored_pipeline,
    pipelines: restored_pipelines,
  })
  return restored_job
}
