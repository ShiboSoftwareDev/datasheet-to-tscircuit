import { rm } from "node:fs/promises"
import { join } from "node:path"
import { ensureJobTscircuitRuntimeConfig } from "../job-scaffold"
import { startModelArtifactMonitor } from "../model-artifact-monitor"
import {
  clearSetupEvidenceLockForCorrection,
  createOrVerifySetupEvidenceLock,
  enableBenchmarkReferenceImageContract,
  hasBenchmarkLock,
  requiresCompleteTimeGraphInventory,
  requiresTraceProvenance,
  restoreSetupEvidenceFromSnapshot,
} from "../model-benchmark-lock"
import { startModelProgressMonitor } from "../model-progress"
import {
  buildModelSetupPrompt,
  ComponentNotReadyError,
  copyComponentIntoModelWorkspace,
  writeModelScaffold,
} from "../model-scaffold"
import type { ModelExecution } from "./model-execution"
import { summarizeProcessFailure } from "./model-process-output"
import { updateServerProgress, waitForComponent } from "./model-run-state"
import {
  clearIncompleteBenchmarkFinalization,
  getDraftBenchmarkCount,
  hasCompletedSetup,
  validateCompletedSetup,
} from "./model-setup-state"
import { runModelAgentProcess } from "./run-model-agent-process"
import { ModelPreparationError } from "./stream-model-process"

export async function prepareModelWorkspace(execution: ModelExecution): Promise<boolean> {
  await ensureJobTscircuitRuntimeConfig(execution.job_dir)
  if (!(await Bun.file(join(execution.model_dir, "AGENTS.md")).exists())) {
    await writeModelScaffold({ job_dir: execution.job_dir, model_dir: execution.model_dir })
  }
  execution.progress_monitor = startModelProgressMonitor({
    model_run_id: execution.model_run_id,
    model_dir: execution.model_dir,
    model_run_store: execution.context.model_run_store,
  })
  execution.artifact_monitor = startModelArtifactMonitor({
    model_run_id: execution.model_run_id,
    model_dir: execution.model_dir,
    model_run_store: execution.context.model_run_store,
  })
  await execution.progress_monitor.sync()

  let initial_setup_feedback: string | undefined
  if (
    (await hasCompletedSetup(execution.model_dir)) &&
    (await requiresCompleteTimeGraphInventory(execution.model_dir)) &&
    !(await hasBenchmarkLock(execution.model_dir))
  ) {
    const restored_setup_files = await restoreSetupEvidenceFromSnapshot(execution.model_dir)
    try {
      await validateCompletedSetup(execution.model_dir, {
        require_trace_provenance: await requiresTraceProvenance(execution.model_dir),
        require_complete_datasheet_scan: true,
      })
    } catch (error) {
      initial_setup_feedback = error instanceof Error ? error.message : String(error)
      await Promise.all([
        clearSetupEvidenceLockForCorrection(execution.model_dir),
        clearIncompleteBenchmarkFinalization(execution.model_dir),
        rm(join(execution.model_dir, "setup-complete.json"), { force: true }),
      ])
      await execution.append(
        "system",
        `The saved setup snapshot failed current server evidence validation and was reopened for an untimed correction pass: ${initial_setup_feedback}\n`,
      )
    }
    if (restored_setup_files.length > 0 && !initial_setup_feedback) {
      await execution.append(
        "system",
        `Restored ${restored_setup_files.length} setup-evidence file${
          restored_setup_files.length === 1 ? "" : "s"
        } from the immutable server snapshot before revalidating setup.\n`,
      )
    }
  }

  if (!(await hasCompletedSetup(execution.model_dir))) {
    await enableBenchmarkReferenceImageContract(execution.model_dir)
    execution.context.model_run_store.updateModelRun(execution.model_run_id, {
      status: "setting_up",
      is_complete: false,
      has_errors: false,
    })
    updateServerProgress(
      {
        model_run_id: execution.model_run_id,
        phase: "extracting_datasheet",
        message: "Starting datasheet extraction and reference setup",
      },
      execution.context.model_run_store,
    )
    await execution.append(
      "system",
      "Starting untimed datasheet evidence and benchmark-reference setup in parallel with component generation…\n",
    )
    const configured_setup_attempts = Number(process.env.MODEL_SETUP_ATTEMPTS ?? 6)
    const setup_attempts = Number.isInteger(configured_setup_attempts)
      ? Math.max(1, Math.min(8, configured_setup_attempts))
      : 6
    let setup_feedback = initial_setup_feedback
    for (let attempt = 1; attempt <= setup_attempts; attempt += 1) {
      const setup_result = await runModelAgentProcess({
        agent_bin: execution.context.agent_bin,
        use_openai: Boolean(execution.context.use_openai),
        prompt: buildModelSetupPrompt(setup_feedback),
        model_dir: execution.model_dir,
        signal: execution.process_controller.signal,
        append: execution.append.bind(execution),
        phase_label: "Evidence-setup agent",
      }).catch((error) => {
        throw new ModelPreparationError(error instanceof Error ? error.message : String(error))
      })
      if (execution.cancellation_signal.aborted) {
        await execution.append(
          "system",
          "\nThe SPICE model setup was stopped. Extracted evidence was preserved.\n",
        )
        await execution.preserveCancellation()
        return false
      }
      if (setup_result.exit_code !== 0) {
        const detail = summarizeProcessFailure(setup_result.process_output)
        throw new ModelPreparationError(
          `Setup agent exited with code ${setup_result.exit_code}${detail ? `: ${detail}` : ""}`,
        )
      }
      if (setup_result.image_reads.attempted > 0 && setup_result.image_reads.successful === 0) {
        const reasons = [
          ...new Set(
            setup_result.image_reads.failures
              .map(({ reason }) => reason)
              .filter((reason): reason is string => Boolean(reason)),
          ),
        ]
        throw new ModelPreparationError(
          `Datasheet graph inspection was unavailable: all ${setup_result.image_reads.attempted} image read attempts returned no image${
            reasons.length > 0 ? ` (${reasons.slice(0, 3).join("; ")})` : ""
          }. No benchmark evidence was accepted and refinement did not start.`,
        )
      }
      await execution.progress_monitor.sync()
      let rejection: string | undefined
      if (!(await hasCompletedSetup(execution.model_dir))) {
        rejection = "The setup agent did not create setup-complete.json"
      } else {
        try {
          if (await requiresCompleteTimeGraphInventory(execution.model_dir)) {
            await validateCompletedSetup(execution.model_dir, {
              require_trace_provenance: await requiresTraceProvenance(execution.model_dir),
              require_complete_datasheet_scan: true,
            })
          }
        } catch (error) {
          rejection = error instanceof Error ? error.message : String(error)
        }
      }
      if (!rejection) break
      if (attempt >= setup_attempts) {
        throw new ModelPreparationError(
          `Evidence setup still failed server validation after ${attempt} attempts: ${rejection}`,
        )
      }
      setup_feedback = rejection.slice(0, 8_000)
      await rm(join(execution.model_dir, "setup-complete.json"), { force: true })
      await execution.append(
        "system",
        `The server rejected evidence-setup attempt ${attempt}: ${rejection}\nReturning the exact evidence error to the setup agent for correction; refinement has not started.\n`,
      )
    }
    await execution.append("system", "Untimed evidence setup is complete.\n")
  }

  if (await requiresCompleteTimeGraphInventory(execution.model_dir)) {
    try {
      const restored_setup_files = await restoreSetupEvidenceFromSnapshot(execution.model_dir)
      if (restored_setup_files.length > 0) {
        await execution.append(
          "system",
          `Restored ${restored_setup_files.length} setup-evidence file${
            restored_setup_files.length === 1 ? "" : "s"
          } from the immutable server snapshot after a late setup writer changed them: ${restored_setup_files
            .slice(0, 8)
            .join(
              ", ",
            )}${restored_setup_files.length > 8 ? `, and ${restored_setup_files.length - 8} more` : ""}.\n`,
        )
      }
      await validateCompletedSetup(execution.model_dir, {
        require_trace_provenance: await requiresTraceProvenance(execution.model_dir),
        require_complete_datasheet_scan: true,
      })
      const draft_benchmark_count = await getDraftBenchmarkCount(execution.model_dir)
      if (draft_benchmark_count === 0) {
        throw new ModelPreparationError(
          "The complete datasheet review produced no eligible printed time-domain electrical graph. A behavioral SPICE model cannot be accuracy-validated without at least one locked benchmark, so refinement did not start.",
        )
      }
      await createOrVerifySetupEvidenceLock(execution.model_dir)
    } catch (error) {
      if (error instanceof ModelPreparationError) throw error
      throw new ModelPreparationError(error instanceof Error ? error.message : String(error))
    }
  }

  const component_job = execution.context.job_store.getJob(execution.model_run.job_id)
  if (!component_job?.component_ready) {
    execution.context.model_run_store.updateModelRun(execution.model_run_id, {
      status: "waiting_for_component",
      is_complete: false,
      has_errors: false,
    })
    updateServerProgress(
      {
        model_run_id: execution.model_run_id,
        phase: "waiting_for_component",
        message: "Reference setup is complete; waiting for the authoritative component-ready milestone",
      },
      execution.context.model_run_store,
    )
    await execution.append(
      "system",
      "Waiting for the component-ready milestone. Typical-application generation does not block SPICE.\n",
    )
    const component_outcome = await waitForComponent(
      { job_id: execution.model_run.job_id, signal: execution.cancellation_signal },
      execution.context.job_store,
    )
    if (execution.cancellation_signal.aborted) {
      await execution.preserveCancellation()
      return false
    }
    if (component_outcome !== "complete") {
      throw new ComponentNotReadyError(
        component_outcome === "failed"
          ? "Component generation did not pass the authoritative component-ready gate; refinement could not start"
          : `Component generation ${component_outcome}; refinement could not start`,
      )
    }
  }
  await copyComponentIntoModelWorkspace({
    job_dir: execution.job_dir,
    model_dir: execution.model_dir,
  })
  return true
}
