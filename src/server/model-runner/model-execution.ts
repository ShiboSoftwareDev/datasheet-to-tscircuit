import type { JobLogStream, ModelRun } from "@/shared/job-types"
import type { ModelArtifactMonitor } from "../model-artifact-monitor"
import type { ModelProgressMonitor } from "../model-progress"
import { preserveCheckpointAndMarkCancelled } from "./model-checkpoint"
import type { ModelRunnerContext } from "./stream-model-process"

export class ModelExecution {
  readonly model_run_id: string
  readonly model_run: ModelRun
  readonly job_dir: string
  readonly model_dir: string
  readonly cancellation_signal: AbortSignal
  readonly context: ModelRunnerContext
  warnings: string[]
  process_controller = new AbortController()
  budget_exhausted = false
  stale_timeout = false
  budget_monitor?: ReturnType<typeof setInterval>
  progress_monitor?: ModelProgressMonitor
  artifact_monitor?: ModelArtifactMonitor

  constructor(input: {
    model_run_id: string
    model_run: ModelRun
    job_dir: string
    model_dir: string
    cancellation_signal: AbortSignal
    context: ModelRunnerContext
  }) {
    this.model_run_id = input.model_run_id
    this.model_run = input.model_run
    this.job_dir = input.job_dir
    this.model_dir = input.model_dir
    this.cancellation_signal = input.cancellation_signal
    this.context = input.context
    this.warnings = input.model_run.warnings ?? []
  }

  async append(stream: JobLogStream, message: string): Promise<void> {
    await this.context.model_run_store.appendLog(this.model_run_id, { stream, message })
  }

  async addWarning(message: string): Promise<void> {
    const warning = message.trim()
    if (!warning) return
    const persisted_warnings =
      this.context.model_run_store.getModelRun(this.model_run_id)?.warnings ?? this.warnings
    if (persisted_warnings.includes(warning)) {
      this.warnings = persisted_warnings
      return
    }
    this.warnings = [...persisted_warnings, warning]
    this.context.model_run_store.updateModelRun(this.model_run_id, { warnings: this.warnings })
    await this.append("system", `Warning: ${warning}\n`)
  }

  cancelProcess(): void {
    this.process_controller.abort()
  }

  resetProcessController(): void {
    this.process_controller = new AbortController()
  }

  startBudgetMonitor(): void {
    this.stopBudgetMonitor()
    this.budget_monitor = setInterval(() => {
      const remaining_time_ms = this.context.model_run_store.getRemainingTimeMs(this.model_run_id)
      if (remaining_time_ms !== undefined && remaining_time_ms <= 0) this.budget_exhausted = true
    }, 500)
  }

  stopBudgetMonitor(): void {
    if (this.budget_monitor) clearInterval(this.budget_monitor)
    this.budget_monitor = undefined
  }

  async preserveCancellation(): Promise<void> {
    await preserveCheckpointAndMarkCancelled({
      model_run_id: this.model_run_id,
      model_dir: this.model_dir,
      model_run_store: this.context.model_run_store,
      append: this.append.bind(this),
    })
  }

  stopMonitors(): void {
    this.progress_monitor?.stop()
    this.artifact_monitor?.stop()
  }
}
