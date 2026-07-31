import type { ModelRunStatus } from "./job-types"

export const MODEL_EVIDENCE_QUALITY_WARNING_PREFIX = "Evidence quality:"
export const RETAINED_ACCEPTED_WARNING_PREFIX = "The visible SPICE artifacts are from accepted revision"

export function isModelEvidenceQualityWarning(warning: string): boolean {
  return warning.trimStart().startsWith(MODEL_EVIDENCE_QUALITY_WARNING_PREFIX)
}

export function isRetainedAcceptedWarning(warning: string): boolean {
  return warning.startsWith(RETAINED_ACCEPTED_WARNING_PREFIX)
}

export function hasRetainedAcceptedModel(input: {
  status: ModelRunStatus
  model_source?: string
  warnings?: readonly string[]
}): boolean {
  return (
    input.status !== "complete" &&
    Boolean(input.model_source) &&
    (input.warnings ?? []).some(isRetainedAcceptedWarning)
  )
}
