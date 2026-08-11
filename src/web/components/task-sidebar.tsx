import {
  Boxes,
  FlaskConical,
  Laptop,
  LoaderCircle,
  PanelLeftClose,
  Plus,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react"
import type { JobDisplayStatus, JobSummary, ModelRunStatus } from "@/shared/job-types"
import type { LocalRunSummary } from "@/shared/local-run"
import { Brand } from "./brand"

const STATUS_COPY: Record<JobDisplayStatus, string> = {
  queued: "Queued",
  agent_running: "Running",
  building: "Building",
  cancelling: "Stopping",
  cancelled: "Cancelled",
  complete: "Ready",
  unsupported: "Not convertible",
  failed: "Failed",
}

function isWorking(status: JobDisplayStatus): boolean {
  return status === "queued" || status === "agent_running" || status === "building" || status === "cancelling"
}

function formatTaskTime(created_at: string): string {
  const created = new Date(created_at)
  return Number.isNaN(created.valueOf())
    ? ""
    : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(created)
}

const MODEL_STATUS_COPY: Record<ModelRunStatus, string> = {
  queued: "Queued",
  setting_up: "Setting up",
  waiting_for_component: "Waiting",
  running: "Generating",
  validating: "Validating",
  cancelling: "Stopping",
  cancelled: "Cancelled",
  complete: "Ready",
  unsupported: "Not simulatable",
  timed_out: "Timed out",
  failed: "Failed",
}

function getModelStatusCopy(status: ModelRunStatus, error_message?: string): string {
  if (status === "timed_out" && !error_message?.toLowerCase().includes("no output")) return "Failed"
  return MODEL_STATUS_COPY[status]
}

function getStatusTone(status: string): string {
  if (["Ready", "Complete", "Validated"].includes(status)) return "ready"
  if (["Not convertible", "Not simulatable"].includes(status)) return "unsupported"
  if (["Failed", "Cancelled", "Stopped", "Timed out"].includes(status)) return "failed"
  return "working"
}

function TaskStatus({ task }: { task: JobSummary }) {
  const model_run = task.model_run
  const component_ready = Boolean(task.component_ready)
  const model_ready = model_run?.status === "complete" && model_run.has_model
  if (!model_run) {
    return (
      <span className="task-statuses">
        <span
          className={`task-state task-state-component ${component_ready ? "ready" : ""}`}
          aria-label={`Component ${component_ready ? "Ready" : STATUS_COPY[task.display_status]}`}
          title={`Component ${component_ready ? "Ready" : STATUS_COPY[task.display_status]}`}
        >
          <Boxes size={10} />
          <span
            className={`task-state-label task-state-label-${getStatusTone(component_ready ? "Ready" : STATUS_COPY[task.display_status])}`}
          >
            {component_ready ? "Ready" : STATUS_COPY[task.display_status]}
          </span>
        </span>
      </span>
    )
  }
  const latest_model_copy = model_ready
    ? "Ready"
    : getModelStatusCopy(model_run.status, model_run.error_message)
  const model_copy = model_run.has_retained_accepted_model
    ? `${latest_model_copy} · Retained`
    : latest_model_copy

  return (
    <span className="task-statuses">
      <span
        className={`task-state task-state-component ${component_ready ? "ready" : ""}`}
        aria-label={`Component ${component_ready ? "Ready" : STATUS_COPY[task.display_status]}`}
        title={`Component ${component_ready ? "Ready" : STATUS_COPY[task.display_status]}`}
      >
        <Boxes size={10} />
        <span
          className={`task-state-label task-state-label-${getStatusTone(component_ready ? "Ready" : STATUS_COPY[task.display_status])}`}
        >
          {component_ready ? "Ready" : STATUS_COPY[task.display_status]}
        </span>
      </span>
      <span
        className={`task-state task-state-model ${model_ready ? "ready" : ""}`}
        aria-label={`Model ${model_copy}`}
        title={
          model_run.has_retained_accepted_model
            ? `Model ${latest_model_copy}; accepted model retained`
            : `Model ${model_copy}`
        }
      >
        <FlaskConical size={10} />
        <span className={`task-state-label task-state-label-${getStatusTone(latest_model_copy)}`}>
          {model_copy}
        </span>
      </span>
    </span>
  )
}

interface TaskSidebarProps {
  jobs: JobSummary[]
  local_runs: LocalRunSummary[]
  active_job_id?: string
  active_local_run_id?: string
  active_view: "tasks" | "local"
  action_error?: string
  is_open: boolean
  cancelling_job_ids: Set<string>
  retrying_job_ids: Set<string>
  deleting_job_ids: Set<string>
  rerunning_local_run_ids: Set<string>
  on_new_task: () => void
  on_toggle: () => void
  on_select_task: (job_id: string) => void
  on_select_local: (local_run: LocalRunSummary) => void
  on_view_change: (view: "tasks" | "local") => void
  on_cancel_task: (job_id: string) => void
  on_retry_task: (job_id: string) => void
  on_delete_task: (job_id: string) => void
  on_rerun_local: (local_run_id: string) => void
}

export function TaskSidebar({
  jobs,
  local_runs,
  active_job_id,
  active_local_run_id,
  active_view,
  action_error,
  is_open,
  cancelling_job_ids,
  retrying_job_ids,
  deleting_job_ids,
  rerunning_local_run_ids,
  on_new_task,
  on_toggle,
  on_select_task,
  on_select_local,
  on_view_change,
  on_cancel_task,
  on_retry_task,
  on_delete_task,
  on_rerun_local,
}: TaskSidebarProps) {
  return (
    <aside className="task-sidebar" aria-label="Conversion tasks" aria-hidden={!is_open} inert={!is_open}>
      <div className="sidebar-brand">
        <Brand on_home={on_new_task} />
        <button
          className="sidebar-toggle"
          type="button"
          aria-label="Close sidebar"
          title="Close sidebar"
          onClick={on_toggle}
        >
          <PanelLeftClose size={18} />
        </button>
      </div>

      <button className="new-task-button" type="button" title="New task" onClick={on_new_task}>
        <Plus size={16} /> <span>New task</span>
      </button>

      <section className="sidebar-tasks">
        <div className="sidebar-section-tabs" role="tablist" aria-label="Run type">
          <button
            className={active_view === "tasks" ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={active_view === "tasks"}
            onClick={() => on_view_change("tasks")}
          >
            Tasks <small>{jobs.length}</small>
          </button>
          <button
            className={active_view === "local" ? "is-active" : ""}
            type="button"
            role="tab"
            aria-selected={active_view === "local"}
            onClick={() => on_view_change("local")}
          >
            Local <small>{local_runs.length}</small>
          </button>
        </div>
        <div className="task-list" role="list">
          {active_view === "tasks" && jobs.length === 0 ? (
            <p className="empty-task-list">Your conversions will appear here.</p>
          ) : active_view === "tasks" ? (
            jobs.map((task) => {
              const is_working = isWorking(task.display_status)
              const is_stopping = task.display_status === "cancelling" || cancelling_job_ids.has(task.job_id)
              const is_retrying = retrying_job_ids.has(task.job_id)
              const is_deleting = deleting_job_ids.has(task.job_id)
              return (
                <div
                  className={`task-row ${task.job_id === active_job_id ? "is-active" : ""}`}
                  key={task.job_id}
                  role="listitem"
                >
                  <button
                    className="task-select"
                    type="button"
                    aria-current={task.job_id === active_job_id ? "page" : undefined}
                    onClick={() => on_select_task(task.job_id)}
                  >
                    <span
                      className={`task-status-dot task-status-${task.display_status}`}
                      aria-hidden="true"
                    />
                    <span className="task-copy">
                      <strong title={task.file_name}>{task.file_name.replace(/\.pdf$/i, "")}</strong>
                      <small>
                        <TaskStatus task={task} />
                        <span aria-hidden="true"> · </span>
                        {formatTaskTime(task.created_at)}
                      </small>
                    </span>
                  </button>
                  <span className="task-entry-actions">
                    {(task.display_status === "cancelled" ||
                      task.display_status === "unsupported" ||
                      task.display_status === "failed") && (
                      <button
                        className="task-retry"
                        type="button"
                        disabled={is_retrying || is_deleting}
                        aria-label={`Retry ${task.file_name}`}
                        title="Retry task"
                        onClick={() => on_retry_task(task.job_id)}
                      >
                        {is_retrying ? <LoaderCircle className="spin" size={11} /> : <RotateCcw size={11} />}
                        <span>{is_retrying ? "Retrying" : "Retry"}</span>
                      </button>
                    )}
                    {is_working && (
                      <button
                        className="task-stop"
                        type="button"
                        disabled={is_stopping || is_deleting}
                        aria-label={`Stop ${task.file_name}`}
                        title={is_stopping ? "Stopping task" : "Stop task"}
                        onClick={() => on_cancel_task(task.job_id)}
                      >
                        <Square size={9} fill="currentColor" />
                        <span>{is_stopping ? "Stopping" : "Stop"}</span>
                      </button>
                    )}
                    <button
                      className="task-delete"
                      type="button"
                      disabled={is_deleting}
                      aria-label={`Delete ${task.file_name}`}
                      title={is_deleting ? "Deleting task" : "Delete task"}
                      onClick={() => on_delete_task(task.job_id)}
                    >
                      {is_deleting ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />}
                    </button>
                  </span>
                </div>
              )
            })
          ) : local_runs.length === 0 ? (
            <p className="empty-task-list">CLI and UI debugging runs will appear here.</p>
          ) : (
            local_runs.map((localRun) => {
              const isRunning = localRun.status === "running"
              const isRerunning = rerunning_local_run_ids.has(localRun.local_run_id)
              const statusClass = isRunning
                ? "agent_running"
                : localRun.status === "completed"
                  ? "complete"
                  : localRun.status
              const statusCopy = isRunning
                ? "Running"
                : localRun.status === "completed"
                  ? "Ready"
                  : localRun.status === "cancelled"
                    ? "Cancelled"
                    : "Failed"
              const targetCopy = localRun.task_id
                ? localRun.task_id.replaceAll("_", " ")
                : localRun.pipeline_id.replaceAll("_", " ")
              return (
                <div
                  className={`task-row local-run-row ${localRun.local_run_id === active_local_run_id ? "is-active" : ""}`}
                  key={localRun.local_run_id}
                  role="listitem"
                >
                  <button
                    className="task-select"
                    type="button"
                    aria-current={localRun.local_run_id === active_local_run_id ? "page" : undefined}
                    onClick={() => on_select_local(localRun)}
                  >
                    <span className={`task-status-dot task-status-${statusClass}`} aria-hidden="true" />
                    <span className="task-copy">
                      <strong title={localRun.file_name}>
                        <Laptop size={12} /> {localRun.file_name.replace(/\.pdf$/i, "")}
                      </strong>
                      <small>
                        <span className="local-run-status">{statusCopy}</span>
                        <span aria-hidden="true"> · </span>
                        <span className="local-run-target">{targetCopy}</span>
                        <span aria-hidden="true"> · </span>
                        {formatTaskTime(localRun.created_at)}
                      </small>
                    </span>
                  </button>
                  <span className="task-entry-actions">
                    {!isRunning && (
                      <button
                        className="task-retry"
                        type="button"
                        disabled={isRerunning}
                        aria-label={`Run ${localRun.file_name} again`}
                        title="Run again"
                        onClick={() => on_rerun_local(localRun.local_run_id)}
                      >
                        {isRerunning ? <LoaderCircle className="spin" size={11} /> : <RotateCcw size={11} />}
                        <span>{isRerunning ? "Starting" : "Run again"}</span>
                      </button>
                    )}
                  </span>
                </div>
              )
            })
          )}
        </div>
      </section>

      {action_error && (
        <p className="sidebar-error" role="alert">
          {action_error}
        </p>
      )}
    </aside>
  )
}
