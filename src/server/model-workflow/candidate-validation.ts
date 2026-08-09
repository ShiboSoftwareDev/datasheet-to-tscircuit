import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ProcessRunner } from "../infrastructure/process"
import type { ModelRunStore } from "../model-run-store"
import { type GeneratedModel, type ModelContract, renderValidationCaseTsx } from "../modeling"
import {
  hashValidationInputs,
  sha256Text,
  stableStringify,
  type ValidationExecutionError,
  type ValidationPlan,
  type ValidationRunResult,
} from "../spice-validation"
import {
  attachStimulusCausalityCheck,
  type CandidateStimulusCausalityCheck,
  createStimulusCausalityPlan,
  evaluateStimulusCausality,
} from "./candidate-stimulus-causality"
import { persistCandidateValidationUi } from "./stage-helpers/candidate-ui"
import { writeTscircuitSimulationArtifacts } from "./tscircuit-simulation-artifacts"
import {
  compareValidationCircuitSimulations,
  getViewerInfrastructureFailures,
  getViewerPreviewFailures,
  runValidationCircuitSimulations,
  type ValidationCircuitPreviewBuild,
  type ViewerPreviewFailure,
} from "./validation-circuit-previews"
import {
  classifyValidationInfrastructureFailure,
  type ValidationInfrastructureFailure,
} from "./validation-repair-policy"

export interface CandidateValidationInput {
  readonly plan: ValidationPlan
  readonly contract: ModelContract
  readonly generated: GeneratedModel
  readonly source_dir: string
  readonly model_dir: string
  readonly validation_artifact_dir: string
  readonly evidence_dir: string
  readonly preview_generation: string
  readonly model_run_store: ModelRunStore
  readonly model_run_id: string
  readonly tsci_bin: string
  readonly process_runner: ProcessRunner
  readonly signal: AbortSignal
  readonly append: (stream: "system" | "stdout" | "stderr", message: string) => void | Promise<void>
  readonly fixture_policy?: "exact" | "repairable"
}

export interface CandidateValidationResult {
  readonly result: ValidationRunResult
  readonly result_path: string
  readonly diagnostic_path: string
  readonly stimulus_causality: CandidateStimulusCausalityCheck
  readonly preview_build: ValidationCircuitPreviewBuild
  readonly projection: Awaited<ReturnType<typeof persistCandidateValidationUi>>
  readonly viewer_failures: ViewerPreviewFailure[]
  readonly infrastructure_failure: ValidationInfrastructureFailure | undefined
  readonly passed: boolean
}

function executionErrors(input: {
  simulation_error?: string
  viewer_errors?: readonly ValidationExecutionError[]
}): ValidationExecutionError[] {
  return input.simulation_error
    ? [{ kind: "convergence", code: "tscircuit_simulation_failed", message: input.simulation_error }]
    : [...(input.viewer_errors ?? [])]
}

/** Runs and compares one complete candidate with tscircuit, without changing the live UI. */
export async function validateCandidate(input: CandidateValidationInput): Promise<CandidateValidationResult> {
  const simulations = await runValidationCircuitSimulations({
    model_dir: input.model_dir,
    plan: input.plan,
    generated: input.generated,
    source_dir: input.source_dir,
    tsci_bin: input.tsci_bin,
    process_runner: input.process_runner,
    signal: input.signal,
    append: input.append,
  })
  await writeTscircuitSimulationArtifacts({
    simulation_dir: join(input.validation_artifact_dir, "simulation"),
    plan: input.plan,
    generated: input.generated,
    simulations,
  })
  const preview_build = await compareValidationCircuitSimulations({
    plan: input.plan,
    generated: input.generated,
    simulations,
    fixture_policy: input.fixture_policy,
    append: input.append,
  })
  const cases = await Promise.all(
    input.plan.cases.map(async (validation_case) => {
      const viewer = preview_build.viewer_validation_by_case[validation_case.id]
      const circuit_json = simulations.circuit_json_by_case[validation_case.id]
      const errors = executionErrors({
        simulation_error: simulations.simulation_errors_by_case[validation_case.id],
        viewer_errors: viewer?.errors,
      })
      const source = await readFile(join(input.source_dir, `${validation_case.id}.circuit.tsx`), "utf8")
      return {
        case_id: validation_case.id,
        status: viewer?.passed ? ("passed" as const) : ("failed" as const),
        analysis: validation_case.analysis.type,
        series: viewer?.series ?? [],
        errors,
        elapsed_ms: 0,
        netlist_sha256: sha256Text(source),
        raw_sha256: sha256Text(stableStringify(circuit_json ?? [])),
      }
    }),
  )
  let result: ValidationRunResult = {
    version: 1,
    passed: cases.length === input.plan.cases.length && cases.every(({ status }) => status === "passed"),
    hashes: hashValidationInputs({
      plan: input.plan,
      model_source: input.generated.source,
      manifest: input.generated.manifest,
    }),
    cases,
    errors: cases.flatMap(({ errors }) => errors),
  }

  const causality = createStimulusCausalityPlan({ plan: input.plan, contract: input.contract })
  const causality_plan: ValidationPlan = {
    ...causality.plan,
    cases: causality.plan.cases.filter(({ id }) => causality.relevant_observation_ids_by_case.has(id)),
  }
  let stimulus_causality: CandidateStimulusCausalityCheck = { required: false, passed: true }
  if (causality_plan.cases.length > 0) {
    await input.append("system", "Running private tscircuit bound-stimulus causality check\n")
    const causality_simulations = await runValidationCircuitSimulations({
      model_dir: input.model_dir,
      plan: causality_plan,
      generated: input.generated,
      tsci_bin: input.tsci_bin,
      process_runner: input.process_runner,
      signal: input.signal,
      append: input.append,
    })
    await writeTscircuitSimulationArtifacts({
      simulation_dir: join(input.validation_artifact_dir, "causality-control"),
      plan: causality_plan,
      generated: input.generated,
      simulations: causality_simulations,
    })
    const causality_previews = await compareValidationCircuitSimulations({
      plan: causality_plan,
      generated: input.generated,
      simulations: causality_simulations,
      append: input.append,
    })
    const causality_cases = causality_plan.cases.map((validation_case) => {
      const viewer = causality_previews.viewer_validation_by_case[validation_case.id]
      const circuit_json = causality_simulations.circuit_json_by_case[validation_case.id]
      const errors = executionErrors({
        simulation_error: causality_simulations.simulation_errors_by_case[validation_case.id],
        viewer_errors: viewer?.errors,
      })
      const source = renderValidationCaseTsx({
        validation_case,
        manifest: input.generated.manifest,
        model_source: input.generated.source,
        model_card: input.generated.card,
      })
      return {
        case_id: validation_case.id,
        status: viewer?.passed ? ("passed" as const) : ("failed" as const),
        analysis: validation_case.analysis.type,
        series: viewer?.series ?? [],
        errors,
        elapsed_ms: 0,
        netlist_sha256: sha256Text(source),
        raw_sha256: sha256Text(stableStringify(circuit_json ?? [])),
      }
    })
    const causality_result: ValidationRunResult = {
      version: 1,
      passed:
        causality_cases.length === causality_plan.cases.length &&
        causality_cases.every(({ status }) => status === "passed"),
      hashes: hashValidationInputs({
        plan: causality_plan,
        model_source: input.generated.source,
        manifest: input.generated.manifest,
      }),
      cases: causality_cases,
      errors: causality_cases.flatMap(({ errors }) => errors),
    }
    stimulus_causality = evaluateStimulusCausality({
      plan: input.plan,
      contract: input.contract,
      manifest: input.generated.manifest,
      model_source: input.generated.source,
      baseline_result: result,
      flattened_result: causality_result,
      flattened: causality,
    })
    result = attachStimulusCausalityCheck(result, stimulus_causality)
  }

  const projection = await persistCandidateValidationUi({
    plan: input.plan,
    result,
    generated: input.generated,
    contract: input.contract,
    immutable_artifact_dir: input.validation_artifact_dir,
    preview_generation: input.preview_generation,
    circuit_json_by_case: preview_build.circuit_json_by_case,
    circuit_build_errors_by_case: preview_build.circuit_build_errors_by_case,
    viewer_validation_by_case: preview_build.viewer_validation_by_case,
    viewer_errors_by_case: preview_build.errors_by_case,
  })
  const viewer_failures = getViewerPreviewFailures(preview_build)
  const infrastructure_failure = classifyValidationInfrastructureFailure({
    result,
    viewer_failures: getViewerInfrastructureFailures(preview_build),
  })
  return {
    result,
    result_path: join(input.validation_artifact_dir, "validation-results.json"),
    diagnostic_path: join(input.validation_artifact_dir, "candidate-diagnostics.json"),
    stimulus_causality,
    preview_build,
    projection,
    viewer_failures,
    infrastructure_failure,
    passed: result.passed && viewer_failures.length === 0,
  }
}
