import * as DropdownMenu from "@radix-ui/react-dropdown-menu"
import { Boxes, ChevronRight, CircuitBoard, Download, FileCode2, FlaskConical } from "lucide-react"
import type { Job, JobDisplayStatus, ModelRun, ModelRunStatus } from "@/shared/job-types"
import { isModelRunPaused } from "@/shared/model-run-status"
import { hasRetainedAcceptedModel } from "@/shared/model-warnings"
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
  unsupported: "Not simulatable",
  timed_out: "Timed out",
  failed: "Failed",
}

type StatusTone = "idle" | "working" | "ready" | "unsupported" | "failed"

function getStatusTone(status: string): StatusTone {
  if (["Ready", "Ready with warnings", "Output with warnings"].includes(status)) return "ready"
  if (["Not convertible", "Not simulatable"].includes(status)) return "unsupported"
  if (["Failed", "Cancelled", "Timed out"].includes(status)) return "failed"
  if (status === "Not started") return "idle"
  return "working"
}

function getModelStatus(model_run: ModelRun | undefined, is_loading: boolean): string {
  if (is_loading) return "Loading"
  if (!model_run) return "Not started"
  if (isModelRunPaused(model_run)) return "Paused"
  if (model_run.status === "complete" && (model_run.warnings?.length ?? 0) > 0) {
    return "Ready with warnings"
  }
  if (model_run.status === "timed_out" && !model_run.error_message?.toLowerCase().includes("no output")) {
    return "Failed"
  }
  return MODEL_STATUS_COPY[model_run.status]
}

function getCompactStatus(status: string): string {
  if (status === "Ready with warnings" || status === "Output with warnings") return "Ready"
  if (["Not convertible", "Not simulatable"].includes(status)) return "Unavailable"
  if (status === "Not started") return "Off"
  return status
}

export function WorkspaceStatusBar({
  job,
  model_run,
  is_model_loading,
  local_run_id,
}: {
  job: Job
  model_run?: ModelRun
  is_model_loading: boolean
  local_run_id?: string
}) {
  const component_status = job.component_ready
    ? (job.warnings?.length ?? 0) > 0
      ? "Ready with warnings"
      : "Ready"
    : job.display_status === "complete" && (job.warnings?.length ?? 0) > 0
      ? "Output with warnings"
      : COMPONENT_STATUS_COPY[job.display_status]
  const model_status = getModelStatus(model_run, is_model_loading)
  const has_retained_accepted_model = model_run ? hasRetainedAcceptedModel(model_run) : false
  const compact_model_status = `${getCompactStatus(model_status)}${
    has_retained_accepted_model ? " · Retained" : ""
  }`
  const catalog_applications = job.typical_applications?.applications.filter(
    (application) => application.code,
  )
  const typical_applications =
    catalog_applications && catalog_applications.length > 0
      ? catalog_applications
      : job.typical_application_code
        ? [
            {
              application_id: "reference",
              title: job.typical_application_title ?? "Typical application",
              code: job.typical_application_code,
              circuit_json: job.typical_application_circuit_json,
            },
          ]
        : []
  const has_downloads = Boolean(
    job.component_code || typical_applications.length > 0 || model_run?.model_source,
  )

  return (
    <section className="workspace-status-bar" aria-label="Artifact status and downloads">
      <div className="workspace-artifact-group">
        <span
          className={`workspace-artifact-status status-${getStatusTone(component_status)}`}
          role="status"
          aria-label={`Component status: ${component_status}`}
          title={`Component: ${component_status}`}
        >
          <Boxes size={12} />
          <span className="workspace-status-name">Component</span>
          <strong>
            <i />
            <span>{getCompactStatus(component_status)}</span>
          </strong>
        </span>
        <ArtifactWarningsDialog warnings={job.warnings ?? []} artifact_label="Component" />
      </div>
      <div className="workspace-artifact-group">
        <span
          className={`workspace-artifact-status status-${getStatusTone(model_status)}`}
          role="status"
          aria-label={`SPICE model status: ${model_status}${
            has_retained_accepted_model ? "; accepted model retained" : ""
          }`}
          title={`SPICE model: ${model_status}${
            has_retained_accepted_model ? "; accepted model retained" : ""
          }`}
        >
          <FlaskConical size={12} />
          <span className="workspace-status-name">SPICE</span>
          <strong>
            <i />
            <span>{compact_model_status}</span>
          </strong>
        </span>
        <ArtifactWarningsDialog warnings={model_run?.warnings ?? []} artifact_label="SPICE model" />
      </div>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            className="workspace-download-trigger"
            type="button"
            disabled={!has_downloads}
            aria-label="Download artifacts"
            title="Download artifacts"
          >
            <Download size={13} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="workspace-download-popover" align="end" sideOffset={7}>
            <DropdownMenu.Label className="workspace-download-label">Download artifact</DropdownMenu.Label>
            {job.component_code && (
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger className="workspace-download-item workspace-download-subtrigger">
                  <Boxes size={14} /> Component <ChevronRight size={12} />
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
                        href={getJobFileUrl(job.job_id, "component_tsx", { local_run_id })}
                      >
                        <FileCode2 size={14} /> TSX
                      </a>
                    </DropdownMenu.Item>
                    {(job.circuit_json ||
                      job.component_footprints?.footprints.some((footprint) => footprint.circuit_json)) && (
                      <DropdownMenu.Item asChild>
                        <a
                          className="workspace-download-item"
                          href={getJobFileUrl(job.job_id, "component_kicad", { local_run_id })}
                        >
                          <CircuitBoard size={14} /> KiCad
                        </a>
                      </DropdownMenu.Item>
                    )}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            )}
            {typical_applications.length > 0 && (
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
                    {typical_applications.map((application) => (
                      <DropdownMenu.Group key={application.application_id}>
                        <DropdownMenu.Label className="workspace-download-label">
                          {application.title}
                        </DropdownMenu.Label>
                        <DropdownMenu.Item asChild>
                          <a
                            className="workspace-download-item"
                            href={getJobFileUrl(job.job_id, "typical_application_tsx", {
                              local_run_id,
                              application_id: application.application_id,
                            })}
                          >
                            <FileCode2 size={14} /> TSX
                          </a>
                        </DropdownMenu.Item>
                        {application.circuit_json && (
                          <DropdownMenu.Item asChild>
                            <a
                              className="workspace-download-item"
                              href={getJobFileUrl(job.job_id, "typical_application_kicad", {
                                local_run_id,
                                application_id: application.application_id,
                              })}
                            >
                              <CircuitBoard size={14} /> KiCad
                            </a>
                          </DropdownMenu.Item>
                        )}
                      </DropdownMenu.Group>
                    ))}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            )}
            {model_run?.model_source && (
              <DropdownMenu.Item asChild>
                <a
                  className="workspace-download-item"
                  href={getModelRunFileUrl(job.job_id, "model", local_run_id)}
                >
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
