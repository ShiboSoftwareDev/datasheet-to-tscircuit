import { CheckCircle2, FlaskConical, LoaderCircle } from "lucide-react"
import type { Job } from "@/shared/job-types"
import { useModelRun } from "../use-model-run"

export function ComponentSpiceStatus({ job }: { job: Job }) {
  const { model_run, is_loading, is_starting, error_message, start, retry } = useModelRun(job.job_id)

  if (job.display_status !== "complete") return null

  const is_generating = Boolean(model_run && !model_run.is_complete)
  const can_retry =
    model_run?.status === "failed" || model_run?.status === "timed_out" || model_run?.status === "cancelled"

  return (
    <div className="component-spice-status" aria-live="polite">
      <span className="component-spice-heading">
        <FlaskConical size={15} /> SPICE model
      </span>
      {model_run?.model_source ? (
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
          disabled={is_loading || is_starting}
          onClick={() => (can_retry ? retry() : start(1))}
        >
          {is_starting ? <LoaderCircle className="spin" size={13} /> : <FlaskConical size={13} />}
          {is_starting ? "Starting…" : can_retry ? "Retry SPICE generation" : "Generate SPICE model"}
        </button>
      )}
      {error_message && <small className="component-spice-error">{error_message}</small>}
    </div>
  )
}
