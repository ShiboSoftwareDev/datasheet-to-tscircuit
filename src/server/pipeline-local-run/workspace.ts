import { copyFile, mkdir, writeFile } from "node:fs/promises"
import { join, sep } from "node:path"
import type { PipelineJsonValue } from "@/shared/pipeline-types"
import type { PipelineTaskInputBundle } from "../pipeline/task-input-files"

function isRecord(value: PipelineJsonValue): value is Readonly<Record<string, PipelineJsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function rewriteWorkspacePaths({
  value,
  sourceJobDir,
  localJobDir,
}: {
  value: PipelineJsonValue
  sourceJobDir: string
  localJobDir: string
}): PipelineJsonValue {
  if (typeof value === "string") {
    if (value === sourceJobDir) return localJobDir
    if (value.startsWith(`${sourceJobDir}${sep}`)) {
      return join(localJobDir, value.slice(sourceJobDir.length + 1))
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteWorkspacePaths({ value: entry, sourceJobDir, localJobDir }))
  }
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      rewriteWorkspacePaths({ value: entry, sourceJobDir, localJobDir }),
    ]),
  )
}

/** Copies the self-contained retained input without materializing a job workspace. */
export async function retainLocalInputBundle(input: {
  bundle: PipelineTaskInputBundle
  executionDir: string
  envelope?: PipelineTaskInputBundle["envelope"]
}): Promise<string> {
  const retainedInputDir = join(input.executionDir, "input", "stages", input.bundle.envelope.task_id)
  const retainedObjectsDir = join(input.executionDir, "input", "input-objects")
  const retainedInputPath = join(retainedInputDir, "input.json")
  await mkdir(retainedInputDir, { recursive: true })
  await mkdir(retainedObjectsDir, { recursive: true })
  for (const hash of new Set(input.bundle.manifest.files.map(({ hash }) => hash))) {
    await copyFile(join(input.bundle.objects_dir, hash), join(retainedObjectsDir, hash))
  }
  await writeFile(
    join(retainedInputDir, "input-files.json"),
    `${JSON.stringify(input.bundle.manifest, null, 2)}\n`,
    "utf8",
  )
  await writeFile(
    retainedInputPath,
    `${JSON.stringify(input.envelope ?? input.bundle.envelope, null, 2)}\n`,
    "utf8",
  )
  return retainedInputPath
}

export interface LocalWorkspace {
  readonly localRunId: string
  readonly executionDir: string
  readonly jobsRoot: string
  readonly jobDir: string
  readonly inputPath: string
  readonly context: Readonly<Record<string, PipelineJsonValue>>
  readonly dependencyOutputs: Readonly<Record<string, PipelineJsonValue>>
}
