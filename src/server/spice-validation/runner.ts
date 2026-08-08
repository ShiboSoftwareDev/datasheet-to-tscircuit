import { ProcessError } from "@/server/infrastructure/process/process-error"
import type { ModelContract } from "@/server/modeling/types"
import type { ModelManifest } from "@/shared/job-types"
import { ValidationArtifactStore } from "./artifact-store"
import { compileValidationCase } from "./compiler"
import { hashValidationInputs, sha256Text } from "./hashing"
import { executeLocalNgspice, type NgspiceExecutionResult, type NgspiceExecutor } from "./ngspice-executor"
import { parseValidationPlan, ValidationPlanError } from "./parse-validation-plan"
import { parseNgspiceAsciiRaw, RawParseError } from "./raw-parser"
import { extractObservationSeries, MissingRawVectorError, selectAnalysisPlot } from "./raw-series"
import { scoreObservation } from "./scoring"
import type {
  CompiledValidationCase,
  ValidationAppendLogger,
  ValidationCase,
  ValidationCaseResult,
  ValidationExecutionError,
  ValidationPlan,
  ValidationRunResult,
  ValidationSeriesResult,
} from "./types"

export interface RunSpiceValidationInput {
  plan: unknown
  manifest: ModelManifest
  model_source: string
  model_dir: string
  artifact_directory?: string
  model_contract: ModelContract
  signal?: AbortSignal
  append?: ValidationAppendLogger
  ngspice?: NgspiceExecutor
  ngspice_path?: string
}

function executionError(
  kind: ValidationExecutionError["kind"],
  code: string,
  message: string,
  path?: string,
): ValidationExecutionError {
  return { kind, code, message, ...(path === undefined ? {} : { path }) }
}

async function appendLog(
  append: ValidationAppendLogger | undefined,
  stream: "system" | "stdout" | "stderr",
  message: string,
): Promise<void> {
  if (!append || message.length === 0) return
  try {
    await append(stream, message)
  } catch {
    // Validation must not depend on the health of an optional log sink.
  }
}

export function classifyNgspiceFailure(
  output: string,
  exit_code: number,
): ValidationExecutionError | undefined {
  const fatal_convergence_pattern =
    /timestep too small|iteration limit|(?:transient|dc|operating point|op)\b[^\n]*(?:converg(?:e|ence|ing)|failed)|convergence failed/i
  const recoverable_startup_pattern =
    /singular matrix|converg(?:e|ence|ing)|(?:dynamic |true )?gmin stepping failed|source stepping failed/i
  const completed_analysis_pattern =
    /No\. of Data Rows\s*:\s*[1-9]\d*|(?:transient|operating point) op finished successfully/i
  if (
    fatal_convergence_pattern.test(output) ||
    (recoverable_startup_pattern.test(output) && !completed_analysis_pattern.test(output))
  ) {
    return executionError(
      "convergence",
      "ngspice_convergence_failed",
      `ngspice could not converge${exit_code === 0 ? "" : ` (exit ${exit_code})`}: ${output.slice(-4_000)}`,
    )
  }
  if (
    exit_code !== 0 ||
    /fatal error:|doanalyses:.*(?:aborted|failed)|run simulation\(s\) aborted|no such file/i.test(output)
  ) {
    return executionError(
      "simulator",
      "ngspice_failed",
      `ngspice failed${exit_code === 0 ? "" : ` with exit ${exit_code}`}: ${output.slice(-4_000)}`,
    )
  }
  return undefined
}

function failedCase(input: {
  validation_case: ValidationCase
  started_at: number
  netlist_sha256: string
  error: ValidationExecutionError
  raw_sha256?: string
  series?: ValidationSeriesResult[]
}): ValidationCaseResult {
  return {
    case_id: input.validation_case.id,
    status: input.error.kind === "cancelled" ? "cancelled" : "failed",
    analysis: input.validation_case.analysis.type,
    series: input.series ?? [],
    errors: [input.error],
    elapsed_ms: Math.max(0, Math.round(performance.now() - input.started_at)),
    netlist_sha256: input.netlist_sha256,
    ...(input.raw_sha256 === undefined ? {} : { raw_sha256: input.raw_sha256 }),
  }
}

async function runCase(input: {
  validation_case: ValidationCase
  compiled: CompiledValidationCase
  artifact_store: ValidationArtifactStore
  signal?: AbortSignal
  append?: ValidationAppendLogger
  ngspice: NgspiceExecutor
  ngspice_path: string
}): Promise<ValidationCaseResult> {
  const started_at = performance.now()
  const netlist_sha256 = sha256Text(input.compiled.source)
  const paths = await input.artifact_store.prepareCase(input.validation_case.id, input.compiled.source)
  await appendLog(input.append, "system", `Running SPICE validation case ${input.validation_case.id}\n`)
  if (input.signal?.aborted) {
    const result = failedCase({
      validation_case: input.validation_case,
      started_at,
      netlist_sha256,
      error: executionError(
        "cancelled",
        "validation_cancelled",
        "Validation was cancelled before ngspice started",
      ),
    })
    await input.artifact_store.writeCaseResult(paths, result)
    return result
  }

  let execution: NgspiceExecutionResult
  try {
    execution = await input.ngspice({
      executable: input.ngspice_path,
      cwd: paths.directory,
      circuit_path: paths.circuit_path,
      raw_path: paths.raw_path,
      signal: input.signal,
    })
  } catch (error) {
    if (error instanceof ProcessError) throw error
    const result = failedCase({
      validation_case: input.validation_case,
      started_at,
      netlist_sha256,
      error: executionError(
        input.signal?.aborted ? "cancelled" : "simulator",
        input.signal?.aborted ? "validation_cancelled" : "ngspice_spawn_failed",
        error instanceof Error ? error.message : String(error),
      ),
    })
    await input.artifact_store.writeCaseResult(paths, result)
    return result
  }
  await Promise.all([
    input.artifact_store.writeProcessLogs(paths, execution),
    appendLog(input.append, "stdout", execution.stdout),
    appendLog(input.append, "stderr", execution.stderr),
  ])
  if (execution.cancelled || input.signal?.aborted) {
    const result = failedCase({
      validation_case: input.validation_case,
      started_at,
      netlist_sha256,
      error: executionError(
        "cancelled",
        "validation_cancelled",
        "Validation was cancelled while ngspice was running",
      ),
    })
    await input.artifact_store.writeCaseResult(paths, result)
    return result
  }
  const process_failure = classifyNgspiceFailure(
    `${execution.stdout}\n${execution.stderr}`.trim(),
    execution.exit_code,
  )
  if (process_failure) {
    const result = failedCase({
      validation_case: input.validation_case,
      started_at,
      netlist_sha256,
      error: process_failure,
    })
    await input.artifact_store.writeCaseResult(paths, result)
    return result
  }

  let raw_source: string
  try {
    raw_source = await input.artifact_store.readRaw(paths)
  } catch (error) {
    const result = failedCase({
      validation_case: input.validation_case,
      started_at,
      netlist_sha256,
      error: executionError(
        "simulator",
        "raw_file_missing",
        `ngspice did not produce a readable ASCII raw file: ${error instanceof Error ? error.message : String(error)}`,
      ),
    })
    await input.artifact_store.writeCaseResult(paths, result)
    return result
  }
  const raw_sha256 = sha256Text(raw_source)
  let series: ValidationSeriesResult[]
  try {
    const raw = parseNgspiceAsciiRaw(raw_source)
    const plot = selectAnalysisPlot(raw, input.validation_case.analysis)
    series = input.compiled.observations.map((compiled_observation) => {
      const points = extractObservationSeries({
        plot,
        analysis: input.validation_case.analysis,
        compiled_observation,
      })
      return scoreObservation(compiled_observation.observation, points)
    })
  } catch (error) {
    const is_convergence = error instanceof RawParseError && error.code === "raw_non_finite"
    // Observations only name server-compiled fixture vectors. If ngspice does
    // not return one of those vectors, the simulator adapter is broken or
    // incompatible; it is not a numeric model comparison failure.
    const is_missing_vector = error instanceof MissingRawVectorError
    const result = failedCase({
      validation_case: input.validation_case,
      started_at,
      netlist_sha256,
      raw_sha256,
      error: executionError(
        is_convergence ? "convergence" : "simulator",
        is_missing_vector
          ? error.code
          : is_convergence
            ? "non_finite_simulation"
            : error instanceof RawParseError
              ? error.code
              : "raw_processing_failed",
        error instanceof Error ? error.message : String(error),
      ),
    })
    await input.artifact_store.writeCaseResult(paths, result)
    return result
  }

  const comparison_errors = series.flatMap((result) => result.errors)
  const result: ValidationCaseResult = {
    case_id: input.validation_case.id,
    status: series.every((result) => result.passed) ? "passed" : "failed",
    analysis: input.validation_case.analysis.type,
    series,
    errors: comparison_errors,
    elapsed_ms: Math.max(0, Math.round(performance.now() - started_at)),
    netlist_sha256,
    raw_sha256,
  }
  await input.artifact_store.writeCaseResult(paths, result)
  return result
}

export async function runSpiceValidation(input: RunSpiceValidationInput): Promise<ValidationRunResult> {
  const artifact_store = new ValidationArtifactStore(input.model_dir, input.artifact_directory)
  const hashes = hashValidationInputs({
    plan: input.plan,
    model_source: input.model_source,
    manifest: input.manifest,
  })
  await artifact_store.prepareRun(input.model_source)
  let plan: ValidationPlan
  try {
    plan = parseValidationPlan(input.plan, {
      manifest: input.manifest,
      model_source: input.model_source,
      model_requirements: input.model_contract.characterization.requirements,
      model_family: input.model_contract.characterization.family,
      application_fixture: input.model_contract.application_fixture,
    })
  } catch (error) {
    const errors =
      error instanceof ValidationPlanError
        ? error.errors.map((contract_error) =>
            executionError("contract", contract_error.code, contract_error.message, contract_error.path),
          )
        : [
            executionError(
              "contract",
              "validation_plan_invalid",
              error instanceof Error ? error.message : String(error),
            ),
          ]
    const result: ValidationRunResult = { version: 1, passed: false, hashes, cases: [], errors }
    await artifact_store.writeRunResult(result)
    return result
  }

  const cases: ValidationCaseResult[] = []
  const ngspice_path = input.ngspice_path ?? (process.env.NGSPICE_BIN?.trim() || "ngspice")
  for (const validation_case of plan.cases) {
    const compiled = compileValidationCase(validation_case, input.manifest)
    const result = await runCase({
      validation_case,
      compiled,
      artifact_store,
      signal: input.signal,
      append: input.append,
      ngspice: input.ngspice ?? executeLocalNgspice,
      ngspice_path,
    })
    cases.push(result)
    if (result.status === "cancelled") break
  }
  const errors = cases.flatMap((validation_case) => validation_case.errors)
  const result: ValidationRunResult = {
    version: 1,
    passed:
      cases.length === plan.cases.length &&
      cases.every((validation_case) => validation_case.status === "passed"),
    hashes,
    cases,
    errors,
  }
  await artifact_store.writeRunResult(result)
  return result
}
