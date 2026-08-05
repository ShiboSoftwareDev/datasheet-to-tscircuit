import { join } from "node:path"
import type { ProcessRunner } from "../infrastructure/process"
import type { ModelRunStore } from "../model-run-store"
import type { GeneratedModel, ModelContract } from "../modeling"
import {
  runSpiceValidation,
  type NgspiceExecutor,
  type ValidationPlan,
  type ValidationRunResult,
} from "../spice-validation"
import {
  attachStimulusCausalityCheck,
  checkCandidateStimulusCausality,
  type CandidateStimulusCausalityCheck,
} from "./candidate-stimulus-causality"
import { persistCandidateValidationUi, projectCandidateValidationUi } from "./stage-helpers/candidate-ui"
import {
  buildValidationCircuitPreviews,
  getViewerInfrastructureFailures,
  getViewerPreviewFailures,
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
  readonly source_dir?: string
  readonly model_dir: string
  readonly validation_artifact_dir: string
  readonly evidence_dir: string
  readonly preview_generation: string
  readonly model_run_store: ModelRunStore
  readonly model_run_id: string
  readonly tsci_bin: string
  readonly process_runner: ProcessRunner
  readonly ngspice: NgspiceExecutor
  readonly ngspice_path: string
  readonly signal: AbortSignal
  readonly append: (stream: "system" | "stdout" | "stderr", message: string) => void | Promise<void>
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

/**
 * Runs the one authoritative validation sequence for every generated or
 * repaired candidate. Stages own progress copy and failure messages; this
 * service owns simulator, causality, viewer, and retained-UI ordering.
 */
export async function validateCandidate(input: CandidateValidationInput): Promise<CandidateValidationResult> {
  let result = await runSpiceValidation({
    plan: input.plan,
    manifest: input.generated.manifest,
    model_source: input.generated.source,
    model_dir: input.model_dir,
    model_contract: input.contract,
    artifact_directory: input.validation_artifact_dir,
    signal: input.signal,
    ngspice: input.ngspice,
    ngspice_path: input.ngspice_path,
    append: input.append,
  })
  await input.append("system", "Running private bound-stimulus causality check\n")
  const stimulus_causality = await checkCandidateStimulusCausality({
    plan: input.plan,
    contract: input.contract,
    manifest: input.generated.manifest,
    model_source: input.generated.source,
    baseline_result: result,
    model_dir: input.model_dir,
    signal: input.signal,
    ngspice: input.ngspice,
    ngspice_path: input.ngspice_path,
  })
  result = attachStimulusCausalityCheck(result, stimulus_causality)

  const preview_build = await buildValidationCircuitPreviews({
    model_dir: input.model_dir,
    plan: input.plan,
    generated: input.generated,
    source_dir: input.source_dir,
    tsci_bin: input.tsci_bin,
    process_runner: input.process_runner,
    signal: input.signal,
    append: input.append,
  })
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
  await projectCandidateValidationUi({
    model_run_store: input.model_run_store,
    model_run_id: input.model_run_id,
    model_dir: input.model_dir,
    immutable_artifact_dir: input.validation_artifact_dir,
    evidence_dir: input.evidence_dir,
    revision: input.generated.manifest.revision,
    projection,
    signal: input.signal,
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
