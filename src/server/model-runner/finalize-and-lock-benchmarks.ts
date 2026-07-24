import { randomUUID } from "node:crypto"
import { readFile, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import type { JobLogStream } from "@/shared/job-types"
import {
  type BenchmarkLock,
  createOrVerifyBenchmarkLock,
  hasBenchmarkManifest,
  hasBenchmarkReferenceImageContract,
  requiresCompleteTimeGraphInventory,
  replaceBenchmarkLockAfterCircuitRepair,
  validateBenchmarkSuiteForLock,
} from "../model-benchmark-lock"
import { buildModelBenchmarkPrompt } from "../model-scaffold"
import {
  ModelInfrastructureError,
  ModelProcessStaleError,
  type ModelRunnerContext,
  streamModelProcess,
} from "./stream-model-process"
import { findPrematureRefinementArtifacts, validateFinalizedBenchmarksMatchDraft } from "./model-setup-state"
import { validateBenchmarkSources } from "./strip-analog-simulation-for-structural-check"
import { BenchmarkHarnessPreflightError, preflightBenchmarkHarnesses } from "./preflight-benchmark-harnesses"
import { updateServerProgress } from "./model-run-state"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function writeJsonAtomically(file_path: string, value: unknown): Promise<void> {
  const temporary_path = `${file_path}.${randomUUID()}.tmp`
  try {
    await Bun.write(temporary_path, `${JSON.stringify(value, null, 2)}\n`)
    await rename(temporary_path, file_path)
  } finally {
    await rm(temporary_path, { force: true }).catch(() => undefined)
  }
}

export async function excludeFailedBenchmarkHarnesses(input: {
  model_dir: string
  failures: BenchmarkHarnessPreflightError["failures"]
}): Promise<{ excluded_ids: string[]; remaining_ids: string[] }> {
  const manifest_path = join(input.model_dir, "benchmarks.json")
  const manifest: unknown = JSON.parse(await readFile(manifest_path, "utf8"))
  if (!isRecord(manifest) || !Array.isArray(manifest.benchmarks)) {
    throw new Error("Cannot recover benchmark preflight because benchmarks.json is malformed")
  }
  const ids_by_file = new Map<string, string>(
    manifest.benchmarks.map((benchmark, index) => {
      if (!isRecord(benchmark) || typeof benchmark.id !== "string" || !benchmark.id.trim()) {
        throw new Error(`Cannot recover benchmark preflight because benchmark ${index + 1} has no id`)
      }
      const id = benchmark.id.trim()
      return [`${id}.circuit.tsx`, id] as const
    }),
  )
  const reasons_by_id = new Map<string, string[]>()
  for (const failure of input.failures) {
    const benchmark_id = ids_by_file.get(failure.benchmark_file)
    if (!benchmark_id) continue
    const reasons = reasons_by_id.get(benchmark_id) ?? []
    reasons.push(failure.error_message)
    reasons_by_id.set(benchmark_id, reasons)
  }
  const excluded_ids = [...reasons_by_id.keys()].sort()
  if (excluded_ids.length === 0) {
    throw new Error("Cannot recover benchmark preflight because no failed benchmark id was identified")
  }
  const excluded = new Set(excluded_ids)
  const remaining_benchmarks = manifest.benchmarks.filter(
    (benchmark) =>
      isRecord(benchmark) && typeof benchmark.id === "string" && !excluded.has(benchmark.id.trim()),
  )
  const remaining_ids = remaining_benchmarks
    .flatMap((benchmark) =>
      isRecord(benchmark) && typeof benchmark.id === "string" ? [benchmark.id.trim()] : [],
    )
    .sort()
  if (remaining_ids.length === 0) {
    throw new Error(
      `All ${excluded_ids.length} benchmark harnesses failed preflight; no trustworthy executable benchmark remains`,
    )
  }

  await writeJsonAtomically(manifest_path, { ...manifest, benchmarks: remaining_benchmarks })
  await Promise.all(
    excluded_ids.map((benchmark_id) =>
      rm(join(input.model_dir, "benchmarks", `${benchmark_id}.circuit.tsx`), { force: true }),
    ),
  )
  await writeJsonAtomically(join(input.model_dir, "benchmark-exclusions.json"), {
    version: 1,
    excluded_at: new Date().toISOString(),
    excluded: excluded_ids.map((benchmark_id) => ({
      benchmark_id,
      reasons: [...new Set(reasons_by_id.get(benchmark_id) ?? [])],
    })),
  })
  return { excluded_ids, remaining_ids }
}

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
  const configured_attempts = Number(process.env.MODEL_BENCHMARK_FINALIZATION_ATTEMPTS ?? 6)
  const max_attempts = Number.isInteger(configured_attempts)
    ? Math.max(1, Math.min(8, configured_attempts))
    : 6
  let benchmark_validation_feedback = input.initial_feedback
  for (let attempt = 1; attempt <= max_attempts; attempt += 1) {
    let benchmark_exit_code: number
    try {
      benchmark_exit_code = await streamModelProcess({
        command: [
          input.context.agent_bin,
          "do",
          ...(input.context.use_openai ? ["--use-openai"] : []),
          "--prompt",
          buildModelBenchmarkPrompt(benchmark_validation_feedback, {
            locked_circuit_repair: Boolean(input.repair_lock),
          }),
          "--dir",
          input.model_dir,
        ],
        cwd: input.model_dir,
        signal: input.signal,
        activity_paths: [join(input.model_dir, "model-progress.json")],
        workspace_root: input.model_dir,
        on_chunk: input.append,
      })
    } catch (error) {
      if (!(error instanceof ModelProcessStaleError) || input.signal.aborted) throw error
      if (attempt >= max_attempts) {
        throw error
      }
      benchmark_validation_feedback = [
        benchmark_validation_feedback,
        "The previous correction agent stalled without completing the requested repair. Continue from the existing workspace and resolve the same server validation errors.",
      ]
        .filter(Boolean)
        .join("\n\n")
      await input.append(
        "system",
        `Benchmark-finalization attempt ${attempt} stopped after producing no output. Restarting the untimed correction pass without discarding its workspace or consuming refinement effort.\n`,
      )
      continue
    }
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
        if (await requiresCompleteTimeGraphInventory(input.model_dir)) {
          await validateFinalizedBenchmarksMatchDraft(input.model_dir)
        }
        const reference_warnings = await validateBenchmarkSuiteForLock(input.model_dir, {
          require_source_images:
            !input.repair_lock && (await hasBenchmarkReferenceImageContract(input.model_dir)),
        })
        if (reference_warnings.length > 0) {
          const current_warnings =
            input.context.model_run_store.getModelRun(input.model_run_id)?.warnings ?? []
          const merged_warnings = [...new Set([...current_warnings, ...reference_warnings])]
          input.context.model_run_store.updateModelRun(input.model_run_id, {
            warnings: merged_warnings,
          })
          for (const warning of reference_warnings) {
            await input.append("system", `Warning: ${warning}\n`)
          }
        }
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
        if (error instanceof ModelInfrastructureError) throw error
        if (
          attempt >= max_attempts &&
          !input.repair_lock &&
          error instanceof BenchmarkHarnessPreflightError
        ) {
          const recovered = await excludeFailedBenchmarkHarnesses({
            model_dir: input.model_dir,
            failures: error.failures,
          })
          const warning = `Evidence quality: ${recovered.excluded_ids.length} benchmark draft${
            recovered.excluded_ids.length === 1 ? "" : "s"
          } could not be made into trustworthy executable harnesses after ${attempt} correction attempts and remain evidence-only (${recovered.excluded_ids.join(
            ", ",
          )}). Refinement continued with ${recovered.remaining_ids.length} validated benchmark${
            recovered.remaining_ids.length === 1 ? "" : "s"
          }; inspect benchmark-exclusions.json before relying on model accuracy.`
          const current_warnings =
            input.context.model_run_store.getModelRun(input.model_run_id)?.warnings ?? []
          input.context.model_run_store.updateModelRun(input.model_run_id, {
            warnings: [...new Set([...current_warnings, warning])],
          })
          await input.append("system", `Warning: ${warning}\n`)
          const benchmark_lock = await createOrVerifyBenchmarkLock(input.model_dir)
          return { benchmark_lock }
        }
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
