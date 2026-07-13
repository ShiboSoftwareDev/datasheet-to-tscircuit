import { ArrowLeft, BookOpen, FileText, GitBranch, WandSparkles } from "lucide-react"
import { AgentLogs } from "./components/agent-logs"
import { Brand } from "./components/brand"
import { CircuitPreview } from "./components/circuit-preview"
import { StatusPill } from "./components/status-pill"
import { UploadPanel } from "./components/upload-panel"
import { useActiveJob } from "./use-active-job"

function AppHeader() {
  return (
    <header className="site-header">
      <Brand />
      <nav>
        <a href="https://docs.tscircuit.com/" target="_blank" rel="noreferrer">
          <BookOpen size={15} /> Docs
        </a>
        <a href="https://github.com/tscircuit/tsci-agent" target="_blank" rel="noreferrer">
          <GitBranch size={15} /> tsci-agent
        </a>
      </nav>
    </header>
  )
}

function ProgressSteps({
  display_status,
}: {
  display_status: "queued" | "agent_running" | "building" | "complete" | "failed"
}) {
  const stage = display_status === "queued" ? 1 : display_status === "agent_running" ? 2 : 3
  return (
    <div className="progress-steps" aria-label="Conversion progress">
      {[
        [1, "Upload"],
        [2, "Agent"],
        [3, "Preview"],
      ].map(([step, label]) => (
        <div className={Number(step) <= stage ? "active" : ""} key={label}>
          <span>{Number(step) < stage || display_status === "complete" ? "✓" : step}</span>
          <small>{label}</small>
        </div>
      ))}
    </div>
  )
}

export default function App() {
  const { job, load_error, selectJob, clearJob } = useActiveJob()

  return (
    <div className="app-shell">
      <AppHeader />
      {!job ? (
        <main className="landing-main">
          <div className="landing-glow landing-glow-one" />
          <div className="landing-glow landing-glow-two" />
          {load_error ? (
            <div className="load-error">
              <WandSparkles size={24} />
              <strong>That conversion is no longer available.</strong>
              <p>{load_error}</p>
              <button type="button" onClick={clearJob}>
                Start a new conversion
              </button>
            </div>
          ) : (
            <UploadPanel on_job_created={selectJob} />
          )}
          <div className="landing-caption">
            <span>PDF datasheet</span>
            <i /> <span>tsci agent</span>
            <i /> <span>TSX + Circuit JSON</span>
          </div>
        </main>
      ) : (
        <main className="job-main">
          <section className="job-heading">
            <div className="job-file">
              <span className="job-file-icon">
                <FileText size={19} />
              </span>
              <div>
                <small>Converting datasheet</small>
                <strong>{job.file_name}</strong>
              </div>
            </div>
            <ProgressSteps display_status={job.display_status} />
            <div className="job-heading-actions">
              <StatusPill display_status={job.display_status} />
              <button className="secondary-button" type="button" onClick={clearJob}>
                <ArrowLeft size={15} /> New datasheet
              </button>
            </div>
          </section>

          <div className="workspace-grid">
            <AgentLogs job={job} />
            <div className="preview-column">
              <CircuitPreview job={job} />
            </div>
          </div>
        </main>
      )}
      <footer>
        Built with <a href="https://tscircuit.com">tscircuit</a> · React for circuits
      </footer>
    </div>
  )
}
