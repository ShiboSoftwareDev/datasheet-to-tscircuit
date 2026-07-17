import { CheckCircle2, FlaskConical, LoaderCircle } from "lucide-react"
import type { Job, ModelRun } from "@/shared/job-types"
import { useModelRun } from "../use-model-run"

export function hasValidatedSpiceModel(
  model_run?: Pick<ModelRun, "status" | "model_source" | "validation">,
): boolean {
  return Boolean(
    model_run?.status === "complete" && model_run.model_source && model_run.validation?.all_passed,
  )
}

export function getSpiceRecoveryAction(
  status?: ModelRun["status"],
): "start" | "retry" | "extend" | undefined {
  if (status === undefined) return "start"
  if (status === "failed") return "retry"
  if (status === "timed_out" || status === "cancelled" || status === "complete") return "extend"
  return undefined
}

export function ComponentSpiceStatus({ job }: { job: Job }) {
  const {
    model_run,
    is_loading,
    is_starting,
    is_extending,
    is_retrying,
    error_message,
    start,
    extend,
    retry,
  } = useModelRun(job.job_id)

  if (!job.component_ready && job.display_status !== "complete") return null

  const is_generating = Boolean(model_run && !model_run.is_complete)
  const is_validated = hasValidatedSpiceModel(model_run)
  const recovery_action = getSpiceRecoveryAction(model_run?.status)
  const is_action_pending = is_starting || is_extending || is_retrying

  return (
    <div className="component-spice-status" aria-live="polite">
      <span className="component-spice-heading">
        <FlaskConical size={15} /> SPICE model
      </span>
      {is_validated ? (
        <span className="spice-available-tag">
          <CheckCircle2 size={13} /> SPICE available
        </span>
      ) : is_generating ? (
        <span className="spice-generating-tag">
          <LoaderCircle className="spin" size={13} /> Generating SPICE…
        </span>
      ) : (
        <button
          className="spice-generate-button"
          type="button"
          disabled={is_loading || is_action_pending}
          onClick={() =>
            recovery_action === "retry" ? retry() : recovery_action === "extend" ? extend(1) : start(1)
          }
        >
          {is_action_pending ? <LoaderCircle className="spin" size={13} /> : <FlaskConical size={13} />}
          {is_action_pending
            ? "Starting…"
            : recovery_action === "retry"
              ? "Retry SPICE generation"
              : recovery_action === "extend"
                ? "Continue SPICE validation"
                : "Generate SPICE model"}
        </button>
      )}
      {error_message && <small className="component-spice-error">{error_message}</small>}
    </div>
  )
}
