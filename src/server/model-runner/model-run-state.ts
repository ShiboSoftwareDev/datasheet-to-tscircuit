import type { JobEvent, ModelProgress, ModelProgressPhase } from "@/shared/job-types"
import type { JobStore } from "../job-store"
import type { ModelRunStore } from "../model-run-store"

type ComponentOutcome = "complete" | "failed" | "cancelled"

class ComponentWaiter {
  private unsubscribe?: () => void
  private resolve?: (outcome: ComponentOutcome) => void

  constructor(
    private readonly input: { job_id: string; signal: AbortSignal },
    private readonly job_store: JobStore,
  ) {}

  getOutcome(): ComponentOutcome | undefined {
    const job = this.job_store.getJob(this.input.job_id)
    if (job?.component_ready) return "complete"
    if (job?.display_status === "complete" || job?.display_status === "failed") return "failed"
    if (job?.display_status === "cancelled") return "cancelled"
    return undefined
  }

  finish(outcome: ComponentOutcome): void {
    this.input.signal.removeEventListener("abort", this.stopWaiting)
    this.unsubscribe?.()
    this.resolve?.(outcome)
  }

  readonly stopWaiting = (): void => this.finish("cancelled")

  handleEvent(event: JobEvent): void {
    if (event.event_type === "log") return
    const outcome = this.getOutcome()
    if (outcome) this.finish(outcome)
  }

  wait(): Promise<ComponentOutcome> {
    const current_outcome = this.getOutcome()
    if (current_outcome) return Promise.resolve(current_outcome)
    return new Promise((resolve) => {
      this.resolve = resolve
      this.input.signal.addEventListener("abort", this.stopWaiting, { once: true })
      this.unsubscribe = this.job_store.subscribe(this.input.job_id, this.handleEvent.bind(this))
      if (!this.unsubscribe) this.finish("failed")
    })
  }
}

export function waitForComponent(
  input: { job_id: string; signal: AbortSignal },
  job_store: JobStore,
): Promise<ComponentOutcome> {
  return new ComponentWaiter(input, job_store).wait()
}

export function markModelRunCancelled(model_run_id: string, model_run_store: ModelRunStore): void {
  updateServerProgress(
    { model_run_id, phase: "cancelled", message: "The model run was stopped" },
    model_run_store,
  )
  const update = {
    status: "cancelled" as const,
    is_complete: true,
    has_errors: false,
    completed_at: new Date().toISOString(),
  }
  const model_run = model_run_store.getModelRun(model_run_id)
  if (model_run?.segment_started_at) model_run_store.finishSegment(model_run_id, update)
  else model_run_store.updateModelRun(model_run_id, update)
}

export function updateServerProgress(
  input: {
    model_run_id: string
    phase: ModelProgressPhase
    message: string
    update?: Partial<Pick<ModelProgress, "iteration" | "evidence" | "benchmark" | "champion">>
  },
  model_run_store: ModelRunStore,
): void {
  const current = model_run_store.getModelRun(input.model_run_id)?.progress
  const update = input.update ?? {}
  model_run_store.updateProgress(input.model_run_id, {
    sequence: (current?.sequence ?? 0) + 1,
    phase: input.phase,
    message: input.message,
    updated_at: new Date().toISOString(),
    iteration: update.iteration ?? current?.iteration,
    evidence: update.evidence ?? current?.evidence,
    benchmark: update.benchmark ?? current?.benchmark,
    champion: update.champion ?? current?.champion,
  })
}
