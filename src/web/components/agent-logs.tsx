import { Download, Square, Terminal, X } from "lucide-react"
import type { Job } from "@/shared/job-types"
import { getJobFileUrl } from "../api"
import { AgentLogViewer } from "./agent-log-viewer"

export function AgentLogs({
  job,
  is_stopping,
  on_cancel,
  on_close,
}: {
  job: Job
  is_stopping: boolean
  on_cancel: () => void
  on_close: () => void
}) {
  const is_running = !job.is_complete

  return (
    <section className="workspace-card logs-card" aria-label="Agent logs">
      <header className="card-toolbar dark-toolbar">
        <div className="toolbar-title">
          <Terminal size={16} />
          <span title={job.file_name}>{job.file_name.replace(/\.pdf$/i, "")}</span>
        </div>
        <div className="toolbar-actions">
          {is_running && (
            <span className="run-indicator">
              <i /> {is_stopping ? "STOPPING…" : "RUNNING"}
            </span>
          )}
          {is_running && (
            <button className="stop-run-button" type="button" disabled={is_stopping} onClick={on_cancel}>
              <Square size={9} fill="currentColor" />
              {is_stopping ? "Stopping…" : "Stop run"}
            </button>
          )}
          <a
            className="toolbar-icon-link"
            href={getJobFileUrl(job.job_id, "log")}
            aria-label="Download complete agent log"
          >
            <Download size={15} />
          </a>
          <button
            className="terminal-close-button"
            type="button"
            aria-label="Close agent terminal"
            title="Close agent terminal"
            onClick={on_close}
          >
            <X size={18} />
          </button>
        </div>
      </header>
      <AgentLogViewer
        className="terminal-window"
        empty_message="Waiting for the agent…"
        is_running={is_running}
        logs={job.logs}
      />
    </section>
  )
}
