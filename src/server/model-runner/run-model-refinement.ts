import { finishModelRefinement } from "./finish-model-refinement"
import type { ModelExecution } from "./model-execution"
import type { ModelRefinementState } from "./model-refinement-state"
import { repairBenchmarkLock } from "./repair-benchmark-lock"
import { runIndependentModelValidation } from "./run-independent-model-validation"
import { runRefinementAgentPass } from "./run-refinement-agent-pass"
import { writeModelValidationFeedback } from "./write-model-validation-feedback"

export async function runModelRefinement(
  state: ModelRefinementState,
  execution: ModelExecution,
): Promise<void> {
  execution.startBudgetMonitor()
  while (true) {
    const agent_pass = await runRefinementAgentPass(state, execution)
    if (agent_pass.was_cancelled) return
    if (agent_pass.should_stop) break

    if (!(await runIndependentModelValidation(state, execution))) return
    const repair_outcome = await repairBenchmarkLock(state, execution)
    if (repair_outcome === "repaired") continue
    if (repair_outcome === "recovery_limit" || state.isValidationComplete) break

    await writeModelValidationFeedback(state, execution)
    const remaining_after_validation =
      execution.context.model_run_store.getRemainingTimeMs(execution.model_run_id) ?? 0
    if (remaining_after_validation <= 0 || execution.budget_exhausted) {
      state.final_error_message ??= "Ran out of iterations before every benchmark could be verified."
      break
    }
    if (execution.stale_timeout) break
    execution.budget_exhausted = false
    execution.context.model_run_store.startSegment(execution.model_run_id)
    execution.startBudgetMonitor()
  }
  await finishModelRefinement(state, execution)
}
