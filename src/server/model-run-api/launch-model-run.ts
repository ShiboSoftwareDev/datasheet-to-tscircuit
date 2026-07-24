import { join } from "node:path"
import { runModel } from "../model-runner"
import { handleModelExecutionError } from "../model-runner/handle-model-execution-error"
import { ModelExecution } from "../model-runner/model-execution"
import type { ModelRunApiContext } from "./model-run-api-context"

export async function launchModelRun(
  input: { job_id: string; job_dir: string; effort_multiplier: number },
  context: ModelRunApiContext,
) {
  const model_run_id = crypto.randomUUID()
  const configured_base_effort_ms =
    context.model_base_effort_ms ?? Number(process.env.MODEL_BASE_EFFORT_MS ?? 30 * 60 * 1000)
  const base_effort_ms =
    Number.isFinite(configured_base_effort_ms) && configured_base_effort_ms > 0
      ? configured_base_effort_ms
      : 30 * 60 * 1000
  context.model_run_store.createModelRun({
    model_run_id,
    job_id: input.job_id,
    model_dir: join(input.job_dir, "spice"),
    use_openai: context.use_openai,
    effort_multiplier: input.effort_multiplier,
    base_effort_ms,
  })
  await context.model_run_store.appendLog(model_run_id, {
    stream: "system",
    message: `Created a ${input.effort_multiplier}× SPICE behavioral-model run validated with ngspice. Evidence setup, component waiting, and benchmark locking are untimed; effort applies only to refinement.\n`,
  })
  const execution_context = { ...context, use_openai: context.use_openai ?? false }
  const runner = context.run_model ?? runModel
  const recoverUnexpectedFailure = async (error: unknown) => {
    const model_run = context.model_run_store.getModelRun(model_run_id)
    const cancellation_signal = context.model_run_store.getCancellationSignal(model_run_id)
    if (!model_run || !cancellation_signal || model_run.is_complete) return
    const execution = new ModelExecution({
      model_run_id,
      model_run,
      job_dir: input.job_dir,
      model_dir: join(input.job_dir, "spice"),
      cancellation_signal,
      context: execution_context,
    })
    await handleModelExecutionError(error, execution).catch(() => undefined)
  }
  try {
    void runner({ model_run_id }, execution_context).catch(recoverUnexpectedFailure)
  } catch (error) {
    void recoverUnexpectedFailure(error)
  }
  const current_run = context.model_run_store.getModelRun(model_run_id)
  if (!current_run) throw new Error(`Model run ${model_run_id} disappeared immediately after launch`)
  return current_run
}
