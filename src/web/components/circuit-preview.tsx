import type { TabId } from "@tscircuit/runframe"
import { Boxes, CircuitBoard, LoaderCircle } from "lucide-react"
import { lazy, Suspense, useEffect, useState } from "react"
import type { Job } from "@/shared/job-types"
import { CodePanel } from "./code-panel"
import type { ComponentArtifact, ComponentReferenceView } from "./component-preview-types"
import { DatasheetReference } from "./datasheet-reference"

const CircuitJsonPreview = lazy(async () => {
  const runframe_module = await import("@tscircuit/runframe")
  return { default: runframe_module.CircuitJsonPreview }
})

export type ComponentPreviewTab = Extract<TabId, "code" | "pcb" | "schematic">

function EmptyPreview({ job, artifact }: { job: Job; artifact: ComponentArtifact }) {
  const is_application = artifact === "typical_application"
  const is_cancelled = job.display_status === "cancelled"
  const is_unsupported = job.display_status === "unsupported"
  const is_terminal = job.has_errors || is_cancelled || job.is_complete
  const title = is_application ? "Typical application" : "Component preview"
  const copy = is_cancelled
    ? `This conversion was cancelled before the ${is_application ? "typical application" : "component preview"} was built.`
    : is_unsupported
      ? (job.error_message ?? "This datasheet could not be converted automatically without guessing.")
      : job.has_errors
        ? (job.error_message ?? `The agent could not build the ${title.toLowerCase()}.`)
        : job.is_complete
          ? `No ${title.toLowerCase()} artifact is available for this task.`
          : is_application
            ? job.component_ready
              ? "The component is ready. The agent is now creating and verifying the datasheet's typical application."
              : "The typical application will start after the reusable component passes its build milestone."
            : job.display_status === "building"
              ? "Compiling TSX into Circuit JSON…"
              : "The preview will appear as soon as the component builds."

  return (
    <div
      className={`empty-preview ${job.has_errors ? "preview-error" : ""} ${is_cancelled ? "preview-cancelled" : ""} ${is_unsupported ? "preview-unsupported" : ""}`}
    >
      <span className="preview-loader-ring">
        {is_terminal ? <Boxes size={27} /> : <LoaderCircle className="spin" size={27} />}
      </span>
      <strong>
        {is_cancelled
          ? "Conversion cancelled"
          : is_unsupported
            ? "Automatic conversion unavailable"
            : job.has_errors
              ? `${title} unavailable`
              : is_application
                ? "Preparing typical application"
                : "Preparing component preview"}
      </strong>
      <p>{copy}</p>
      {!is_terminal && (
        <div className="preview-skeleton">
          <i />
          <i />
          <i />
          <i />
        </div>
      )}
    </div>
  )
}

function ArtifactRunframe({
  job,
  artifact,
  active_tab,
  on_active_tab_change,
  local_run_id,
  footprint_id,
  application_id,
}: {
  job: Job
  artifact: ComponentArtifact
  active_tab: ComponentPreviewTab
  on_active_tab_change: (tab: ComponentPreviewTab) => void
  local_run_id?: string
  footprint_id?: string
  application_id?: string
}) {
  const is_application = artifact === "typical_application"
  const selected_footprint = !is_application
    ? job.component_footprints?.footprints.find((footprint) => footprint.footprint_id === footprint_id)
    : undefined
  const selected_application = is_application
    ? job.typical_applications?.applications.find(
        (application) => application.application_id === application_id,
      )
    : undefined
  const circuit_json = is_application
    ? (selected_application?.circuit_json ?? job.typical_application_circuit_json)
    : (selected_footprint?.circuit_json ?? job.circuit_json)
  const code = is_application
    ? (selected_application?.code ?? job.typical_application_code)
    : job.component_code

  if (!circuit_json) return <EmptyPreview job={job} artifact={artifact} />
  const has_pcb_artifact = circuit_json.some((element) => element.type.startsWith("pcb_"))
  const available_tabs: ComponentPreviewTab[] = has_pcb_artifact
    ? ["code", "pcb", "schematic"]
    : ["code", "schematic"]

  return (
    <Suspense fallback={<EmptyPreview job={job} artifact={artifact} />}>
      <CircuitJsonPreview
        key={`${job.job_id}-${artifact}-${footprint_id ?? application_id ?? "default"}`}
        circuitJson={circuit_json}
        code={code}
        showCodeTab={Boolean(code)}
        codeTabContent={
          <CodePanel
            job={job}
            artifact={artifact}
            local_run_id={local_run_id}
            application_id={application_id}
          />
        }
        availableTabs={available_tabs}
        defaultActiveTab={active_tab}
        defaultTab={active_tab}
        onActiveTabChange={(tab) => {
          if (tab === "code" || tab === "pcb" || tab === "schematic") on_active_tab_change(tab)
        }}
        showJsonTab={false}
        showRenderLogTab={false}
        showFileMenu
        isWebEmbedded
        projectName={`${job.file_name.replace(/\.pdf$/i, "")}${is_application ? " typical application" : ""}`}
      />
    </Suspense>
  )
}

export function CircuitPreview({
  job,
  active_tab,
  on_active_tab_change,
  local_run_id,
}: {
  job: Job
  active_tab: ComponentPreviewTab
  on_active_tab_change: (tab: ComponentPreviewTab) => void
  local_run_id?: string
}) {
  const [artifact, setArtifact] = useState<ComponentArtifact>("component")
  const [component_reference_view, setComponentReferenceView] = useState<ComponentReferenceView>("footprint")
  const [application_preview_tab, setApplicationPreviewTab] = useState<ComponentPreviewTab>("schematic")
  const [selected_footprint_id, setSelectedFootprintId] = useState(
    job.component_footprints?.default_footprint_id,
  )
  const [selected_application_id, setSelectedApplicationId] = useState(
    job.typical_applications?.default_application_id,
  )
  useEffect(() => {
    setSelectedFootprintId(job.component_footprints?.default_footprint_id)
  }, [job.job_id, job.component_footprints?.default_footprint_id])
  useEffect(() => {
    setSelectedApplicationId(job.typical_applications?.default_application_id)
  }, [job.job_id, job.typical_applications?.default_application_id])
  const footprint_options = job.component_footprints?.footprints ?? []
  const has_multiple_footprints = footprint_options.length > 1
  const application_options = job.typical_applications?.applications ?? []
  const has_multiple_applications = application_options.length > 1
  const artifact_preview_tab = artifact === "component" ? active_tab : application_preview_tab
  const setArtifactPreviewTab = artifact === "component" ? on_active_tab_change : setApplicationPreviewTab

  return (
    <section className="workspace-card preview-card" aria-label="Component and typical application preview">
      {artifact === "component" && has_multiple_footprints && (
        <div className="footprint-selector-bar">
          <span className="multiple-footprints-tag">Multiple footprints</span>
          <label>
            <span className="sr-only">Displayed footprint</span>
            <select
              value={selected_footprint_id}
              onChange={(event) => setSelectedFootprintId(event.target.value)}
            >
              {footprint_options.map((footprint) => (
                <option key={footprint.footprint_id} value={footprint.footprint_id}>
                  {footprint.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {artifact === "typical_application" && has_multiple_applications && (
        <div className="footprint-selector-bar">
          <span className="multiple-footprints-tag">Multiple applications</span>
          <label>
            <span className="sr-only">Displayed application</span>
            <select
              value={selected_application_id}
              onChange={(event) => setSelectedApplicationId(event.target.value)}
            >
              {application_options.map((application) => (
                <option key={application.application_id} value={application.application_id}>
                  {application.title}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <div className="artifact-tabs" role="tablist" aria-label="Component artifacts">
        <div className="artifact-tab-group">
          <button
            className={artifact === "component" ? "active" : ""}
            type="button"
            role="tab"
            aria-selected={artifact === "component"}
            onClick={() => setArtifact("component")}
          >
            <Boxes size={14} /> Component
          </button>
        </div>
        <div className="artifact-tab-group">
          <button
            className={artifact === "typical_application" ? "active" : ""}
            type="button"
            role="tab"
            aria-selected={artifact === "typical_application"}
            onClick={() => setArtifact("typical_application")}
          >
            <CircuitBoard size={14} /> Typical application
            {!job.typical_application_circuit_json && !job.is_complete && <i title="In progress" />}
          </button>
        </div>
      </div>
      <div className="artifact-preview-grid">
        <div className="viewer-shell">
          <ArtifactRunframe
            job={job}
            artifact={artifact}
            active_tab={artifact_preview_tab}
            on_active_tab_change={setArtifactPreviewTab}
            local_run_id={local_run_id}
            footprint_id={artifact === "component" ? selected_footprint_id : undefined}
            application_id={artifact === "typical_application" ? selected_application_id : undefined}
          />
        </div>
        <DatasheetReference
          job={job}
          artifact={artifact}
          component_view={component_reference_view}
          on_component_view_change={setComponentReferenceView}
          local_run_id={local_run_id}
          footprint_id={artifact === "component" ? selected_footprint_id : undefined}
          application_id={artifact === "typical_application" ? selected_application_id : undefined}
        />
      </div>
    </section>
  )
}
