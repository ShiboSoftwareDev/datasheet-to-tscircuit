import type { TabId } from "@tscircuit/runframe"
import { Boxes, CircuitBoard, LoaderCircle } from "lucide-react"
import { lazy, Suspense, useEffect, useState } from "react"
import type { Job } from "@/shared/job-types"
import { CodePanel } from "./code-panel"

const CircuitJsonPreview = lazy(async () => {
  const runframe_module = await import("@tscircuit/runframe")
  return { default: runframe_module.CircuitJsonPreview }
})

type ComponentArtifact = "component" | "typical_application"
export type ComponentPreviewTab = Extract<TabId, "code" | "pcb" | "schematic">

function EmptyPreview({ job, artifact }: { job: Job; artifact: ComponentArtifact }) {
  const is_application = artifact === "typical_application"
  const is_cancelled = job.display_status === "cancelled"
  const is_terminal = job.has_errors || is_cancelled || job.is_complete
  const title = is_application ? "Typical application" : "Component preview"
  const copy = is_cancelled
    ? `This conversion was cancelled before the ${is_application ? "typical application" : "component preview"} was built.`
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
      className={`empty-preview ${job.has_errors ? "preview-error" : ""} ${is_cancelled ? "preview-cancelled" : ""}`}
    >
      <span className="preview-loader-ring">
        {is_terminal ? <Boxes size={27} /> : <LoaderCircle className="spin" size={27} />}
      </span>
      <strong>
        {is_cancelled
          ? "Conversion cancelled"
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
}: {
  job: Job
  artifact: ComponentArtifact
  active_tab: ComponentPreviewTab
  on_active_tab_change: (tab: ComponentPreviewTab) => void
}) {
  const is_application = artifact === "typical_application"
  const circuit_json = is_application ? job.typical_application_circuit_json : job.circuit_json
  const code = is_application ? job.typical_application_code : job.component_code

  if (!circuit_json) return <EmptyPreview job={job} artifact={artifact} />

  return (
    <Suspense fallback={<EmptyPreview job={job} artifact={artifact} />}>
      <CircuitJsonPreview
        key={`${job.job_id}-${artifact}`}
        circuitJson={circuit_json}
        code={code}
        showCodeTab={Boolean(code)}
        codeTabContent={<CodePanel job={job} artifact={artifact} />}
        availableTabs={["code", "pcb", "schematic"]}
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
}: {
  job: Job
  active_tab: ComponentPreviewTab
  on_active_tab_change: (tab: ComponentPreviewTab) => void
}) {
  const [artifact, setArtifact] = useState<ComponentArtifact>("component")

  useEffect(() => setArtifact("component"), [job.job_id])

  return (
    <section className="workspace-card preview-card" aria-label="Component and typical application preview">
      <div className="artifact-tabs" role="tablist" aria-label="Component artifacts">
        <button
          className={artifact === "component" ? "active" : ""}
          type="button"
          role="tab"
          aria-selected={artifact === "component"}
          onClick={() => setArtifact("component")}
        >
          <Boxes size={14} /> Component
        </button>
        <button
          className={artifact === "typical_application" ? "active" : ""}
          type="button"
          role="tab"
          aria-selected={artifact === "typical_application"}
          onClick={() => setArtifact("typical_application")}
        >
          <CircuitBoard size={14} /> Typical application
          {!job.typical_application_circuit_json && !job.is_complete && <i aria-label="In progress" />}
        </button>
      </div>
      <div className="viewer-shell">
        <ArtifactRunframe
          job={job}
          artifact={artifact}
          active_tab={active_tab}
          on_active_tab_change={on_active_tab_change}
        />
      </div>
    </section>
  )
}
