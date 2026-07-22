import { join } from "node:path"
import { hasBenchmarkManifest, verifyBenchmarkLock } from "../model-benchmark-lock"
import { buildModelAgentPrompt } from "../model-scaffold"
import { publishAvailableModelCheckpoint, restoreBestReportedModelCheckpoint } from "./model-checkpoint"
import type { ModelExecution } from "./model-execution"
import {
  captureProcessOutput,
  isTransientAgentTransportFailure,
  summarizeProcessFailure,
} from "./model-process-output"
import type { ModelRefinementState } from "./model-refinement-state"
import { updateServerProgress } from "./model-run-state"
import { streamModelProcess } from "./stream-model-process"

export interface RefinementAgentPassResult {
  was_cancelled: boolean
  should_stop: boolean
}

export async function runRefinementAgentPass(
  state: ModelRefinementState,
  execution: ModelExecution,
): Promise<RefinementAgentPassResult> {
  state.agent_attempt += 1
  if (state.agent_attempt > 1) {
    execution.context.model_run_store.updateModelRun(execution.model_run_id, {
      status: "running",
      is_complete: false,
      has_errors: false,
      error_message: undefined,
    })
    updateServerProgress(
      {
        model_run_id: execution.model_run_id,
        phase: "refining",
        message: `Validation was incomplete; starting correction pass ${state.agent_attempt}`,
      },
      execution.context.model_run_store,
    )
    await execution.append(
      "system",
      `Validation did not reach 100%. Returning the server-owned validation feedback to the agent for correction pass ${state.agent_attempt}…\n`,
    )
  }

  await verifyBenchmarkLock(execution.model_dir, state.benchmark_lock)
  const agent_controller = new AbortController()
  let refinement_effort_exhausted = false
  const cancel_agent = (): void => agent_controller.abort()
  execution.process_controller.signal.addEventListener("abort", cancel_agent, { once: true })
  const refinement_monitor = setInterval(() => {
    const remaining_time_ms =
      execution.context.model_run_store.getRemainingTimeMs(execution.model_run_id) ?? 0
    if (remaining_time_ms <= 0) {
      refinement_effort_exhausted = true
      execution.budget_exhausted = true
      agent_controller.abort()
    }
  }, 250)
  let agent_exit_code = 1
  let agent_process_output = ""
  try {
    const configured_transport_retries = Number(process.env.MODEL_AGENT_TRANSPORT_RETRIES ?? 2)
    const transport_retry_limit = Number.isInteger(configured_transport_retries)
      ? Math.max(0, Math.min(5, configured_transport_retries))
      : 2
    let transport_retry = 0
    while (true) {
      agent_process_output = ""
      agent_exit_code = await streamModelProcess({
        command: [
          execution.context.agent_bin,
          "do",
          "--prompt",
          buildModelAgentPrompt(),
          "--dir",
          execution.model_dir,
        ],
        cwd: execution.model_dir,
        signal: agent_controller.signal,
        activity_paths: [join(execution.model_dir, "model-progress.json")],
        workspace_root: execution.model_dir,
        on_chunk: async (stream, message) => {
          agent_process_output = captureProcessOutput(agent_process_output, message)
          await execution.append(stream, message)
        },
      })
      if (
        agent_exit_code === 0 ||
        agent_controller.signal.aborted ||
        !isTransientAgentTransportFailure(agent_process_output) ||
        transport_retry >= transport_retry_limit
      ) {
        break
      }
      transport_retry += 1
      await execution.append(
        "system",
        `Agent transport failed; restarting the same refinement workspace (${transport_retry}/${transport_retry_limit}) without discarding its checkpoint or remaining effort.\n`,
      )
    }
  } finally {
    clearInterval(refinement_monitor)
    execution.process_controller.signal.removeEventListener("abort", cancel_agent)
  }

  if (execution.cancellation_signal.aborted) {
    await execution.append(
      "system",
      "\nThe SPICE model run was stopped. Champion checkpoints were preserved.\n",
    )
    await execution.preserveCancellation()
    return { was_cancelled: true, should_stop: true }
  }

  const restored_reported_champion = await restoreBestReportedModelCheckpoint(execution.model_dir)
  if (restored_reported_champion) {
    await execution.append(
      "system",
      `Server checkpoint guard selected ${restored_reported_champion} from the agent's promoted candidates before independent validation.\n`,
    )
  }
  const checkpoint_available = await publishAvailableModelCheckpoint(
    { model_run_id: execution.model_run_id, model_dir: execution.model_dir },
    execution.context.model_run_store,
  )
  if (!checkpoint_available) {
    throw new Error("The agent did not leave a canonical, promoted, or recoverable model checkpoint")
  }
  if (!(await hasBenchmarkManifest(execution.model_dir))) {
    if (refinement_effort_exhausted) {
      state.final_error_message = "Refinement effort expired before creating a benchmark suite."
      return { was_cancelled: false, should_stop: true }
    }
    throw new Error("The agent did not create benchmarks.json")
  }
  await verifyBenchmarkLock(execution.model_dir, state.benchmark_lock)
  if (refinement_effort_exhausted) {
    await execution.append(
      "system",
      "Refinement effort expired. Running independent validation against the latest checkpoint without charging the validation time.\n",
    )
  }
  if (agent_exit_code !== 0 && !execution.budget_exhausted && !refinement_effort_exhausted) {
    const detail = summarizeProcessFailure(agent_process_output)
    throw new Error(`tsci-agent exited with code ${agent_exit_code}${detail ? `: ${detail}` : ""}`)
  }
  return { was_cancelled: false, should_stop: false }
}
