import { Download, Terminal } from "lucide-react"
import { useEffect, useRef } from "react"
import type { Job } from "@/shared/job-types"
import { getJobFileUrl } from "../api"

export function AgentLogs({ job }: { job: Job }) {
  const end_ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end_ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }, [job.logs])

  const is_running = !job.is_complete

  return (
    <section className="workspace-card logs-card" aria-label="Agent logs">
      <header className="card-toolbar dark-toolbar">
        <div className="toolbar-title">
          <Terminal size={16} />
          <span>Agent activity</span>
        </div>
        <div className="toolbar-actions">
          {is_running && (
            <span className="live-indicator">
              <i /> LIVE
            </span>
          )}
          <a
            className="toolbar-icon-link"
            href={getJobFileUrl(job.job_id, "log")}
            aria-label="Download complete agent log"
          >
            <Download size={15} />
          </a>
        </div>
      </header>
      <div className="terminal-window" aria-live="polite">
        {job.logs.length === 0 ? <span className="terminal-muted">Waiting for the agent…</span> : null}
        {job.logs.map((log) => (
          <span className={`terminal-chunk terminal-${log.stream}`} key={log.log_id}>
            {log.message}
          </span>
        ))}
        {is_running && <span className="terminal-cursor" />}
        <div ref={end_ref} />
      </div>
    </section>
  )
}
