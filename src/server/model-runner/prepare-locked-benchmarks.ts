import { hasBenchmarkLock, type BenchmarkLock, verifyBenchmarkLock } from "../model-benchmark-lock"
import { getSimulationRunCount } from "../model-simulation-validator"
import { finalizeAndLockBenchmarks } from "./finalize-and-lock-benchmarks"
import { ModelExecution } from "./model-execution"
import { updateServerProgress } from "./model-run-state"
import {
  clearIncompleteBenchmarkFinalization,
  clearRefinementArtifacts,
  findPrematureRefinementArtifacts,
} from "./model-setup-state"
import { preflightNgspice } from "./preflight-ngspice"

async function establishBenchmarkLock(execution: ModelExecution): Promise<BenchmarkLock> {
  const benchmark_lock_exists = await hasBenchmarkLock(execution.model_dir)
  let benchmark_lock = execution.context.model_run_store.getRememberedBenchmarkLock(execution.model_run_id)
  if (benchmark_lock_exists) {
    benchmark_lock = await verifyBenchmarkLock(execution.model_dir, benchmark_lock)
    execution.context.model_run_store.rememberBenchmarkLock(execution.model_run_id, benchmark_lock)
    return benchmark_lock
  }
  if (execution.model_run.manifest?.revision.endsWith("-unverified")) {
    await clearRefinementArtifacts(execution.model_dir)
  }

  const premature_artifacts = await findPrematureRefinementArtifacts(execution.model_dir)
  if (premature_artifacts.length > 0) {
    throw new Error(
      `Cannot establish a pre-refinement benchmark lock because model artifacts already exist: ${premature_artifacts.join(", ")}`,
    )
  }
  await clearIncompleteBenchmarkFinalization(execution.model_dir)
  execution.context.model_run_store.updateModelRun(execution.model_run_id, {
    status: "setting_up",
    is_complete: false,
    has_errors: false,
  })
  updateServerProgress(
    {
      model_run_id: execution.model_run_id,
      phase: "locking_benchmarks",
      message: "Finalizing the benchmark suite before model refinement",
    },
    execution.context.model_run_store,
  )
  await execution.append(
    "system",
    "Starting the untimed benchmark-finalization pass. Model refinement has not started.\n",
  )
  const finalized = await finalizeAndLockBenchmarks({
    model_run_id: execution.model_run_id,
    job_id: execution.model_run.job_id,
    job_dir: execution.job_dir,
    model_dir: execution.model_dir,
    signal: execution.process_controller.signal,
    context: execution.context,
    append: execution.append.bind(execution),
  })
  benchmark_lock = finalized.benchmark_lock
  execution.context.model_run_store.rememberBenchmarkLock(execution.model_run_id, benchmark_lock)
  return benchmark_lock
}

export async function prepareLockedBenchmarks(execution: ModelExecution): Promise<BenchmarkLock> {
  const benchmark_lock = await establishBenchmarkLock(execution)
  const locked_simulation_run_count = await getSimulationRunCount(execution.model_dir).catch(() => 0)
  const validation_canary_ms = await preflightNgspice({
    job_dir: execution.job_dir,
    model_dir: execution.model_dir,
    signal: execution.process_controller.signal,
    tsci_bin: execution.context.tsci_bin,
    append: execution.append.bind(execution),
  })
  execution.context.model_run_store.setValidationProfile(execution.model_run_id, {
    simulation_run_count: locked_simulation_run_count,
    canary_duration_ms: validation_canary_ms,
  })
  const draft_total = execution.context.model_run_store.getModelRun(execution.model_run_id)?.progress
    ?.evidence?.benchmark_drafts
  const locked_total = benchmark_lock.benchmark_ids.length
  const omitted = draft_total === undefined ? undefined : Math.max(0, draft_total - locked_total)
  updateServerProgress(
    {
      model_run_id: execution.model_run_id,
      phase: "locking_benchmarks",
      message:
        draft_total === undefined
          ? `Locked ${locked_total} executable benchmark${locked_total === 1 ? "" : "s"}`
          : `Locked ${locked_total} of ${draft_total} benchmark drafts; ${omitted} remain evidence-only`,
      update: {
        benchmark: {
          completed: 0,
          total: locked_total,
          draft_total,
          locked_total,
          omitted,
        },
      },
    },
    execution.context.model_run_store,
  )
  await execution.append(
    "system",
    draft_total === undefined
      ? `The server locked ${locked_total} executable benchmark${locked_total === 1 ? "" : "s"}, evidence, and test benches.\n`
      : `The server locked ${locked_total} of ${draft_total} benchmark drafts; ${omitted} remain visible as evidence-only coverage.\n`,
  )
  execution.context.model_run_store.startSegment(execution.model_run_id)
  updateServerProgress(
    {
      model_run_id: execution.model_run_id,
      phase: "building_baseline",
      message: "The benchmark suite is locked; starting baseline model refinement",
    },
    execution.context.model_run_store,
  )
  await execution.append(
    "system",
    `The component is ready. Starting the fixed ngspice-validated SPICE refinement workflow with ${Math.round(
      (execution.context.model_run_store.getRemainingTimeMs(execution.model_run_id) ?? 0) / 1000,
    )} seconds of refinement time remaining…\n`,
  )
  return benchmark_lock
}
