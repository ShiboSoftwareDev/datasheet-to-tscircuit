import { mkdir, readFile, rm } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import type { JobLogStream, ModelManifest } from "@/shared/job-types"
import { type BenchmarkLock, verifyBenchmarkLock } from "../model-benchmark-lock"
import {
  getCircuitBuildDiagnostics,
  getModelSimulationSourceSignature,
  type SimulationBenchmarkVerification,
  verifyPartialSimulationBenchmark,
  verifySimulationBenchmark,
  writeSimulationValidationReport,
} from "../model-simulation-validator"
import { ModelRunnerContext, streamModelProcess } from "./stream-model-process"
import {
  captureProcessOutput,
  classifyFatalSimulationFailure,
  getFatalSimulationProcessFailure,
  isTransientAgentTransportFailure,
  summarizeProcessFailure,
} from "./model-process-output"
import { readIterationCount } from "./model-checkpoint"
import { parseModelManifest, validateManifestAgainstModel } from "./parse-model-manifest"
import {
  assertIntegratedCircuitUsesCanonicalModel,
  writeServerIntegratedComponent,
} from "./attach-model-to-generated-component"
import { listModelBenchFiles } from "./list-model-bench-files"

export type SimulationFailureKind = "benchmark_structure" | "simulation" | "infrastructure" | "process"

interface ValidationBuildRun {
  run_id: string
  source_path: string
  generated_path: string
  saved_path: string
}

export interface ValidationBuildResult {
  exit_code: number
  path?: string
  error_message?: string
  failure_kind?: SimulationFailureKind
}

interface BenchmarkValidationState {
  benchmark_id: string
  benchmark_file: string
  source_signature: string
  runs: ValidationBuildRun[]
  results: Array<ValidationBuildResult | undefined>
  building_verification: SimulationBenchmarkVerification
  verification?: SimulationBenchmarkVerification
  failure_kind?: SimulationFailureKind
  finalizing: boolean
  partial_write: Promise<void>
}

export function getValidationConcurrency(): number {
  const concurrency_value = Number(process.env.MODEL_VALIDATION_CONCURRENCY ?? 4)
  return Number.isInteger(concurrency_value) ? Math.max(1, Math.min(8, concurrency_value)) : 4
}

async function prepareBenchmarkValidation(input: {
  benchmark_id: string
  benchmark_file: string
  source_signature: string
  job_dir: string
  model_dir: string
}): Promise<BenchmarkValidationState> {
  const benchmark_source = join(input.model_dir, "benchmarks", input.benchmark_file)
  const runs: ValidationBuildRun[] = [
    {
      run_id: "default",
      source_path: benchmark_source,
      generated_path: join(input.job_dir, "dist", "spice", "benchmarks", input.benchmark_id, "circuit.json"),
      saved_path: join(
        input.model_dir,
        "validation-artifacts",
        input.benchmark_id,
        "runs",
        "default",
        "circuit.json",
      ),
    },
  ]
  return {
    benchmark_id: input.benchmark_id,
    benchmark_file: input.benchmark_file,
    source_signature: input.source_signature,
    runs,
    results: Array(runs.length),
    building_verification: {
      benchmark_id: input.benchmark_id,
      passed: false,
      status: "building",
      generated_at: new Date().toISOString(),
      source_signature: input.source_signature,
    },
    finalizing: false,
    partial_write: Promise.resolve(),
  }
}

function isInfrastructureFailure(message: string): boolean {
  return (
    isTransientAgentTransportFailure(message) ||
    /SPICE engine .* not found in platform config|Available engines:\s*\[\]|spiceEngine\.simulate is not a function|Cannot find package ['"]@tscircuit\/ngspice-spice-engine|ngspice executable .*not found|ENOENT.*\b(?:tsci|ngspice)\b/i.test(
      message,
    )
  )
}

async function executeValidationBuildOnce(input: {
  benchmark_file: string
  run: ValidationBuildRun
  model_dir: string
  signal: AbortSignal
  tsci_bin: string
  append: (stream: JobLogStream, message: string) => Promise<void>
}): Promise<ValidationBuildResult> {
  const { run } = input
  if (input.signal.aborted) {
    return { exit_code: 143, error_message: "Validation was cancelled", failure_kind: "process" }
  }
  await input.append(
    "system",
    `Building complete transient waveform for locked benchmark ${input.benchmark_file}…\n`,
  )
  await rm(dirname(run.generated_path), { recursive: true, force: true })
  const source_relative = relative(input.model_dir, run.source_path)
  let process_output = ""
  let exit_code: number
  try {
    exit_code = await streamModelProcess({
      command: [
        input.tsci_bin,
        "build",
        source_relative,
        "--ignore-warnings",
        "--disable-pcb",
        "--routing-disabled",
        "--disable-parts-engine",
      ],
      cwd: input.model_dir,
      signal: input.signal,
      on_chunk: async (stream, message) => {
        process_output = captureProcessOutput(process_output, message)
        await input.append(stream, message)
      },
    })
  } catch (error) {
    const error_message = error instanceof Error ? error.message : String(error)
    return {
      exit_code: 1,
      error_message,
      failure_kind: isInfrastructureFailure(error_message) ? "infrastructure" : "process",
    }
  }
  if (exit_code !== 0) {
    const error_message = summarizeProcessFailure(process_output)
    return {
      exit_code,
      error_message,
      failure_kind: isInfrastructureFailure(process_output) ? "infrastructure" : "process",
    }
  }
  const fatal_simulation_failure = getFatalSimulationProcessFailure(process_output)
  if (fatal_simulation_failure) {
    return {
      exit_code: 1,
      error_message: fatal_simulation_failure,
      failure_kind: classifyFatalSimulationFailure(fatal_simulation_failure),
    }
  }
  try {
    const circuit_text = await readFile(run.generated_path, "utf8")
    await mkdir(dirname(run.saved_path), { recursive: true })
    await Bun.write(run.saved_path, circuit_text)
    const diagnostics = getCircuitBuildDiagnostics(JSON.parse(circuit_text))
    if (diagnostics.source_errors.length > 0) {
      return {
        exit_code: 1,
        path: run.saved_path,
        error_message: diagnostics.source_errors.join("; "),
        failure_kind: "benchmark_structure",
      }
    }
    if (diagnostics.simulation_errors.length > 0) {
      const error_message = diagnostics.simulation_errors.join("; ")
      return {
        exit_code: 1,
        path: run.saved_path,
        error_message,
        failure_kind: isInfrastructureFailure(error_message) ? "infrastructure" : "simulation",
      }
    }
    return { exit_code: 0, path: run.saved_path }
  } catch (error) {
    return {
      exit_code: 1,
      error_message: error instanceof Error ? error.message : String(error),
      failure_kind: "process",
    }
  }
}

export async function executeValidationBuild(input: {
  benchmark_file: string
  run: ValidationBuildRun
  model_dir: string
  signal: AbortSignal
  tsci_bin: string
  append: (stream: JobLogStream, message: string) => Promise<void>
}): Promise<ValidationBuildResult> {
  const configured_retries = Number(process.env.MODEL_VALIDATION_TRANSPORT_RETRIES ?? 4)
  const retry_count = Number.isInteger(configured_retries) ? Math.max(0, Math.min(5, configured_retries)) : 4
  const configured_base_delay_ms = Number(process.env.MODEL_VALIDATION_TRANSPORT_RETRY_BASE_DELAY_MS ?? 500)
  const base_delay_ms =
    Number.isFinite(configured_base_delay_ms) && configured_base_delay_ms >= 0
      ? configured_base_delay_ms
      : 500
  for (let attempt = 0; attempt <= retry_count; attempt += 1) {
    const result = await executeValidationBuildOnce(input)
    const is_transient =
      result.exit_code !== 0 &&
      Boolean(result.error_message && isTransientAgentTransportFailure(result.error_message))
    if (!is_transient || input.signal.aborted || attempt >= retry_count) return result
    await input.append(
      "system",
      `Validation transport closed while building ${input.benchmark_file}; retrying the same build (${attempt + 2}/${retry_count + 1}) without consuming a benchmark-correction attempt.\n`,
    )
    await Bun.sleep(Math.min(5_000, base_delay_ms * 2 ** attempt))
  }
  return {
    exit_code: 1,
    error_message: "Validation build retry loop ended unexpectedly",
    failure_kind: "infrastructure",
  }
}

export async function runValidationTaskPool<T>(input: {
  tasks: T[]
  concurrency: number
  signal: AbortSignal
  run: (task: T) => Promise<void>
  on_error?: (task: T, error: unknown) => Promise<void>
}): Promise<void> {
  let next_index = 0
  const unhandled_errors: unknown[] = []
  const worker = async () => {
    while (!input.signal.aborted) {
      const task_index = next_index
      next_index += 1
      const task = input.tasks[task_index]
      if (!task) return
      try {
        await input.run(task)
      } catch (error) {
        if (input.on_error) await input.on_error(task, error)
        else unhandled_errors.push(error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(input.concurrency, input.tasks.length) }, () => worker()))
  if (unhandled_errors.length > 0) {
    throw new AggregateError(
      unhandled_errors,
      `${unhandled_errors.length} validation task${unhandled_errors.length === 1 ? "" : "s"} failed`,
    )
  }
}

export async function validateChampion(
  input: {
    model_run_id: string
    job_id: string
    job_dir: string
    model_dir: string
    benchmark_lock: BenchmarkLock
    signal: AbortSignal
  },
  context: ModelRunnerContext,
): Promise<{
  manifest: ModelManifest
  model_source: string
  model_card: string
  iteration: number
  integration_error?: string
  benchmark_contract_error?: string
  infrastructure_error?: string
  simulation_verifications: SimulationBenchmarkVerification[]
}> {
  const [model_source, manifest_value, model_card, iteration] = await Promise.all([
    readFile(join(input.model_dir, "model.lib"), "utf8"),
    readFile(join(input.model_dir, "model-manifest.json"), "utf8").then((text) => JSON.parse(text)),
    readFile(join(input.model_dir, "model-card.md"), "utf8"),
    readIterationCount(input.model_dir).catch(() => 0),
  ])
  const manifest = parseModelManifest(manifest_value)
  validateManifestAgainstModel(manifest, model_source)
  await verifyBenchmarkLock(input.model_dir, input.benchmark_lock)
  await writeServerIntegratedComponent({ model_dir: input.model_dir, manifest, model_source })

  const append = async (stream: JobLogStream, message: string) => {
    await context.model_run_store.appendLog(input.model_run_id, { stream, message })
  }
  const integration_errors: string[] = []
  const build_exit_code = await streamModelProcess({
    command: [
      context.tsci_bin,
      "build",
      "component-with-model.circuit.tsx",
      "--ignore-warnings",
      "--disable-pcb",
      "--routing-disabled",
      "--disable-parts-engine",
    ],
    cwd: input.model_dir,
    signal: input.signal,
    on_chunk: append,
  })
  if (build_exit_code !== 0) {
    integration_errors.push(`The tscircuit model integration build exited with code ${build_exit_code}`)
  } else {
    const integrated_circuit: unknown = JSON.parse(
      await readFile(join(input.job_dir, "dist", "spice", "component-with-model", "circuit.json"), "utf8"),
    )
    const diagnostics = getCircuitBuildDiagnostics(integrated_circuit)
    const integration_build_errors = [...diagnostics.source_errors, ...diagnostics.simulation_errors]
    if (integration_build_errors.length > 0) {
      integration_errors.push(
        `The tscircuit model integration build produced semantic errors: ${integration_build_errors.join("; ")}`,
      )
    } else {
      assertIntegratedCircuitUsesCanonicalModel(integrated_circuit, model_source)
      await append("system", "Built the server-generated canonical model wrapper.\n")
    }
  }

  const benchmark_files = await listModelBenchFiles(input.model_dir)
  if (benchmark_files.length === 0) throw new Error("No tscircuit benchmark circuits were created")
  const states = await Promise.all(
    benchmark_files.map(async (benchmark_file) => {
      const benchmark_id = benchmark_file.replace(/\.circuit\.tsx$/i, "")
      return prepareBenchmarkValidation({
        benchmark_id,
        benchmark_file,
        source_signature: await getModelSimulationSourceSignature(input.model_dir, benchmark_id),
        job_dir: input.job_dir,
        model_dir: input.model_dir,
      })
    }),
  )
  await writeSimulationValidationReport(
    input.model_dir,
    states.map((state) => state.building_verification),
  )

  let report_write = Promise.resolve()
  const publishReport = (): Promise<void> => {
    report_write = report_write.then(() =>
      writeSimulationValidationReport(
        input.model_dir,
        states.map((state) => state.verification ?? state.building_verification),
      ),
    )
    return report_write
  }
  const failState = async (
    state: BenchmarkValidationState,
    result: ValidationBuildResult,
    phase: "build" | "verification" = "build",
  ): Promise<void> => {
    if (state.verification) return
    state.failure_kind = result.failure_kind ?? "process"
    const error_message =
      phase === "build"
        ? `${state.benchmark_file} build exited with code ${result.exit_code}${
            result.error_message ? `: ${result.error_message}` : ""
          }`
        : `${state.benchmark_file} verification failed${
            result.error_message ? `: ${result.error_message}` : ""
          }`
    state.verification = {
      benchmark_id: state.benchmark_id,
      passed: false,
      status: "failed",
      generated_at: new Date().toISOString(),
      source_signature: state.source_signature,
      error_message,
    }
    await publishReport()
  }
  const finalizeState = async (state: BenchmarkValidationState): Promise<void> => {
    if (
      state.verification ||
      state.finalizing ||
      state.results.filter((result) => Boolean(result?.path)).length !== state.runs.length
    ) {
      return
    }
    state.finalizing = true
    state.verification = await verifySimulationBenchmark({
      model_dir: input.model_dir,
      benchmark_id: state.benchmark_id,
      source_signature: state.source_signature,
      circuit_json_paths: state.results.map((result) => ({
        path: result!.path!,
      })),
    })
    if (!state.verification.passed) state.failure_kind ??= "simulation"
    await publishReport()
  }
  let infrastructure_failure_message: string | undefined
  const runTask = async (task: {
    state: BenchmarkValidationState
    run: ValidationBuildRun
  }): Promise<void> => {
    if (task.state.verification || input.signal.aborted || infrastructure_failure_message) return
    try {
      const result = await executeValidationBuild({
        benchmark_file: task.state.benchmark_file,
        run: task.run,
        model_dir: input.model_dir,
        signal: input.signal,
        tsci_bin: context.tsci_bin,
        append,
      })
      task.state.results[0] = result
      if (result.exit_code !== 0 || !result.path) {
        await failState(task.state, result)
        if (result.failure_kind === "infrastructure") {
          infrastructure_failure_message = result.error_message ?? "Simulation infrastructure failed"
        }
        return
      }
      task.state.partial_write = task.state.partial_write.then(async () => {
        const successful_paths = task.state.results.flatMap((candidate) =>
          candidate?.path ? [{ path: candidate.path }] : [],
        )
        task.state.building_verification = await verifyPartialSimulationBenchmark({
          model_dir: input.model_dir,
          benchmark_id: task.state.benchmark_id,
          source_signature: task.state.source_signature,
          circuit_json_paths: successful_paths,
        })
        await publishReport()
        await finalizeState(task.state)
      })
      await task.state.partial_write
    } catch (error) {
      // A rejected per-benchmark publication/verification promise must not be
      // rethrown later when the pool waits for every benchmark to settle.
      task.state.partial_write = Promise.resolve()
      const error_message = error instanceof Error ? error.message : String(error)
      const failure_kind = isInfrastructureFailure(error_message) ? "infrastructure" : "simulation"
      if (failure_kind === "infrastructure") {
        infrastructure_failure_message = error_message
      }
      await failState(
        task.state,
        {
          exit_code: 1,
          error_message,
          failure_kind,
        },
        "verification",
      )
    }
  }

  const concurrency = getValidationConcurrency()
  await append(
    "system",
    `Starting transient waveform validation with up to ${concurrency} concurrent build(s); each benchmark runs exactly once and publishes its complete time trace as soon as it finishes.\n`,
  )
  await runValidationTaskPool({
    tasks: states.flatMap((state) => (state.runs[0] ? [{ state, run: state.runs[0] }] : [])),
    concurrency,
    signal: input.signal,
    run: runTask,
    on_error: async (task, error) => {
      const error_message = error instanceof Error ? error.message : String(error)
      await failState(
        task.state,
        {
          exit_code: 1,
          error_message,
          failure_kind: isInfrastructureFailure(error_message) ? "infrastructure" : "simulation",
        },
        "verification",
      )
    },
  })
  await Promise.all(states.map((state) => state.partial_write))
  await Promise.all(states.map(finalizeState))

  if (input.signal.aborted) {
    integration_errors.push("The independent benchmark re-run reached its validation time limit")
  }
  for (const state of states) {
    if (!state.verification) {
      await failState(state, {
        exit_code: input.signal.aborted ? 143 : 1,
        error_message:
          infrastructure_failure_message ??
          (input.signal.aborted
            ? "Validation was cancelled before every required simulator output completed"
            : "Validation did not produce every required simulator output"),
        failure_kind: infrastructure_failure_message ? "infrastructure" : "process",
      })
    }
  }
  await report_write
  const simulation_verifications = states.flatMap((state) => (state.verification ? [state.verification] : []))
  for (const state of states) {
    if (state.verification && !state.verification.passed) {
      integration_errors.push(`${state.benchmark_file}: ${state.verification.error_message}`)
    }
  }
  const structural_failures = states.filter(
    (state) => state.failure_kind === "benchmark_structure" && state.verification,
  )
  const benchmark_contract_error =
    structural_failures.length > 0
      ? structural_failures
          .map(
            (state) =>
              `${state.benchmark_file}: ${state.verification!.error_message ?? "benchmark source contract failed"}`,
          )
          .join(" | ")
      : undefined
  const infrastructure_failures = states.filter(
    (state) => state.failure_kind === "infrastructure" && state.verification,
  )
  const infrastructure_error =
    infrastructure_failures.length > 0
      ? infrastructure_failures
          .map(
            (state) =>
              `${state.benchmark_file}: ${state.verification!.error_message ?? "simulation infrastructure failed"}`,
          )
          .join(" | ")
      : undefined
  await verifyBenchmarkLock(input.model_dir, input.benchmark_lock)
  return {
    manifest,
    model_source,
    model_card,
    iteration,
    integration_error: integration_errors.length > 0 ? integration_errors.join("; ") : undefined,
    benchmark_contract_error,
    infrastructure_error,
    simulation_verifications,
  }
}
