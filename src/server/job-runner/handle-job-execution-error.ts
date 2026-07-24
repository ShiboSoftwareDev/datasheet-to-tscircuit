import { VisualInspectionInconclusiveError } from "../job-artifact-validator"
import type { JobValidation } from "@/shared/job-types"
import type { JobExecution } from "./job-execution"
import { AutomatedConversionUnavailableError, JobCancelledError } from "./stream-job-process"

export async function handleJobExecutionError(error: unknown, execution: JobExecution): Promise<void> {
  if (error instanceof JobCancelledError || execution.cancellation_signal.aborted) {
    await execution
      .append("system", "\nCancellation requested. The active job process was stopped.\n")
      .catch(() => undefined)
    execution.context.job_store.updateJob(execution.job_id, {
      display_status: "cancelled",
      is_complete: true,
      has_errors: false,
      completed_at: new Date().toISOString(),
      error_message: undefined,
    })
    return
  }

  const error_message = error instanceof Error ? error.message : String(error)
  const current_job = execution.context.job_store.getJob(execution.job_id)
  const has_publishable_output = Boolean(
    current_job?.evidence_available ||
      current_job?.component_code ||
      current_job?.circuit_json ||
      current_job?.typical_application_code ||
      current_job?.typical_application_circuit_json,
  )
  const automatic_stop =
    error instanceof AutomatedConversionUnavailableError || error instanceof VisualInspectionInconclusiveError
  const failed_status =
    error instanceof VisualInspectionInconclusiveError
      ? "inconclusive"
      : automatic_stop
        ? "unresolved"
        : "failed"
  if (execution.active_validation_phase === "evidence" && execution.validation.evidence === "pending") {
    execution.updateValidation({ evidence: failed_status })
  } else if (
    execution.active_validation_phase === "component_generation" &&
    execution.validation.component_visual === "pending" &&
    execution.validation.component_build === "pending"
  ) {
    execution.updateValidation({ component_visual: failed_status })
  } else if (
    execution.active_validation_phase === "application_generation" &&
    execution.validation.application_visual === "pending" &&
    execution.validation.application_build === "pending"
  ) {
    execution.updateValidation({ application_visual: failed_status })
  }
  if (has_publishable_output) {
    const warning_validation = Object.fromEntries(
      Object.entries(execution.validation).map(([phase, status]) => [
        phase,
        status === "failed" || status === "inconclusive" || status === "unresolved" ? "warning" : status,
      ]),
    ) as JobValidation
    execution.validation = warning_validation
    execution.context.job_store.updateJob(execution.job_id, { validation: warning_validation })
    await execution
      .addWarning(
        `The best available artifact was published after automatic recovery, but it did not pass every check: ${error_message}`,
      )
      .catch(() => undefined)
    await execution
      .append(
        "system",
        "\nRecovery completed with warnings. The best available evidence or circuit artifact remains available; review the warning before production use.\n",
      )
      .catch(() => undefined)
    execution.context.job_store.updateJob(execution.job_id, {
      display_status: "complete",
      is_complete: true,
      has_errors: false,
      completed_at: new Date().toISOString(),
      error_message: undefined,
    })
    return
  }
  await execution
    .append(
      "system",
      automatic_stop
        ? `\nAutomatic conversion stopped safely: ${error_message}\n`
        : `\nConversion failed: ${error_message}\n`,
    )
    .catch(() => undefined)
  execution.context.job_store.updateJob(execution.job_id, {
    display_status: automatic_stop ? "unsupported" : "failed",
    is_complete: true,
    has_errors: !automatic_stop,
    completed_at: new Date().toISOString(),
    error_message,
  })
}
