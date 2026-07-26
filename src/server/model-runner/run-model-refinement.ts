import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { finishModelRefinement } from "./finish-model-refinement"
import type { ModelExecution } from "./model-execution"
import type { ModelRefinementState } from "./model-refinement-state"
import { repairBenchmarkLock } from "./repair-benchmark-lock"
import { runIndependentModelValidation } from "./run-independent-model-validation"
import { runRefinementAgentPass } from "./run-refinement-agent-pass"
import { writeModelValidationFeedback } from "./write-model-validation-feedback"

export function createCheckpointSimulationSignature(input: {
  model_source: string
  manifest: unknown
  benchmark_lock: ModelRefinementState["benchmark_lock"]
}): string {
  const { manifest } = input
  const simulation_manifest =
    typeof manifest === "object" && manifest !== null
      ? {
          dialect: "dialect" in manifest ? manifest.dialect : undefined,
          entry_name: "entry_name" in manifest ? manifest.entry_name : undefined,
          pins: "pins" in manifest ? manifest.pins : undefined,
          simulator: "simulator" in manifest ? manifest.simulator : undefined,
        }
      : manifest
  return createHash("sha256")
    .update(input.model_source)
    .update(JSON.stringify(simulation_manifest))
    .update(
      JSON.stringify({
        generation: input.benchmark_lock.generation,
        files: input.benchmark_lock.files,
      }),
    )
    .digest("hex")
}

async function getCheckpointSimulationSignature(
  state: ModelRefinementState,
  execution: ModelExecution,
): Promise<string> {
  const [model_source, manifest_text] = await Promise.all([
    readFile(join(execution.model_dir, "model.lib"), "utf8"),
    readFile(join(execution.model_dir, "model-manifest.json"), "utf8"),
  ])
  return createCheckpointSimulationSignature({
    model_source,
    manifest: JSON.parse(manifest_text) as unknown,
    benchmark_lock: state.benchmark_lock,
  })
}

export async function runModelRefinement(
  state: ModelRefinementState,
  execution: ModelExecution,
): Promise<void> {
  execution.startBudgetMonitor()
  while (true) {
    const agent_pass = await runRefinementAgentPass(state, execution)
    if (agent_pass.was_cancelled) return
    if (agent_pass.should_stop) break

    const checkpoint_signature = await getCheckpointSimulationSignature(state, execution)
    if (checkpoint_signature === state.last_validated_checkpoint_signature) {
      state.final_error_message ??=
        "The correction agent returned the same canonical model after receiving validation feedback."
      await execution.append(
        "system",
        "The correction pass left the canonical model and simulation mapping unchanged. Reusing the previous independent result and stopping this no-op correction loop instead of rerunning every benchmark.\n",
      )
      break
    }
    if (!(await runIndependentModelValidation(state, execution))) return
    state.last_validated_checkpoint_signature = checkpoint_signature
    const repair_outcome = await repairBenchmarkLock(state, execution)
    if (repair_outcome === "repaired") {
      state.last_validated_checkpoint_signature = undefined
      continue
    }
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
