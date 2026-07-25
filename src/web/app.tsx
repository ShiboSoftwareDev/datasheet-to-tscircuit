import { Boxes, FlaskConical, LoaderCircle, PanelLeftOpen, Terminal, WandSparkles } from "lucide-react"
import { useEffect, useState } from "react"
import { AgentLogs } from "./components/agent-logs"
import { CircuitPreview, type ComponentPreviewTab } from "./components/circuit-preview"
import { ModelAgentLogs, ModelPanel } from "./components/model-panel"
import { TaskSidebar } from "./components/task-sidebar"
import { UploadPanel } from "./components/upload-panel"
import { WorkspaceStatusBar } from "./components/workspace-status-bar"
import { useActiveJob } from "./use-active-job"
import { useModelRun } from "./use-model-run"

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
  const model_run_state = useModelRun(active_job_id)
  const [is_sidebar_open, setIsSidebarOpen] = useState(false)
  const [is_terminal_open, setIsTerminalOpen] = useState(false)
  const [workspace_tab, setWorkspaceTab] = useState<"component" | "model">(getInitialWorkspaceTab)
  const [component_preview_tab, setComponentPreviewTab] = useState<ComponentPreviewTab>("pcb")

  useEffect(() => {
    try {
      window.localStorage.setItem("datasheet-workspace-tab", workspace_tab)
    } catch {
      // The preference is optional when storage is unavailable.
    }
  }, [workspace_tab])

  useEffect(() => {
    if (!is_sidebar_open) return
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".task-sidebar")) return
      setIsSidebarOpen(false)
    }
    document.addEventListener("pointerdown", closeOnOutsidePointerDown)
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown)
  }, [is_sidebar_open])

  useEffect(() => {
    if (!is_terminal_open) return
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".terminal-drawer")) return
      setIsTerminalOpen(false)
    }
    document.addEventListener("pointerdown", closeOnOutsidePointerDown)
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointerDown)
  }, [is_terminal_open])

  const openSidebar = () => {
    setIsTerminalOpen(false)
    setIsSidebarOpen(true)
  }

  const openTerminal = () => {
    setIsSidebarOpen(false)
    setIsTerminalOpen(true)
  }

  return (
    <div
      className={`app-shell ${is_sidebar_open ? "sidebar-open" : ""} ${is_terminal_open ? "terminal-open" : ""}`}
    >
      {!is_sidebar_open && (
        <button
          className="edge-toggle edge-toggle-left"
          type="button"
          aria-label="Open task sidebar"
          title="Open task sidebar"
          onClick={openSidebar}
        >
          <PanelLeftOpen size={18} />
        </button>
      )}

      <TaskSidebar
        jobs={jobs}
        active_job_id={active_job_id}
        action_error={action_error}
        is_open={is_sidebar_open}
        cancelling_job_ids={cancelling_job_ids}
        retrying_job_ids={retrying_job_ids}
        deleting_job_ids={deleting_job_ids}
        on_new_task={() => {
          setIsSidebarOpen(false)
          startNewTask()
        }}
        on_toggle={() => setIsSidebarOpen(false)}
        on_select_task={(job_id) => {
          if (job_id === active_job_id) {
            setIsSidebarOpen(false)
            return
          }
          selectTask(job_id)
        }}
        on_cancel_task={cancelTask}
        on_retry_task={retryTask}
        on_delete_task={deleteTask}
      />

      {job && (
        <>
          {!is_terminal_open && (
            <button
              className="edge-toggle edge-toggle-right"
              type="button"
              aria-label={`Open ${workspace_tab === "model" ? "SPICE model" : "component"} terminal`}
              title={`Open ${workspace_tab === "model" ? "SPICE model" : "component"} terminal`}
              onClick={openTerminal}
            >
              <Terminal size={18} />
            </button>
          )}
          <aside
            className="terminal-drawer"
            aria-label="Agent terminal"
            aria-hidden={!is_terminal_open}
            inert={!is_terminal_open}
          >
            {workspace_tab === "component" ? (
              <AgentLogs
                job={job}
                is_stopping={job.display_status === "cancelling" || cancelling_job_ids.has(job.job_id)}
                on_cancel={() => cancelTask(job.job_id)}
                on_close={() => setIsTerminalOpen(false)}
              />
            ) : (
              <ModelAgentLogs model_run_state={model_run_state} on_close={() => setIsTerminalOpen(false)} />
            )}
          </aside>
        </>
      )}

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
          <main className={`job-main ${workspace_tab === "component" ? "component-page" : "model-page"}`}>
            <div className="workspace-topbar">
              <WorkspaceStatusBar
                job={job}
                model_run={model_run_state.model_run}
                is_model_loading={model_run_state.is_loading}
              />
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
            </div>
            <div className="workspace-body">
              {workspace_tab === "component" ? (
                <div className="workspace-grid">
                  <div className="preview-column">
                    <CircuitPreview
                      key={job.job_id}
                      job={job}
                      active_tab={component_preview_tab}
                      on_active_tab_change={setComponentPreviewTab}
                    />
                  </div>
                </div>
              ) : (
                <ModelPanel job={job} model_run_state={model_run_state} />
              )}
            </div>
          </main>
        )}
      </div>
    </div>
  )
}
