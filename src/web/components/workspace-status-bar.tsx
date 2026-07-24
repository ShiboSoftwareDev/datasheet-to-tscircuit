import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { Boxes, ChevronDown, ChevronRight, CircuitBoard, Download, FlaskConical } from "lucide-react"
import type { Job, JobDisplayStatus, ModelRun, ModelRunStatus } from "@/shared/job-types"
import { getJobFileUrl, getModelRunFileUrl } from "../api"
import { ArtifactWarningsDialog } from "./artifact-warnings"

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
  if (["Ready", "Ready with warnings", "Output with warnings"].includes(status)) return "ready"
  if (status === "Not convertible") return "unsupported"
  if (["Failed", "Cancelled", "Timed out"].includes(status)) return "failed"
  if (status === "Not started") return "idle"
  return "working"
}

function getModelStatus(model_run: ModelRun | undefined, is_loading: boolean): string {
  if (is_loading) return "Loading"
  if (!model_run) return "Not started"
  if (model_run.status === "complete" && (model_run.warnings?.length ?? 0) > 0) {
    return "Ready with warnings"
  }
  if (model_run.status === "timed_out" && !model_run.error_message?.toLowerCase().includes("no output")) {
    return "Failed"
  }
  return MODEL_STATUS_COPY[model_run.status]
}

export function WorkspaceStatusBar({
  job,
  model_run,
  is_model_loading,
  warnings,
  warning_artifact_label,
}: {
  job: Job
  model_run?: ModelRun
  is_model_loading: boolean
  warnings: string[]
  warning_artifact_label: string
}) {
  const component_status = job.component_ready
    ? (job.warnings?.length ?? 0) > 0
      ? "Ready with warnings"
      : "Ready"
    : job.display_status === "complete" && (job.warnings?.length ?? 0) > 0
      ? "Output with warnings"
      : COMPONENT_STATUS_COPY[job.display_status]
  const model_status = getModelStatus(model_run, is_model_loading)
  const has_downloads = Boolean(job.component_code || job.typical_application_code || model_run?.model_source)

  return (
    <section className="workspace-status-bar" aria-label="Artifact status and downloads">
      <span
        className={`workspace-artifact-status status-${getStatusTone(component_status)}`}
        role="status"
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
        role="status"
        aria-label={`SPICE model status: ${model_status}`}
      >
        <FlaskConical size={12} />
        <span>SPICE model:</span>
        <strong>
          <i /> {model_status}
        </strong>
      </span>
      <ArtifactWarningsDialog warnings={warnings} artifact_label={warning_artifact_label} />
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            className="workspace-download-trigger"
            type="button"
            disabled={!has_downloads}
            aria-label="Download artifacts"
          >
            <Download size={13} /> <span>Download</span> <ChevronDown size={11} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="workspace-download-popover" align="end" sideOffset={7}>
            <DropdownMenu.Label className="workspace-download-label">Download artifact</DropdownMenu.Label>
            {job.component_code && (
              <DropdownMenu.Item asChild>
                <a className="workspace-download-item" href={getJobFileUrl(job.job_id, "component")}>
                  <Boxes size={14} /> Component TSX
                </a>
              </DropdownMenu.Item>
            )}
            {job.typical_application_code && (
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger className="workspace-download-item workspace-download-subtrigger">
                  <CircuitBoard size={14} /> Typical applications <ChevronRight size={12} />
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent
                    className="workspace-download-popover workspace-download-submenu"
                    sideOffset={6}
                    alignOffset={-5}
                  >
                    <DropdownMenu.Item asChild>
                      <a
                        className="workspace-download-item"
                        href={getJobFileUrl(job.job_id, "typical_application")}
                      >
                        <CircuitBoard size={14} /> {job.typical_application_title ?? "Typical application"}{" "}
                        TSX
                      </a>
                    </DropdownMenu.Item>
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            )}
            {model_run?.model_source && (
              <DropdownMenu.Item asChild>
                <a className="workspace-download-item" href={getModelRunFileUrl(job.job_id, "model")}>
                  <FlaskConical size={14} /> SPICE model
                </a>
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Arrow className="workspace-download-arrow" />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </section>
  )
}
