import { Boxes, CircuitBoard, LoaderCircle } from "lucide-react"
import { lazy, Suspense, useState, type ComponentProps } from "react"
import type { Job } from "@/shared/job-types"

type PreviewTab = "schematic" | "pcb"

const SchematicViewer = lazy(async () => {
  const viewer_module = await import("@tscircuit/schematic-viewer")
  return { default: viewer_module.SchematicViewer }
})

const PCBViewer = lazy(async () => {
  const viewer_module = await import("@tscircuit/pcb-viewer")
  return { default: viewer_module.PCBViewer }
})

function EmptyPreview({ job }: { job: Job }) {
  const copy = job.has_errors
    ? (job.error_message ?? "The agent could not build a preview.")
    : job.display_status === "building"
      ? "Compiling TSX into Circuit JSON…"
      : "The preview will appear as soon as the component builds."

  return (
    <div className={`empty-preview ${job.has_errors ? "preview-error" : ""}`}>
      <span className="preview-loader-ring">
        {job.has_errors ? <Boxes size={27} /> : <LoaderCircle className="spin" size={27} />}
      </span>
      <strong>{job.has_errors ? "Preview unavailable" : "Preparing component preview"}</strong>
      <p>{copy}</p>
      {!job.has_errors && (
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

export function CircuitPreview({ job }: { job: Job }) {
  const [preview_tab, setPreviewTab] = useState<PreviewTab>("schematic")
  // pcb-viewer pins an older CircuitJson union; current Circuit JSON is a runtime-compatible superset.
  // @ts-expect-error The viewer's dependency version lags the current circuit-json package.
  const pcb_circuit_json: ComponentProps<typeof PCBViewer>["circuitJson"] = job.circuit_json

  return (
    <section className="workspace-card preview-card" aria-label="Component preview">
      <header className="card-toolbar">
        <div className="preview-tabs" role="tablist" aria-label="Circuit view">
          <button
            className={preview_tab === "schematic" ? "active" : ""}
            role="tab"
            type="button"
            aria-selected={preview_tab === "schematic"}
            onClick={() => setPreviewTab("schematic")}
          >
            <Boxes size={15} /> Schematic
          </button>
          <button
            className={preview_tab === "pcb" ? "active" : ""}
            role="tab"
            type="button"
            aria-selected={preview_tab === "pcb"}
            onClick={() => setPreviewTab("pcb")}
          >
            <CircuitBoard size={15} /> PCB
          </button>
        </div>
        <span className="preview-hint">Scroll to zoom · drag to pan</span>
      </header>
      <div className="viewer-shell">
        {!job.circuit_json ? (
          <EmptyPreview job={job} />
        ) : (
          <Suspense
            fallback={<EmptyPreview job={{ ...job, circuit_json: undefined, display_status: "building" }} />}
          >
            {preview_tab === "schematic" ? (
              <SchematicViewer
                circuitJson={job.circuit_json}
                clickToInteractEnabled
                containerStyle={{ height: "100%", minHeight: 410 }}
              />
            ) : (
              <PCBViewer
                circuitJson={pcb_circuit_json}
                clickToInteractEnabled
                height={470}
                allowEditing={false}
              />
            )}
          </Suspense>
        )}
      </div>
    </section>
  )
}
