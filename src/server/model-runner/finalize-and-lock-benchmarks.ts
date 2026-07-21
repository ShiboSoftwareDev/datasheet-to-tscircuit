import { join } from "node:path"
import type { JobLogStream } from "@/shared/job-types"
import {
  type BenchmarkLock,
  createOrVerifyBenchmarkLock,
  hasBenchmarkManifest,
  hasBenchmarkReferenceImageContract,
  replaceBenchmarkLockAfterCircuitRepair,
  validateBenchmarkSuiteForLock,
} from "../model-benchmark-lock"
import { buildModelBenchmarkPrompt } from "../model-scaffold"
import { ModelRunnerContext, streamModelProcess } from "./stream-model-process"
import { findPrematureRefinementArtifacts } from "./model-setup-state"
import { validateBenchmarkSources } from "./strip-analog-simulation-for-structural-check"
import { preflightBenchmarkHarnesses } from "./preflight-benchmark-harnesses"
import { updateServerProgress } from "./model-run-state"

export async function finalizeAndLockBenchmarks(input: {
  model_run_id: string
  job_id: string
  job_dir: string
  model_dir: string
  signal: AbortSignal
  context: ModelRunnerContext
  append: (stream: JobLogStream, message: string) => Promise<void>
  initial_feedback?: string
  repair_lock?: BenchmarkLock
}): Promise<{ benchmark_lock: BenchmarkLock }> {
  const configured_attempts = Number(process.env.MODEL_BENCHMARK_FINALIZATION_ATTEMPTS ?? 4)
  const max_attempts = Number.isInteger(configured_attempts)
    ? Math.max(1, Math.min(8, configured_attempts))
    : 4
  let benchmark_validation_feedback = input.initial_feedback
  for (let attempt = 1; attempt <= max_attempts; attempt += 1) {
    const benchmark_exit_code = await streamModelProcess({
      command: [
        input.context.agent_bin,
        "do",
        "--prompt",
        buildModelBenchmarkPrompt(benchmark_validation_feedback, {
          locked_circuit_repair: Boolean(input.repair_lock),
        }),
        "--dir",
        input.model_dir,
      ],
      cwd: input.model_dir,
      signal: input.signal,
      on_chunk: input.append,
    })
    if (benchmark_exit_code !== 0) {
      throw new Error(`Benchmark-finalization agent exited with code ${benchmark_exit_code}`)
    }
    const forbidden_artifacts = await findPrematureRefinementArtifacts(input.model_dir)
    if (forbidden_artifacts.length > 0) {
      throw new Error(
        `Benchmark finalization created forbidden model artifacts before the suite was locked: ${forbidden_artifacts.join(", ")}`,
      )
    }

    let rejection: string | undefined
    if (!(await hasBenchmarkManifest(input.model_dir))) {
      rejection = "The benchmark-finalization agent did not create benchmarks.json"
    } else {
      try {
        await validateBenchmarkSuiteForLock(input.model_dir, {
          require_source_images:
            !input.repair_lock && (await hasBenchmarkReferenceImageContract(input.model_dir)),
        })
        await validateBenchmarkSources({
          job_dir: input.job_dir,
          model_dir: input.model_dir,
          signal: input.signal,
          tsci_bin: input.context.tsci_bin,
          append: input.append,
        })
        await preflightBenchmarkHarnesses({
          model_run_id: input.model_run_id,
          job_id: input.job_id,
          job_dir: input.job_dir,
          model_dir: input.model_dir,
          signal: input.signal,
          context: input.context,
          append: input.append,
        })
        const benchmark_lock = input.repair_lock
          ? await replaceBenchmarkLockAfterCircuitRepair(input.model_dir, input.repair_lock)
          : await createOrVerifyBenchmarkLock(input.model_dir)
        return { benchmark_lock }
      } catch (error) {
        rejection = error instanceof Error ? error.message : String(error)
      }
    }
    if (!rejection) rejection = "The benchmark suite did not pass server validation"
    if (attempt >= max_attempts) {
      throw new Error(
        `Benchmark finalization still failed server validation after ${attempt} attempts: ${rejection}`,
      )
    }
    benchmark_validation_feedback = rejection.slice(0, 8_000)
    await input.append(
      "system",
      `The server rejected benchmark-finalization attempt ${attempt}: ${rejection}\nReturning the exact validation error to the benchmark agent for correction; model refinement remains untimed and has not started.\n`,
    )
    updateServerProgress(
      {
        model_run_id: input.model_run_id,
        phase: "locking_benchmarks",
        message: `Correcting benchmark suite after server validation attempt ${attempt}`,
      },
      input.context.model_run_store,
    )
  }
  throw new Error("The benchmark suite could not be locked")
}
