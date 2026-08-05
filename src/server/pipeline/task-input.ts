import { lstat, readFile } from "node:fs/promises"
import type { PipelineJsonValue, PipelineTaskInputEnvelope } from "@/shared/pipeline-types"
import { PipelineError } from "./pipeline-error"

const MAX_TASK_INPUT_BYTES = 16 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJsonValueAtDepth({ value, depth = 0 }: { value: unknown; depth?: number }): boolean {
  if (depth > 64) return false
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) {
    return (
      value.length <= 4_096 && value.every((entry) => isJsonValueAtDepth({ value: entry, depth: depth + 1 }))
    )
  }
  if (!isRecord(value)) return false
  const entries = Object.values(value)
  return (
    entries.length <= 4_096 &&
    entries.every((entry) => isJsonValueAtDepth({ value: entry, depth: depth + 1 }))
  )
}

function isJsonValue(value: unknown): value is PipelineJsonValue {
  return isJsonValueAtDepth({ value })
}

function stringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string")
}

function jsonRecord(value: unknown): value is Record<string, PipelineJsonValue> {
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

export function parsePipelineTaskInput(value: unknown): PipelineTaskInputEnvelope {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.kind !== "pipeline_task_input" ||
    typeof value.pipeline_id !== "string" ||
    typeof value.task_id !== "string" ||
    typeof value.run_id !== "string" ||
    !jsonRecord(value.execution_context) ||
    !Array.isArray(value.depends_on) ||
    !value.depends_on.every((entry) => typeof entry === "string") ||
    !stringRecord(value.dependency_statuses) ||
    !jsonRecord(value.dependency_outputs)
  ) {
    throw new PipelineError({
      code: "invalid_task_input",
      message: "Task input must be a version 1 pipeline_task_input envelope",
      stage_id: null,
      operation: "parse_task_input",
      hint: "Use a retained .pipeline/stages/<task>/input.json file from a current run.",
    })
  }
  return {
    version: 1,
    kind: "pipeline_task_input",
    pipeline_id: value.pipeline_id,
    task_id: value.task_id,
    run_id: value.run_id,
    execution_context: value.execution_context,
    depends_on: [...value.depends_on],
    dependency_statuses: { ...value.dependency_statuses },
    dependency_outputs: { ...value.dependency_outputs },
  }
}

export async function loadPipelineTaskInput(path: string): Promise<PipelineTaskInputEnvelope> {
  const inputStat = await lstat(path)
  if (inputStat.isSymbolicLink() || !inputStat.isFile() || inputStat.size > MAX_TASK_INPUT_BYTES) {
    throw new PipelineError({
      code: "invalid_task_input_file",
      message: `Task input must be a regular JSON file no larger than ${MAX_TASK_INPUT_BYTES} bytes`,
      stage_id: null,
      operation: "load_task_input",
      artifact_refs: [{ path }],
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown
  } catch (error) {
    throw new PipelineError(
      {
        code: "invalid_task_input_json",
        message: "Task input is not valid JSON",
        stage_id: null,
        operation: "load_task_input",
        artifact_refs: [{ path }],
      },
      { cause: error },
    )
  }
  return parsePipelineTaskInput(parsed)
}
