export const MODEL_EVIDENCE_QUALITY_WARNING_PREFIX = "Evidence quality:"

export function isModelEvidenceQualityWarning(warning: string): boolean {
  return warning.trimStart().startsWith(MODEL_EVIDENCE_QUALITY_WARNING_PREFIX)
}
