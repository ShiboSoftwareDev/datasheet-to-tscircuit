import { copyFile, lstat, mkdir, realpath, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { PipelineJsonValue } from "@/shared/pipeline-types"
import { materializePipelineTaskInputFiles, type PipelineTaskInputBundle } from "../pipeline/task-input-files"

function isRecord(value: PipelineJsonValue): value is Readonly<Record<string, PipelineJsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function rewriteWorkspacePaths({
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

function requiredString({
  record,
  key,
}: {
  record: Readonly<Record<string, PipelineJsonValue>>
  key: string
}): string {
  const value = record[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Task execution context requires ${key}`)
  }
  return value
}

async function canonicalProspectivePath(path: string): Promise<string> {
  let cursor = resolve(path)
  const suffix: string[] = []
  while (true) {
    const metadata = await lstat(cursor).catch(() => undefined)
    if (metadata) {
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        if (suffix.length === 0) return await realpath(cursor)
        throw new Error(`Local output parent must be a real directory: ${cursor}`)
      }
      return join(await realpath(cursor), ...suffix)
    }
    const parent = dirname(cursor)
    if (parent === cursor) throw new Error(`Local output path has no existing parent: ${path}`)
    suffix.unshift(basename(cursor))
    cursor = parent
  }
}

function isWithin(parent: string, child: string): boolean {
  const path_from_parent = relative(parent, child)
  return path_from_parent === "" || (!path_from_parent.startsWith("..") && !isAbsolute(path_from_parent))
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

export async function createLocalWorkspace(input: {
  bundle: PipelineTaskInputBundle
  executionDir: string
  localRunId: string
  protectedDirs?: readonly string[]
}): Promise<LocalWorkspace> {
  const declaredSourceJobDir = requiredString({
    record: input.bundle.envelope.execution_context,
    key: "job_dir",
  })
  if (!isAbsolute(declaredSourceJobDir)) throw new Error("Task context job_dir must be absolute")

  const executionDir = await canonicalProspectivePath(input.executionDir)
  const bundleRoot = await realpath(input.bundle.bundle_root)
  if (isWithin(bundleRoot, executionDir)) {
    throw new Error("Local output directory cannot be inside its retained input bundle")
  }
  const protectedDirs = [
    ...(input.protectedDirs ?? []),
    ...(input.bundle.retained_job_dir ? [input.bundle.retained_job_dir] : []),
  ]
  for (const protectedDir of new Set(protectedDirs)) {
    const protectedMetadata = await lstat(protectedDir).catch(() => undefined)
    if (!protectedMetadata) continue
    if (!protectedMetadata.isDirectory() || protectedMetadata.isSymbolicLink()) {
      throw new Error(`Local protected path must be a real directory: ${protectedDir}`)
    }
    if (isWithin(await realpath(protectedDir), executionDir)) {
      throw new Error("Local output directory cannot be inside the historical jobs directory")
    }
  }
  await mkdir(resolve(executionDir, ".."), { recursive: true })
  await mkdir(executionDir)

  const jobId = requiredString({ record: input.bundle.envelope.execution_context, key: "job_id" })
  if (basename(jobId) !== jobId) throw new Error("Task context job_id must be a single path-safe segment")
  const jobsRoot = join(executionDir, "workspace")
  const jobDir = join(jobsRoot, jobId)
  await mkdir(jobDir, { recursive: true })
  await materializePipelineTaskInputFiles({ bundle: input.bundle, destination_root: jobDir })

  // Keep the exact portable input with the Local run so another Local run does
  // not depend on the original task still existing under .runtime/jobs.
  const retainedInputDir = join(executionDir, "input", "stages", input.bundle.envelope.task_id)
  const retainedObjectsDir = join(executionDir, "input", "input-objects")
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
  await writeFile(retainedInputPath, `${JSON.stringify(input.bundle.envelope, null, 2)}\n`, "utf8")

  const context = rewriteWorkspacePaths({
    value: input.bundle.envelope.execution_context,
    sourceJobDir: declaredSourceJobDir,
    localJobDir: jobDir,
  }) as Readonly<Record<string, PipelineJsonValue>>
  const dependencyOutputs = rewriteWorkspacePaths({
    value: input.bundle.envelope.dependency_outputs,
    sourceJobDir: declaredSourceJobDir,
    localJobDir: jobDir,
  }) as Readonly<Record<string, PipelineJsonValue>>

  return {
    localRunId: input.localRunId,
    executionDir,
    jobsRoot,
    jobDir,
    inputPath: retainedInputPath,
    context,
    dependencyOutputs,
  }
}
