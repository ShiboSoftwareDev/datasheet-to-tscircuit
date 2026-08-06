import { Boxes, FlaskConical, LoaderCircle, PanelLeftOpen, Terminal, WandSparkles } from "lucide-react"
import { useEffect, useState } from "react"
import { AgentLogs } from "./components/agent-logs"
import { CircuitPreview, type ComponentPreviewTab } from "./components/circuit-preview"
import { ModelAgentLogs, ModelPanel } from "./components/model-panel"
import { TaskSidebar } from "./components/task-sidebar"
import { UploadPanel } from "./components/upload-panel"
import { WorkspaceStatusBar } from "./components/workspace-status-bar"
import { PipelineDebugger } from "./components/pipeline-debugger"
import { useActiveJob } from "./use-active-job"
import { useModelRun } from "./use-model-run"
import { useLocalRuns } from "./use-local-runs"

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
    job: task_job,
    active_job_id,
    load_error: task_load_error,
    action_error: task_action_error,
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
  const local_run_state = useLocalRuns()
  const active_local_run_id = local_run_state.active_local_run_id
  const job = active_local_run_id ? local_run_state.detail?.job : task_job
  const load_error = active_local_run_id ? local_run_state.load_error : task_load_error
  const action_error = local_run_state.action_error ?? task_action_error
  const model_run_state = useModelRun(job?.job_id, active_local_run_id)
  const [is_sidebar_open, setIsSidebarOpen] = useState(false)
  const [is_terminal_open, setIsTerminalOpen] = useState(false)
  const [workspace_tab, setWorkspaceTab] = useState<"component" | "model">(getInitialWorkspaceTab)
  const [component_preview_tab, setComponentPreviewTab] = useState<ComponentPreviewTab>("pcb")
  const [sidebar_view, setSidebarView] = useState<"tasks" | "local">(active_local_run_id ? "local" : "tasks")

  const selectLocalRun = (localRun: (typeof local_run_state.local_runs)[number]) => {
    startNewTask()
    local_run_state.selectLocalRun(localRun)
    setSidebarView("local")
  }

  const clearLocalRun = () => local_run_state.setActiveLocalRunId(undefined)

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
        local_runs={local_run_state.local_runs}
        active_job_id={active_job_id}
        active_local_run_id={active_local_run_id}
        active_view={sidebar_view}
        action_error={action_error}
        is_open={is_sidebar_open}
        cancelling_job_ids={cancelling_job_ids}
        retrying_job_ids={retrying_job_ids}
        deleting_job_ids={deleting_job_ids}
        rerunning_local_run_ids={local_run_state.rerunning_local_run_ids}
        on_new_task={() => {
          setIsSidebarOpen(false)
          clearLocalRun()
          startNewTask()
        }}
        on_toggle={() => setIsSidebarOpen(false)}
        on_select_task={(job_id) => {
          if (job_id === active_job_id && !active_local_run_id) {
            setIsSidebarOpen(false)
            return
          }
          clearLocalRun()
          selectTask(job_id)
          setSidebarView("tasks")
        }}
        on_select_local={(localRun) => {
          if (localRun.local_run_id === active_local_run_id) {
            setIsSidebarOpen(false)
            return
          }
          selectLocalRun(localRun)
        }}
        on_view_change={setSidebarView}
        on_cancel_task={cancelTask}
        on_retry_task={(jobId) => {
          clearLocalRun()
          void retryTask(jobId)
          setSidebarView("tasks")
        }}
        on_delete_task={deleteTask}
        on_rerun_local={(localRunId) => void local_run_state.runAgain(localRunId)}
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
                is_stopping={
                  !active_local_run_id &&
                  (job.display_status === "cancelling" || cancelling_job_ids.has(job.job_id))
                }
                on_cancel={() => {
                  if (!active_local_run_id) void cancelTask(job.job_id)
                }}
                on_close={() => setIsTerminalOpen(false)}
                local_run_id={active_local_run_id}
              />
            ) : (
              <ModelAgentLogs model_run_state={model_run_state} on_close={() => setIsTerminalOpen(false)} />
            )}
          </aside>
        </>
      )}

      <div className="app-content">
        {!active_job_id && !active_local_run_id ? (
          <main className="landing-main">
            <UploadPanel
              on_job_created={(nextJob) => {
                clearLocalRun()
                selectJob(nextJob)
              }}
            />
          </main>
        ) : load_error ? (
          <main className="landing-main">
            <div className="load-error">
              <WandSparkles size={24} />
              <strong>That conversion is no longer available.</strong>
              <p>{load_error}</p>
              <button
                type="button"
                onClick={() => {
                  clearLocalRun()
                  startNewTask()
                }}
              >
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
                local_run_id={active_local_run_id}
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
              <PipelineDebugger
                job={job}
                model_run={model_run_state.model_run}
                local_run={local_run_state.detail?.local_run}
                is_rerunning_local={
                  active_local_run_id
                    ? local_run_state.rerunning_local_run_ids.has(active_local_run_id)
                    : false
                }
                on_local_run_started={selectLocalRun}
                on_rerun_local={(localRunId) => void local_run_state.runAgain(localRunId)}
              />
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
                      local_run_id={active_local_run_id}
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
