import type { JobDisplayStatus, ModelRunStatus } from "@/shared/job-types"

export const JOB_STATUSES = new Set<JobDisplayStatus>([
  "queued",
  "agent_running",
  "building",
  "cancelling",
  "cancelled",
  "complete",
  "unsupported",
  "failed",
])

export const ACTIVE_JOB_STATUSES = new Set<JobDisplayStatus>([
  "queued",
  "agent_running",
  "building",
  "cancelling",
])

export const MODEL_STATUSES = new Set<ModelRunStatus>([
  "queued",
  "setting_up",
  "waiting_for_component",
  "running",
  "validating",
  "cancelling",
  "cancelled",
  "complete",
  "timed_out",
  "failed",
])

export const ACTIVE_MODEL_STATUSES = new Set<ModelRunStatus>([
  "queued",
  "setting_up",
  "waiting_for_component",
  "running",
  "validating",
  "cancelling",
])
