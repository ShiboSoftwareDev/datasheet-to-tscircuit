import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import type { JobStore } from "../job-store"
import type { ModelRunStore } from "../model-run-store"
import { JobRestoreMarkerError, restoreJobDirectory } from "./restore-job-directory"
import { restoreModelDirectory } from "./restore-model-directory"

export interface PersistedJobRestoreFailure {
  job_id: string
  error_code: JobRestoreMarkerError["code"] | "job_restore_failed"
  cause: string
}

export async function restorePersistedJobs(input: {
  jobs_root: string
  job_store: JobStore
  model_run_store: ModelRunStore
  on_restore_error?: (failure: PersistedJobRestoreFailure) => void | Promise<void>
}): Promise<{ jobs_restored: number; model_runs_restored: number }> {
  const entries = await readdir(input.jobs_root, { withFileTypes: true })
  let jobs_restored = 0
  let model_runs_restored = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith(".deleting-") || entry.name.startsWith(".creating-")) {
      await rm(join(input.jobs_root, entry.name), { recursive: true, force: true }).catch(() => undefined)
      continue
    }
    const job_dir = join(input.jobs_root, entry.name)
    try {
      const job = await restoreJobDirectory({ job_id: entry.name, job_dir, job_store: input.job_store })
      if (!job) continue
      jobs_restored += 1
      const model_run = await restoreModelDirectory({
        job_id: entry.name,
        model_dir: join(job_dir, "spice"),
        model_run_store: input.model_run_store,
      })
      if (model_run) {
        model_runs_restored += 1
        if (job.use_openai === undefined && model_run.use_openai !== undefined) {
          input.job_store.updateJob(job.job_id, { use_openai: model_run.use_openai })
        } else if (job.use_openai !== undefined && model_run.use_openai !== job.use_openai) {
          input.model_run_store.updateModelRun(model_run.model_run_id, {
            use_openai: job.use_openai,
          })
        }
      }
    } catch (error) {
      const failure = {
        job_id: entry.name,
        error_code: error instanceof JobRestoreMarkerError ? error.code : ("job_restore_failed" as const),
        cause: error instanceof Error ? error.message : String(error),
      }
      if (!input.on_restore_error) {
        console.error("[job-restorer] restore_failed", failure)
        continue
      }
      try {
        await input.on_restore_error(failure)
      } catch (observer_error) {
        console.error("[job-restorer] restore_error_observer_failed", {
          ...failure,
          observer_cause: observer_error instanceof Error ? observer_error.message : String(observer_error),
        })
      }
    }
  }
  return { jobs_restored, model_runs_restored }
}
