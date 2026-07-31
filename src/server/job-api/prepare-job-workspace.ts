import { mkdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { writeJobScaffold } from "../job-scaffold"

type PreparationPhase =
  | "creating the private workspace"
  | "writing the workflow scaffold"
  | "storing the datasheet"
  | "publishing the workspace"

export class JobWorkspacePreparationError extends Error {
  readonly phase: PreparationPhase

  constructor(phase: PreparationPhase, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`Failed while ${phase}: ${detail}`)
    this.name = "JobWorkspacePreparationError"
    this.phase = phase
  }
}

export interface PreparedJobWorkspace {
  job_dir: string
  discard: () => Promise<void>
}

/**
 * Build a job outside the restorer's public namespace, then atomically expose
 * the completed filesystem scaffold. job.json remains the durable commit
 * marker and is written by JobStore.createJob immediately after this returns.
 */
export async function prepareJobWorkspace(input: {
  jobs_root: string
  job_id: string
  write_datasheet: (datasheet_path: string) => Promise<unknown>
}): Promise<PreparedJobWorkspace> {
  const staging_dir = join(input.jobs_root, `.creating-${input.job_id}`)
  const job_dir = join(input.jobs_root, input.job_id)
  let phase: PreparationPhase = "creating the private workspace"
  let owns_staging_dir = false
  let owns_job_dir = false

  try {
    await mkdir(input.jobs_root, { recursive: true })
    await mkdir(staging_dir)
    owns_staging_dir = true

    phase = "writing the workflow scaffold"
    await writeJobScaffold(staging_dir)

    phase = "storing the datasheet"
    await input.write_datasheet(join(staging_dir, "datasheet.pdf"))

    phase = "publishing the workspace"
    await rename(staging_dir, job_dir)
    owns_staging_dir = false
    owns_job_dir = true
  } catch (cause) {
    if (owns_staging_dir) {
      await rm(staging_dir, { recursive: true, force: true }).catch(() => undefined)
    }
    if (owns_job_dir) {
      await rm(job_dir, { recursive: true, force: true }).catch(() => undefined)
    }
    throw new JobWorkspacePreparationError(phase, cause)
  }

  return {
    job_dir,
    discard: () => rm(job_dir, { recursive: true, force: true }),
  }
}
