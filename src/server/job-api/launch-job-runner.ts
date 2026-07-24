import { runJob } from "../job-runner"
import type { JobStore } from "../job-store"
import { JobApiContext } from "./job-api-context"

interface UnexpectedRunnerFailure {
  job_id: string
  error: unknown
}

async function recordUnexpectedRunnerFailure(
  { job_id, error }: UnexpectedRunnerFailure,
  job_store: JobStore,
): Promise<void> {
  try {
    const job = job_store.getJob(job_id)
    if (!job || job.is_complete) return
    const detail = error instanceof Error ? error.message : String(error)
    const has_publishable_output = Boolean(
      job.evidence_available ||
        job.component_code ||
        job.circuit_json ||
        job.typical_application_code ||
        job.typical_application_circuit_json,
    )
    await job_store
      .appendLog(job_id, {
        stream: "system",
        message: `\nConversion stopped after an unexpected runner failure: ${detail}\n`,
      })
      .catch(() => undefined)
    job_store.updateJob(job_id, {
      display_status: has_publishable_output ? "complete" : "failed",
      is_complete: true,
      has_errors: !has_publishable_output,
      completed_at: new Date().toISOString(),
      error_message: has_publishable_output ? undefined : detail,
      ...(has_publishable_output
        ? {
            warnings: [
              ...(job.warnings ?? []),
              `The best available output was published after an unexpected runner recovery: ${detail}`,
            ],
          }
        : {}),
    })
  } catch {
    // This is the final background-task boundary. Never leak a rejected runner promise.
  }
}

export function launchJobRunner(input: Parameters<typeof runJob>[0], context: JobApiContext): void {
  const runner = context.run_job ?? runJob
  try {
    void runner(input, context).catch((error) =>
      recordUnexpectedRunnerFailure({ job_id: input.job_id, error }, context.job_store),
    )
  } catch (error) {
    void recordUnexpectedRunnerFailure({ job_id: input.job_id, error }, context.job_store)
  }
}
