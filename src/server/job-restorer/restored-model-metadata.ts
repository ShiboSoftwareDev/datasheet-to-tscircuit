import type { ModelCircuitPreview, ModelProgress, ModelReferencePreview } from "@/shared/job-types"
import { tryParseModelCircuitPreview, tryParseModelReferencePreview } from "@/shared/model-selected-preview"
import { parseModelProgress } from "../model-progress"

export function parseRestoredModelProgress(value: unknown): ModelProgress | undefined {
  try {
    return parseModelProgress(value)
  } catch {
    return undefined
  }
}

export function isModelCircuitPreview(value: unknown): value is ModelCircuitPreview {
  return tryParseModelCircuitPreview(value) !== undefined
}

export function isModelReferencePreview(value: unknown): value is ModelReferencePreview {
  return tryParseModelReferencePreview(value) !== undefined
}
