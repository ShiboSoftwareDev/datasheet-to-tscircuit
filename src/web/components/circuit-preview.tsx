import { Boxes, LoaderCircle } from "lucide-react"
import { lazy, Suspense } from "react"
import type { Job } from "@/shared/job-types"
import { CodePanel } from "./code-panel"

const CircuitJsonPreview = lazy(async () => {
  const runframe_module = await import("@tscircuit/runframe")
  return { default: runframe_module.CircuitJsonPreview }
})

function EmptyPreview({ job }: { job: Job }) {
  const is_cancelled = job.display_status === "cancelled"
  const is_terminal = job.has_errors || is_cancelled
  const copy = is_cancelled
    ? "This conversion was cancelled before a preview was built."
    : job.has_errors
      ? (job.error_message ?? "The agent could not build a preview.")
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
            ? "Preview unavailable"
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

export function CircuitPreview({ job }: { job: Job }) {
  return (
    <section className="workspace-card preview-card" aria-label="Component preview">
      <div className="viewer-shell">
        {!job.circuit_json ? (
          <EmptyPreview job={job} />
        ) : (
          <Suspense
            fallback={<EmptyPreview job={{ ...job, circuit_json: undefined, display_status: "building" }} />}
          >
            <CircuitJsonPreview
              circuitJson={job.circuit_json}
              code={job.component_code}
              showCodeTab={Boolean(job.component_code)}
              codeTabContent={<CodePanel job={job} />}
              availableTabs={["code", "pcb", "schematic"]}
              defaultActiveTab="pcb"
              defaultTab="pcb"
              showJsonTab={false}
              showRenderLogTab={false}
              showFileMenu
              isWebEmbedded
              projectName={job.file_name.replace(/\.pdf$/i, "")}
            />
          </Suspense>
        )}
      </div>
    </section>
  )
}
