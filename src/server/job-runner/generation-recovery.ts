import { cp, mkdir, readdir, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { AutomatedConversionUnavailableError, JobCancelledError } from "./stream-job-process"

export const MAX_GENERATION_ATTEMPTS = 3

export type GenerationRecoveryPhase = "component" | "application"

export function generationFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function canRetryGenerationFailure(error: unknown, signal: AbortSignal): boolean {
  return (
    !signal.aborted &&
    !(error instanceof JobCancelledError) &&
    !(error instanceof AutomatedConversionUnavailableError)
  )
}

export function shouldDiscardGenerationCheckpoint(error: unknown): boolean {
  const message = generationFailureMessage(error)
  return (
    message.includes("accessed locked datasheet inputs") ||
    message.includes("modified locked evidence") ||
    message.includes("modified a read-only component or evidence plan")
  )
}

export function sanitizeRetryFeedback(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2_000)
}

export async function retainFailedGenerationAttempt(input: {
  job_dir: string
  phase: GenerationRecoveryPhase
  attempt: number
  error: unknown
}): Promise<void> {
  const attempt_directory = join(input.job_dir, "generation-attempts", `${input.phase}-${input.attempt}`)
  await rm(attempt_directory, { recursive: true, force: true })
  await mkdir(attempt_directory, { recursive: true })
  const paths =
    input.phase === "component"
      ? ["index.circuit.tsx", "component-visual-inspection.json", "dist/index"]
      : ["typical-application.circuit.tsx", "application-visual-inspection.json", "dist/typical-application"]
  for (const path of paths) {
    const source = join(input.job_dir, path)
    const source_exists =
      (await Bun.file(source).exists()) || (await readdir(source).catch(() => undefined)) !== undefined
    if (!source_exists) continue
    const destination = join(attempt_directory, path)
    await mkdir(dirname(destination), { recursive: true })
    await cp(source, destination, { recursive: true })
  }
  await Bun.write(
    join(attempt_directory, "error.json"),
    `${JSON.stringify({ message: sanitizeRetryFeedback(generationFailureMessage(input.error)) }, null, 2)}\n`,
  )
}
