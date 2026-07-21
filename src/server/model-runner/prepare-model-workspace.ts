import { join } from "node:path"
import { ensureJobTscircuitRuntimeConfig } from "../job-scaffold"
import { startModelArtifactMonitor } from "../model-artifact-monitor"
import { enableBenchmarkReferenceImageContract } from "../model-benchmark-lock"
import { startModelProgressMonitor } from "../model-progress"
import { buildModelSetupPrompt, copyComponentIntoModelWorkspace, writeModelScaffold } from "../model-scaffold"
import { ModelExecution } from "./model-execution"
import { updateServerProgress, waitForComponent } from "./model-run-state"
import { hasCompletedSetup } from "./model-setup-state"
import { streamModelProcess } from "./stream-model-process"

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
    const setup_exit_code = await streamModelProcess({
      command: [
        execution.context.agent_bin,
        "do",
        "--prompt",
        buildModelSetupPrompt(),
        "--dir",
        execution.model_dir,
      ],
      cwd: execution.model_dir,
      signal: execution.process_controller.signal,
      on_chunk: execution.append.bind(execution),
    })
    if (execution.cancellation_signal.aborted) {
      await execution.append(
        "system",
        "\nThe SPICE model setup was stopped. Extracted evidence was preserved.\n",
      )
      await execution.preserveCancellation()
      return false
    }
    if (setup_exit_code !== 0) throw new Error(`Setup agent exited with code ${setup_exit_code}`)
    await execution.progress_monitor.sync()
    if (!(await hasCompletedSetup(execution.model_dir))) {
      throw new Error("The setup agent did not create setup-complete.json")
    }
    await execution.append("system", "Untimed evidence setup is complete.\n")
  }

  const component_job = execution.context.job_store.getJob(execution.model_run.job_id)
  if (!component_job?.component_ready && component_job?.display_status !== "complete") {
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
      throw new Error(`Component generation ${component_outcome}; refinement could not start`)
    }
  }
  await copyComponentIntoModelWorkspace({
    job_dir: execution.job_dir,
    model_dir: execution.model_dir,
  })
  return true
}
