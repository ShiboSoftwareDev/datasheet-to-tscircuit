import { handleModelExecutionError } from "./handle-model-execution-error"
import { ModelExecution } from "./model-execution"
import { ModelRefinementState } from "./model-refinement-state"
import { prepareLockedBenchmarks } from "./prepare-locked-benchmarks"
import { prepareModelWorkspace } from "./prepare-model-workspace"
import { runModelRefinement } from "./run-model-refinement"
import type { ModelRunnerContext } from "./stream-model-process"

export async function runModel(input: { model_run_id: string }, context: ModelRunnerContext): Promise<void> {
  const model_run = context.model_run_store.getModelRun(input.model_run_id)
  if (!model_run) throw new Error(`Model run ${input.model_run_id} was not found`)
  const job_dir = context.job_store.getJobDir(model_run.job_id)
  const model_dir = context.model_run_store.getModelDir(input.model_run_id)
  const cancellation_signal = context.model_run_store.getCancellationSignal(input.model_run_id)
  if (!job_dir || !model_dir || !cancellation_signal) {
    throw new Error("Model run workspace was not found")
  }

  const execution_context = {
    ...context,
    use_openai: model_run.use_openai ?? context.use_openai ?? false,
  }
  const execution = new ModelExecution({
    model_run_id: input.model_run_id,
    model_run,
    job_dir,
    model_dir,
    cancellation_signal,
    context: execution_context,
  })
  if (cancellation_signal.aborted) {
    await execution.preserveCancellation()
    return
  }
  const cancel_process = execution.cancelProcess.bind(execution)
  cancellation_signal.addEventListener("abort", cancel_process, { once: true })

  try {
    if (!(await prepareModelWorkspace(execution))) return
    const benchmark_lock = await prepareLockedBenchmarks(execution)
    await runModelRefinement(new ModelRefinementState(benchmark_lock), execution)
  } catch (error) {
    await handleModelExecutionError(error, execution)
  } finally {
    execution.stopMonitors()
    execution.stopBudgetMonitor()
    cancellation_signal.removeEventListener("abort", cancel_process)
  }
}
