import { join } from "node:path"
import { PipelineError } from "../../pipeline"
import { modelArtifact, updateModelProgress } from "../stage-helpers"
import { defineModelStage } from "./stage-factory"

export const waitForComponentStage = defineModelStage({
  id: "wait_for_component",
  depends_on: [],
  async execute({ context, services, signal }) {
    signal.throwIfAborted()
    services.model_run_store.updateModelRun(context.model_run_id, {
      status: "waiting_for_component",
      is_complete: false,
      has_errors: false,
      error_message: undefined,
    })
    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "waiting_for_component",
      message: "Waiting for the validated component artifact",
    })

    const inspect = (): "ready" | "failed" | "waiting" => {
      const job = services.job_store.getJob(context.job_id)
      if (!job) return "failed"
      // component_ready is published as an early milestone before the
      // application and final publish stages run. Starting from that milestone
      // races the component pipeline, which may still replace the canonical
      // TSX/Circuit JSON that the model workspace consumes.
      if (job.is_complete) {
        return job.display_status === "complete" && job.component_ready && !job.has_errors
          ? "ready"
          : "failed"
      }
      if (job.pipeline?.status === "completed") {
        return !job.has_errors &&
          job.component_ready &&
          job.pipeline.stage_results.publish?.status === "completed"
          ? "ready"
          : "failed"
      }
      if (job.pipeline?.status === "failed" || job.pipeline?.status === "cancelled") return "failed"
      return "waiting"
    }
    const componentNotReady = (error: unknown): PipelineError =>
      new PipelineError(
        {
          code: "component_not_ready",
          message: error instanceof Error ? error.message : String(error),
          stage_id: "wait_for_component",
          operation: "wait_for_component",
          entity_refs: [{ entity_type: "job", entity_id: context.job_id }],
          hint: "Inspect the component pipeline and its failed stage before retrying the model run.",
        },
        { cause: error },
      )
    const initial_state = inspect()
    if (initial_state === "failed") {
      const job = services.job_store.getJob(context.job_id)
      throw componentNotReady(
        new Error(job?.error_message ?? "Component generation did not complete successfully"),
      )
    }
    if (initial_state === "waiting") {
      signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        let unsubscribe: (() => void) | undefined
        const finish = (error?: Error) => {
          signal.removeEventListener("abort", on_abort)
          unsubscribe?.()
          error ? reject(error) : resolve()
        }
        const on_abort = () => finish(new Error("Model run was cancelled while waiting for the component"))
        signal.addEventListener("abort", on_abort, { once: true })
        unsubscribe = services.job_store.subscribe(context.job_id, (event) => {
          if (event.event_type !== "job_updated") return
          const state = inspect()
          if (state === "ready") finish()
          else if (state === "failed") {
            finish(new Error(event.job.error_message ?? "Component generation did not complete successfully"))
          }
        })
        const state = inspect()
        if (state === "ready") finish()
        else if (state === "failed") finish(new Error("Component generation did not complete successfully"))
      }).catch((error) => {
        if (signal.aborted) throw error
        throw componentNotReady(error)
      })
    }

    const component_source = (await Bun.file(join(context.job_dir, "component.circuit.tsx")).exists())
      ? join(context.job_dir, "component.circuit.tsx")
      : join(context.job_dir, "index.circuit.tsx")
    return {
      status: "completed",
      output: { job_id: context.job_id, component_source },
      artifacts: [
        await modelArtifact({
          id: "validated_component_source",
          path: component_source,
          media_type: "text/typescript",
          role: "model_input",
        }),
      ],
    }
  },
})
