import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectJobProvenance } from "./collect-job-provenance"
import { completeComponentOnlyJob } from "./complete-component-only-job"
import { handleJobExecutionError } from "./handle-job-execution-error"
import { JobExecution } from "./job-execution"
import { runApplicationGenerationPhase } from "./run-application-generation-phase"
import { runComponentGenerationPhase } from "./run-component-generation-phase"
import { runEvidencePhase } from "./run-evidence-phase"
import { type JobRunnerContext, throwIfCancelled } from "./stream-job-process"

export async function runJob(
  input: { job_id: string; additional_instructions?: string },
  context: JobRunnerContext,
): Promise<void> {
  const job_dir = context.job_store.getJobDir(input.job_id)
  if (!job_dir) throw new Error(`Job ${input.job_id} was not found`)
  const cancellation_signal = context.job_store.getCancellationSignal(input.job_id)
  if (!cancellation_signal) throw new Error(`Job ${input.job_id} has no cancellation signal`)

  const protected_event_directory = await mkdtemp(join(tmpdir(), "datasheet-agent-events-"))
  const execution = new JobExecution({
    ...input,
    job_dir,
    cancellation_signal,
    context,
    protected_event_log_file: join(protected_event_directory, "agent-events.jsonl"),
    published_event_log_file: join(job_dir, "agent-events.jsonl"),
  })

  try {
    throwIfCancelled(cancellation_signal)
    const provenance = await collectJobProvenance({
      job_dir,
      additional_instructions: input.additional_instructions,
    })
    context.job_store.updateJob(input.job_id, {
      display_status: "agent_running",
      validation: execution.validation,
      provenance,
    })
    await execution.append(
      "system",
      `Workflow runtime source: ${provenance.source_commit}. This identifier must match the code revision intended for the task.\n`,
    )

    const evidence = await runEvidencePhase(execution)
    const component = await runComponentGenerationPhase(evidence, execution)
    if (evidence.typical_application_plan.availability === "not_present") {
      await completeComponentOnlyJob(evidence, execution)
      return
    }
    await runApplicationGenerationPhase({ evidence, component, execution })
  } catch (error) {
    await handleJobExecutionError(error, execution)
  } finally {
    await rm(protected_event_directory, { recursive: true, force: true }).catch(() => undefined)
  }
}
