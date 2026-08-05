import { cp, lstat, mkdir, realpath } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { PipelineJsonValue, PipelineTaskInputEnvelope } from "@/shared/pipeline-types"

function isRecord(value: PipelineJsonValue): value is Readonly<Record<string, PipelineJsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function rewriteWorkspacePaths({
  value,
  sourceJobDir,
  replayJobDir,
}: {
  value: PipelineJsonValue
  sourceJobDir: string
  replayJobDir: string
}): PipelineJsonValue {
  if (typeof value === "string") {
    if (value === sourceJobDir) return replayJobDir
    if (value.startsWith(`${sourceJobDir}${sep}`)) {
      return join(replayJobDir, value.slice(sourceJobDir.length + 1))
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteWorkspacePaths({ value: entry, sourceJobDir, replayJobDir }))
  }
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      rewriteWorkspacePaths({ value: entry, sourceJobDir, replayJobDir }),
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

export interface ReplayWorkspace {
  readonly replayId: string
  readonly executionDir: string
  readonly jobsRoot: string
  readonly jobDir: string
  readonly context: Readonly<Record<string, PipelineJsonValue>>
  readonly dependencyOutputs: Readonly<Record<string, PipelineJsonValue>>
}

export async function createReplayWorkspace(input: {
  rootDir: string
  envelope: PipelineTaskInputEnvelope
  outputDir?: string
}): Promise<ReplayWorkspace> {
  const sourceJobDirValue = requiredString({ record: input.envelope.execution_context, key: "job_dir" })
  if (!isAbsolute(sourceJobDirValue)) throw new Error("Task context job_dir must be absolute")
  const declaredSourceJobDir = resolve(sourceJobDirValue)
  const sourceJobDir = await realpath(declaredSourceJobDir)
  const sourceStat = await lstat(sourceJobDir)
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("Task context job_dir must be a real directory")
  }

  const replayId = `replay-${crypto.randomUUID()}`
  const executionDir = resolve(input.outputDir ?? join(input.rootDir, ".runtime", "replays", replayId))
  const relativeToSource = relative(sourceJobDir, executionDir)
  if (!relativeToSource.startsWith("..") && !isAbsolute(relativeToSource)) {
    throw new Error("Replay output directory cannot be inside the source job workspace")
  }
  await mkdir(resolve(executionDir, ".."), { recursive: true })
  await mkdir(executionDir)

  const jobId = requiredString({ record: input.envelope.execution_context, key: "job_id" })
  if (basename(jobId) !== jobId) throw new Error("Task context job_id must be a single path-safe segment")
  const jobsRoot = join(executionDir, "workspace")
  const jobDir = join(jobsRoot, basename(jobId))
  await mkdir(jobsRoot, { recursive: true })
  await cp(sourceJobDir, jobDir, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: async (source) => {
      const sourceRelative = relative(sourceJobDir, source)
      if (sourceRelative.split(sep).includes("runs")) return false
      const sourceEntry = await lstat(source)
      if (sourceEntry.isSymbolicLink()) {
        throw new Error(`Replay workspace refuses symbolic links: ${sourceRelative}`)
      }
      return true
    },
  })

  const contextFromDeclaredPath = rewriteWorkspacePaths({
    value: input.envelope.execution_context,
    sourceJobDir: declaredSourceJobDir,
    replayJobDir: jobDir,
  }) as Readonly<Record<string, PipelineJsonValue>>
  const context = rewriteWorkspacePaths({
    value: contextFromDeclaredPath,
    sourceJobDir,
    replayJobDir: jobDir,
  }) as Readonly<Record<string, PipelineJsonValue>>
  const dependenciesFromDeclaredPath = rewriteWorkspacePaths({
    value: input.envelope.dependency_outputs,
    sourceJobDir: declaredSourceJobDir,
    replayJobDir: jobDir,
  }) as Readonly<Record<string, PipelineJsonValue>>
  const dependencyOutputs = rewriteWorkspacePaths({
    value: dependenciesFromDeclaredPath,
    sourceJobDir,
    replayJobDir: jobDir,
  }) as Readonly<Record<string, PipelineJsonValue>>

  return {
    replayId,
    executionDir,
    jobsRoot,
    jobDir,
    context: { ...context, invocation_id: replayId },
    dependencyOutputs,
  }
}
