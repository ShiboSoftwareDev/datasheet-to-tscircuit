import type { JobProvenance, JobValidation, JobValidationStatus } from "@/shared/job-types"
import { isRecord } from "./read-persisted-logs"

const validationStatuses = new Set<JobValidationStatus>([
  "pending",
  "passed",
  "warning",
  "failed",
  "inconclusive",
  "unresolved",
  "not_applicable",
])

export function isJobValidation(value: unknown): value is JobValidation {
  if (!isRecord(value)) return false
  return [
    "evidence",
    "component_build",
    "component_drc",
    "footprint",
    "pinout",
    "component_schematic",
    "component_visual",
    "application_build",
    "application_connectivity",
    "application_schematic",
    "application_visual",
  ].every((field) => validationStatuses.has(value[field] as JobValidationStatus))
}

export function isJobProvenance(value: unknown): value is JobProvenance {
  if (!isRecord(value) || !isRecord(value.prompt_sha256)) return false
  return [
    "source_commit",
    "bun_version",
    "tscircuit_version",
    "tsci_agent_version",
    "agent_model",
    "agent_settings",
    "datasheet_sha256",
  ].every((field) => typeof value[field] === "string")
}
