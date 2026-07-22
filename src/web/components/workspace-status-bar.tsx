import * as Popover from "@radix-ui/react-popover"
import { Boxes, ChevronDown, CircuitBoard, Download, FlaskConical } from "lucide-react"
import type { Job, JobDisplayStatus, ModelRun, ModelRunStatus } from "@/shared/job-types"
import { getJobFileUrl, getModelRunFileUrl } from "../api"

const COMPONENT_STATUS_COPY: Record<JobDisplayStatus, string> = {
  queued: "Queued",
  agent_running: "Running",
  building: "Building",
  cancelling: "Stopping",
  cancelled: "Cancelled",
  complete: "Ready",
  unsupported: "Not convertible",
  failed: "Failed",
}

const MODEL_STATUS_COPY: Record<ModelRunStatus, string> = {
  queued: "Queued",
  setting_up: "Setting up",
  waiting_for_component: "Waiting",
  running: "Generating",
  validating: "Validating",
  cancelling: "Stopping",
  cancelled: "Cancelled",
  complete: "Ready",
  timed_out: "Timed out",
  failed: "Failed",
}

type StatusTone = "idle" | "working" | "ready" | "unsupported" | "failed"

function getStatusTone(status: string): StatusTone {
  if (status === "Ready") return "ready"
  if (status === "Not convertible") return "unsupported"
  if (["Failed", "Cancelled", "Timed out"].includes(status)) return "failed"
  if (status === "Not started") return "idle"
  return "working"
}

function getModelStatus(model_run: ModelRun | undefined, is_loading: boolean): string {
  if (is_loading) return "Loading"
  if (!model_run) return "Not started"
  if (model_run.status === "timed_out" && !model_run.error_message?.toLowerCase().includes("no output")) {
    return "Failed"
  }
  return MODEL_STATUS_COPY[model_run.status]
}

export function WorkspaceStatusBar({
  job,
  model_run,
  is_model_loading,
}: {
  job: Job
  model_run?: ModelRun
  is_model_loading: boolean
}) {
  const component_status =
    job.component_ready || job.display_status === "complete"
      ? "Ready"
      : COMPONENT_STATUS_COPY[job.display_status]
  const model_status = getModelStatus(model_run, is_model_loading)
  const has_downloads = Boolean(job.component_code || job.typical_application_code || model_run?.model_source)

  return (
    <div className="workspace-status-bar" aria-label="Artifact status and downloads">
      <span
        className={`workspace-artifact-status status-${getStatusTone(component_status)}`}
        aria-label={`Component status: ${component_status}`}
      >
        <Boxes size={12} />
        <span>Component:</span>
        <strong>
          <i /> {component_status}
        </strong>
      </span>
      <span
        className={`workspace-artifact-status status-${getStatusTone(model_status)}`}
        aria-label={`SPICE model status: ${model_status}`}
      >
        <FlaskConical size={12} />
        <span>SPICE model:</span>
        <strong>
          <i /> {model_status}
        </strong>
      </span>
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            className="workspace-download-trigger"
            type="button"
            disabled={!has_downloads}
            aria-label="Download artifacts"
          >
            <Download size={13} /> <span>Download</span> <ChevronDown size={11} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="workspace-download-popover" align="end" sideOffset={7}>
            <strong>Download artifact</strong>
            {job.component_code && (
              <a href={getJobFileUrl(job.job_id, "component")}>
                <Boxes size={14} /> Component TSX
              </a>
            )}
            {job.typical_application_code && (
              <a href={getJobFileUrl(job.job_id, "typical_application")}>
                <CircuitBoard size={14} /> Typical application TSX
              </a>
            )}
            {model_run?.model_source && (
              <a href={getModelRunFileUrl(job.job_id, "model")}>
                <FlaskConical size={14} /> SPICE model
              </a>
            )}
            <Popover.Arrow className="workspace-download-arrow" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}
