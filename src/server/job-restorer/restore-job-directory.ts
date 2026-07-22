import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import type { Job, JobDisplayStatus } from "@/shared/job-types"
import {
  getTypicalApplicationComponentValueErrors,
  getTypicalApplicationConnectivityErrors,
  getTypicalApplicationSourceErrors,
} from "../job-artifact-validator"
import { parseTypicalApplicationPlan } from "../job-runner"
import type { JobStore } from "../job-store"
import { isRecord, readJson, readPersistedLogs } from "./read-persisted-logs"
import { inferFileName, readRestoredCircuitJson } from "./read-restored-circuit-json"
import {
  ACTIVE_JOB_STATUSES,
  JOB_STATUSES,
  LAYOUT_RECOVERY_LOG,
  OBSOLETE_LAYOUT_FAILURE_PREFIX,
} from "./restore-types"
import { isJobProvenance, isJobValidation } from "./restored-job-metadata"

export async function restoreJobDirectory(input: {
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
  const saved_typical_application_title =
    typeof saved?.typical_application_title === "string" && saved.typical_application_title.trim()
      ? saved.typical_application_title.trim()
      : undefined
  const restored_application_plan = saved_typical_application_title
    ? undefined
    : await readJson(join(input.job_dir, "typical-application-plan.json"))
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
  const has_component_artifact = Boolean(component_code?.includes("export default") && circuit_json)
  const has_complete_artifact = Boolean(
    has_component_artifact &&
      typical_application_code?.includes("export default") &&
      typical_application_circuit_json,
  )
  const saved_validation = isRecord(saved?.validation) ? saved.validation : undefined
  const required_component_validations = [
    "component_build",
    "component_drc",
    "footprint",
    "pinout",
    "component_schematic",
    "component_visual",
  ] as const
  const has_component_validation = required_component_validations.some(
    (field) => saved_validation?.[field] !== undefined,
  )
  const component_validation_passed = required_component_validations.every(
    (field) => saved_validation?.[field] === "passed",
  )
  const component_ready = Boolean(
    has_component_artifact &&
      (has_component_validation
        ? component_validation_passed
        : saved?.component_ready === true || has_complete_artifact),
  )
  let recovered_layout_failure = false
  if (
    saved_status === "failed" &&
    typeof saved?.error_message === "string" &&
    saved.error_message.startsWith(OBSOLETE_LAYOUT_FAILURE_PREFIX) &&
    has_complete_artifact &&
    component_validation_passed &&
    saved_validation?.application_build === "passed" &&
    saved_validation?.application_visual === "passed" &&
    typical_application_code !== undefined &&
    typical_application_circuit_json !== undefined
  ) {
    try {
      const plan = parseTypicalApplicationPlan(
        await readJson(join(input.job_dir, "typical-application-plan.json")),
      )
      recovered_layout_failure =
        getTypicalApplicationSourceErrors(typical_application_code).length === 0 &&
        getTypicalApplicationConnectivityErrors(plan, typical_application_circuit_json).length === 0 &&
        getTypicalApplicationComponentValueErrors(plan, typical_application_circuit_json).length === 0
    } catch {
      recovered_layout_failure = false
    }
  }
  const interrupted = !saved_status || ACTIVE_JOB_STATUSES.has(saved_status)
  const display_status: JobDisplayStatus = recovered_layout_failure
    ? "complete"
    : interrupted
      ? has_complete_artifact
        ? "complete"
        : "failed"
      : saved_status
  const created_at =
    typeof saved?.created_at === "string"
      ? saved.created_at
      : (logs[0]?.created_at ?? directory_stat.birthtime.toISOString())
  const error_message = recovered_layout_failure
    ? undefined
    : display_status === "failed" && interrupted
      ? "The server restarted before this component task finished. Retry to continue."
      : typeof saved?.error_message === "string"
        ? saved.error_message
        : undefined
  const restored_validation_candidate = recovered_layout_failure
    ? {
        ...saved_validation,
        application_connectivity: "passed",
        application_schematic: "passed",
      }
    : saved_validation
  const restored_validation = isJobValidation(restored_validation_candidate)
    ? restored_validation_candidate
    : undefined
  const restored_job = input.job_store.restoreJob({
    job_id: input.job_id,
    job_dir: input.job_dir,
    file_name: typeof saved?.file_name === "string" ? saved.file_name : inferFileName(logs, input.job_id),
    additional_instructions:
      typeof saved?.additional_instructions === "string" ? saved.additional_instructions : undefined,
    retry_source_job_id:
      typeof saved?.retry_source_job_id === "string" ? saved.retry_source_job_id : undefined,
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
    has_errors: recovered_layout_failure ? false : display_status === "failed" || Boolean(saved?.has_errors),
    error_message,
    logs,
    component_ready,
    component_code,
    circuit_json,
    typical_application_title,
    typical_application_code,
    typical_application_circuit_json,
    validation: restored_validation,
    provenance: isJobProvenance(saved?.provenance) ? saved.provenance : undefined,
    evidence_available:
      typeof saved?.evidence_available === "boolean"
        ? saved.evidence_available
        : await Bun.file(join(input.job_dir, "component-evidence.json")).exists(),
  })
  if (recovered_layout_failure && !logs.some((log) => log.message === LAYOUT_RECOVERY_LOG)) {
    await input.job_store.appendLog(input.job_id, { stream: "system", message: LAYOUT_RECOVERY_LOG })
    return input.job_store.getJob(input.job_id)
  }
  return restored_job
}
