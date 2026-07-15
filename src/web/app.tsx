import { Boxes, FlaskConical, LoaderCircle, WandSparkles } from "lucide-react"
import { useEffect, useState } from "react"
import { AgentLogs } from "./components/agent-logs"
import { CircuitPreview } from "./components/circuit-preview"
import { ComponentSpiceStatus } from "./components/component-spice-status"
import { ModelPanel } from "./components/model-panel"
import { TaskSidebar } from "./components/task-sidebar"
import { UploadPanel } from "./components/upload-panel"
import { useActiveJob } from "./use-active-job"

function getInitialSidebarState(): boolean {
  try {
    return window.localStorage.getItem("datasheet-sidebar-collapsed") === "true"
  } catch {
    return false
  }
}

function getInitialWorkspaceTab(): "component" | "model" {
  try {
    return window.localStorage.getItem("datasheet-workspace-tab") === "model" ? "model" : "component"
  } catch {
    return "component"
  }
}

export default function App() {
  const {
    jobs,
    job,
    active_job_id,
    load_error,
    action_error,
    cancelling_job_ids,
    retrying_job_ids,
    deleting_job_ids,
    selectJob,
    selectTask,
    startNewTask,
    cancelTask,
    retryTask,
    deleteTask,
  } = useActiveJob()
  const [is_sidebar_collapsed, setIsSidebarCollapsed] = useState(getInitialSidebarState)
  const [workspace_tab, setWorkspaceTab] = useState<"component" | "model">(getInitialWorkspaceTab)

  useEffect(() => {
    try {
      window.localStorage.setItem("datasheet-sidebar-collapsed", String(is_sidebar_collapsed))
    } catch {
      // The preference is optional when storage is unavailable.
    }
  }, [is_sidebar_collapsed])

  useEffect(() => {
    try {
      window.localStorage.setItem("datasheet-workspace-tab", workspace_tab)
    } catch {
      // The preference is optional when storage is unavailable.
    }
  }, [workspace_tab])

  return (
    <div className={`app-shell ${is_sidebar_collapsed ? "sidebar-collapsed" : ""}`}>
      <TaskSidebar
        jobs={jobs}
        active_job_id={active_job_id}
        action_error={action_error}
        is_collapsed={is_sidebar_collapsed}
        cancelling_job_ids={cancelling_job_ids}
        retrying_job_ids={retrying_job_ids}
        deleting_job_ids={deleting_job_ids}
        on_new_task={startNewTask}
        on_toggle={() => setIsSidebarCollapsed((is_collapsed) => !is_collapsed)}
        on_select_task={selectTask}
        on_cancel_task={cancelTask}
        on_retry_task={retryTask}
        on_delete_task={deleteTask}
      />

      <div className="app-content">
        {!active_job_id ? (
          <main className="landing-main">
            <UploadPanel on_job_created={selectJob} />
          </main>
        ) : load_error ? (
          <main className="landing-main">
            <div className="load-error">
              <WandSparkles size={24} />
              <strong>That conversion is no longer available.</strong>
              <p>{load_error}</p>
              <button type="button" onClick={startNewTask}>
                Start a new task
              </button>
            </div>
          </main>
        ) : !job ? (
          <main className="task-loading" aria-live="polite">
            <LoaderCircle className="spin" size={22} /> Loading task…
          </main>
        ) : (
          <main className="job-main">
            <nav className="workspace-tabs" aria-label="Datasheet artifacts">
              <button
                className={workspace_tab === "component" ? "active" : ""}
                type="button"
                onClick={() => setWorkspaceTab("component")}
              >
                <Boxes size={15} /> Component
              </button>
              <button
                className={workspace_tab === "model" ? "active" : ""}
                type="button"
                onClick={() => setWorkspaceTab("model")}
              >
                <FlaskConical size={15} /> SPICE Model
              </button>
            </nav>
            {workspace_tab === "component" ? (
              <div className="workspace-grid">
                <AgentLogs
                  job={job}
                  is_stopping={job.display_status === "cancelling" || cancelling_job_ids.has(job.job_id)}
                  on_cancel={() => cancelTask(job.job_id)}
                />
                <div className="preview-column">
                  <ComponentSpiceStatus job={job} />
                  <CircuitPreview job={job} />
                </div>
              </div>
            ) : (
              <ModelPanel job={job} />
            )}
          </main>
        )}
      </div>
    </div>
  )
}
