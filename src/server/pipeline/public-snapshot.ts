import { isAbsolute, relative, sep } from "node:path"
import type { PublicPipelineError, PublicPipelineSnapshot, PublicPipelineStage } from "@/shared/job-types"
import type { PipelineOutputMap, PipelineRunSnapshot } from "@/shared/pipeline-types"

const RUN_STATUSES = new Set(["running", "completed", "failed", "cancelled"])
const STAGE_STATUSES = new Set(["pending", "running", "completed", "skipped", "failed", "cancelled"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function privateText(value: string, private_roots: readonly string[]): string {
  let sanitized = value
  for (const root of [...private_roots].sort((left, right) => right.length - left.length)) {
    if (root) sanitized = sanitized.replaceAll(root, "<workspace>")
  }
  return sanitized
    .replace(/\/(?:Users|home|private|tmp|var)\/[^\s;,)]+/g, "<private-path>")
    .replace(/[A-Za-z]:\\[^\s;,)]+/g, "<private-path>")
}

function debugReference(artifact_root: string, debug_dir: string): string {
  const reference = relative(artifact_root, debug_dir).replaceAll("\\", "/")
  if (!reference || reference === ".." || reference.startsWith("../") || isAbsolute(reference)) {
    return ".pipeline"
  }
  return reference
}

export function projectPublicPipelineSnapshot<Outputs extends PipelineOutputMap>(input: {
  snapshot: PipelineRunSnapshot<Outputs>
  artifact_root: string
  private_roots?: readonly string[]
}): PublicPipelineSnapshot {
  const private_roots = [input.artifact_root, ...(input.private_roots ?? [])]
  const stage_results = Object.fromEntries(
    Object.entries(input.snapshot.stage_results).map(([stage_id, stage]) => {
      const projected: PublicPipelineStage = {
        stage_id,
        status: stage.status,
        debug_ref: debugReference(input.artifact_root, stage.debug_dir),
        ...(stage.status === "running" || stage.status === "completed" || stage.status === "failed"
          ? { started_at: stage.started_at }
          : "started_at" in stage && stage.started_at
            ? { started_at: stage.started_at }
            : {}),
        ...(stage.status === "completed" || stage.status === "failed"
          ? { completed_at: stage.completed_at, duration_ms: stage.duration_ms }
          : stage.status === "skipped" || stage.status === "cancelled"
            ? {
                completed_at: stage.completed_at,
                ...(stage.duration_ms === undefined ? {} : { duration_ms: stage.duration_ms }),
              }
            : {}),
        ...(stage.status === "skipped" || stage.status === "cancelled"
          ? { reason: privateText(stage.reason, private_roots) }
          : {}),
        ...(stage.status === "failed"
          ? {
              error: {
                code: stage.error.code,
                message: privateText(stage.error.message, private_roots),
                operation: stage.error.operation,
                ...(stage.error.hint ? { hint: privateText(stage.error.hint, private_roots) } : {}),
                retryable: stage.error.retryable,
              },
            }
          : {}),
      }
      return [stage_id, projected]
    }),
  )
  return {
    pipeline_id: input.snapshot.pipeline_id,
    status: input.snapshot.status,
    sequence: input.snapshot.sequence,
    started_at: input.snapshot.started_at,
    updated_at: input.snapshot.updated_at,
    stage_results,
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function parsePublicError(value: unknown): PublicPipelineError | undefined {
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    typeof value.message !== "string" ||
    typeof value.operation !== "string" ||
    typeof value.retryable !== "boolean"
  ) {
    return undefined
  }
  return {
    code: value.code,
    message: value.message,
    operation: value.operation,
    ...(optionalString(value.hint) ? { hint: optionalString(value.hint) } : {}),
    retryable: value.retryable,
  }
}

export function parsePublicPipelineSnapshot(value: unknown): PublicPipelineSnapshot | undefined {
  if (
    !isRecord(value) ||
    typeof value.pipeline_id !== "string" ||
    typeof value.status !== "string" ||
    !RUN_STATUSES.has(value.status) ||
    !Number.isInteger(value.sequence) ||
    typeof value.started_at !== "string" ||
    typeof value.updated_at !== "string" ||
    !isRecord(value.stage_results)
  ) {
    return undefined
  }
  const stage_results: Record<string, PublicPipelineStage> = {}
  for (const [stage_id, raw_stage] of Object.entries(value.stage_results)) {
    if (
      !isRecord(raw_stage) ||
      raw_stage.stage_id !== stage_id ||
      typeof raw_stage.status !== "string" ||
      !STAGE_STATUSES.has(raw_stage.status) ||
      typeof raw_stage.debug_ref !== "string" ||
      raw_stage.debug_ref.startsWith("/") ||
      raw_stage.debug_ref.split(/[\\/]/).includes("..")
    ) {
      return undefined
    }
    const error = parsePublicError(raw_stage.error)
    if (raw_stage.status === "failed" && !error) return undefined
    stage_results[stage_id] = {
      stage_id,
      status: raw_stage.status as PublicPipelineStage["status"],
      debug_ref: raw_stage.debug_ref,
      ...(optionalString(raw_stage.started_at) ? { started_at: optionalString(raw_stage.started_at) } : {}),
      ...(optionalString(raw_stage.completed_at)
        ? { completed_at: optionalString(raw_stage.completed_at) }
        : {}),
      ...(typeof raw_stage.duration_ms === "number" && raw_stage.duration_ms >= 0
        ? { duration_ms: raw_stage.duration_ms }
        : {}),
      ...(optionalString(raw_stage.reason) ? { reason: optionalString(raw_stage.reason) } : {}),
      ...(error ? { error } : {}),
    }
  }
  return {
    pipeline_id: value.pipeline_id,
    status: value.status as PublicPipelineSnapshot["status"],
    sequence: value.sequence as number,
    started_at: value.started_at,
    updated_at: value.updated_at,
    stage_results,
  }
}
