import { CircuitBoard, FileImage, ImageOff, LoaderCircle, Network } from "lucide-react"
import { useEffect, useState } from "react"
import type { Job } from "@/shared/job-types"
import { getJobFileUrl, type JobFileKind } from "../api"
import type { ComponentArtifact, ComponentReferenceView } from "./component-preview-types"

function ReferenceEmpty({ job, failed }: { job: Job; failed: boolean }) {
  const is_waiting = !job.evidence_available && !job.is_complete
  return (
    <div className="datasheet-reference-empty">
      {is_waiting ? <LoaderCircle className="spin" size={25} /> : <ImageOff size={25} />}
      <strong>{is_waiting ? "Waiting for datasheet evidence" : "Reference image unavailable"}</strong>
      <p>
        {is_waiting
          ? "The selected datasheet page will appear as soon as the evidence pass finishes."
          : failed
            ? "The datasheet did not provide an image for this view."
            : "No retained datasheet image is available for this view."}
      </p>
    </div>
  )
}

export function DatasheetReference({
  job,
  artifact,
  component_view,
  on_component_view_change,
}: {
  job: Job
  artifact: ComponentArtifact
  component_view: ComponentReferenceView
  on_component_view_change: (view: ComponentReferenceView) => void
}) {
  const is_application = artifact === "typical_application"
  const view = is_application ? "schematic" : component_view
  const file_kind: JobFileKind = is_application
    ? "application_reference"
    : view === "footprint"
      ? "land_pattern"
      : "component_schematic_reference"
  const image_url = getJobFileUrl(job.job_id, file_kind, "inline")
  const [image_failed, setImageFailed] = useState(false)

  useEffect(() => setImageFailed(false), [image_url, job.evidence_available])

  const image_label = view === "footprint" ? "footprint" : "schematic"

  return (
    <section className="datasheet-reference-pane" aria-label={`Datasheet ${image_label} reference`}>
      <header className="datasheet-reference-toolbar">
        {is_application ? (
          <span className="datasheet-reference-title">
            <FileImage size={14} /> Datasheet schematic
          </span>
        ) : (
          <div className="reference-view-tabs" role="tablist" aria-label="Component reference view">
            <button
              className={component_view === "footprint" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={component_view === "footprint"}
              onClick={() => on_component_view_change("footprint")}
            >
              <CircuitBoard size={14} /> Footprint
            </button>
            <button
              className={component_view === "schematic" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={component_view === "schematic"}
              onClick={() => on_component_view_change("schematic")}
            >
              <Network size={14} /> Schematic
            </button>
          </div>
        )}
      </header>
      <div className="datasheet-reference-content">
        {!job.evidence_available || image_failed ? (
          <ReferenceEmpty job={job} failed={image_failed} />
        ) : (
          <img
            className="datasheet-reference-image"
            key={image_url}
            src={image_url}
            alt={`Datasheet ${image_label} reference for ${job.file_name}`}
            draggable={false}
            onError={() => setImageFailed(true)}
          />
        )}
      </div>
    </section>
  )
}
