import {
  Boxes,
  FlaskConical,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react"
import type { JobDisplayStatus, JobSummary, ModelRunStatus } from "@/shared/job-types"
import { useModelRun } from "../use-model-run"
import { Brand } from "./brand"

const STATUS_COPY: Record<JobDisplayStatus, string> = {
  queued: "Queued",
  agent_running: "Running",
  building: "Building",
  cancelling: "Stopping",
  cancelled: "Cancelled",
  complete: "Ready",
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
  timed_out: "Timed out",
  failed: "Failed",
}

function getModelStatusCopy(status: ModelRunStatus, error_message?: string): string {
  if (status === "timed_out" && !error_message?.toLowerCase().includes("no output")) return "Failed"
  return MODEL_STATUS_COPY[status]
}

function getStatusTone(status: string): string {
  if (["Ready", "Complete", "Validated"].includes(status)) return "ready"
  if (["Failed", "Cancelled", "Stopped", "Timed out"].includes(status)) return "failed"
  return "working"
}

function TaskStatus({ task }: { task: JobSummary }) {
  const { model_run, is_loading } = useModelRun(task.job_id)
  const component_ready = task.display_status === "complete"
  const model_ready = model_run?.status === "complete" && Boolean(model_run.model_source)
  if (!is_loading && !model_run) {
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
  const model_status = model_run?.status
  const model_copy = is_loading
    ? "Loading"
    : model_ready
      ? "Ready"
      : model_status
        ? getModelStatusCopy(model_status, model_run?.error_message)
        : "Loading"

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
        title={`Model ${model_copy}`}
      >
        <FlaskConical size={10} />
        <span className={`task-state-label task-state-label-${getStatusTone(model_copy)}`}>{model_copy}</span>
      </span>
    </span>
  )
}

interface TaskSidebarProps {
  jobs: JobSummary[]
  active_job_id?: string
  action_error?: string
  is_collapsed: boolean
  cancelling_job_ids: Set<string>
  retrying_job_ids: Set<string>
  deleting_job_ids: Set<string>
  on_new_task: () => void
  on_toggle: () => void
  on_select_task: (job_id: string) => void
  on_cancel_task: (job_id: string) => void
  on_retry_task: (job_id: string) => void
  on_delete_task: (job_id: string) => void
}

export function TaskSidebar({
  jobs,
  active_job_id,
  action_error,
  is_collapsed,
  cancelling_job_ids,
  retrying_job_ids,
  deleting_job_ids,
  on_new_task,
  on_toggle,
  on_select_task,
  on_cancel_task,
  on_retry_task,
  on_delete_task,
}: TaskSidebarProps) {
  return (
    <aside className="task-sidebar" aria-label="Conversion tasks">
      <div className="sidebar-brand">
        <Brand on_home={on_new_task} />
        <button
          className="sidebar-toggle"
          type="button"
          aria-label={is_collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={is_collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={on_toggle}
        >
          {is_collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </div>

      <button className="new-task-button" type="button" title="New task" onClick={on_new_task}>
        <Plus size={16} /> <span>New task</span>
      </button>

      <section className="sidebar-tasks" aria-labelledby="tasks-title">
        <div className="sidebar-section-heading">
          <span id="tasks-title">Tasks</span>
          <small>{jobs.length}</small>
        </div>
        <div className="task-list" role="list">
          {jobs.length === 0 ? (
            <p className="empty-task-list">Your conversions will appear here.</p>
          ) : (
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
                    {(task.display_status === "cancelled" || task.display_status === "failed") && (
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
