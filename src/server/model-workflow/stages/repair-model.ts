import { dirname, join } from "node:path"
import { parseFreshModelContract } from "../../modeling"
import { PipelineError } from "../../pipeline"
import type { ValidationPlan, ValidationRunResult } from "../../spice-validation"
import {
  compareCandidateQuality,
  createCandidateQuality,
  viewerQualityCasesFromValidation,
  type CandidateViewerQualityCase,
} from "../candidate-quality"
import { validateCandidate } from "../candidate-validation"
import { generateModelCandidate } from "../model-candidate"
import {
  appendModelLog,
  createModelRepairFeedback,
  formatModelRepairFeedback,
  modelArtifact,
  readJson,
  restoreCandidateValidationUi,
  updateModelProgress,
} from "../stage-helpers"
import { getNonRepairableValidationErrors } from "../validation-repair-policy"
import { defineModelStage } from "./stage-factory"

async function readStoredViewerQualityCases(input: {
  result: ValidationRunResult
  validation_directory: string
}): Promise<CandidateViewerQualityCase[]> {
  const [diagnostics_value, model_ui_value] = await Promise.all([
    readJson(join(input.validation_directory, "candidate-diagnostics.json")),
    readJson(join(input.validation_directory, "model-ui.json")),
  ])
  const diagnostics = diagnostics_value as {
    cases?: Array<{ case_id?: unknown; viewer_status?: unknown }>
  }
  const model_ui = model_ui_value as {
    validation?: {
      benchmarks?: Array<{
        benchmark_id?: unknown
        series?: Array<{
          passed?: unknown
          normalized_max_error?: unknown
          normalized_rmse?: unknown
        }>
      }>
    }
  }
  const viewer_status_by_case = new Map(
    (diagnostics.cases ?? []).flatMap(({ case_id, viewer_status }) =>
      typeof case_id === "string" ? [[case_id, viewer_status]] : [],
    ),
  )
  const benchmark_by_case = new Map(
    (model_ui.validation?.benchmarks ?? []).flatMap((benchmark) =>
      typeof benchmark.benchmark_id === "string" ? [[benchmark.benchmark_id, benchmark]] : [],
    ),
  )
  return input.result.cases.map(({ case_id }) => {
    const benchmark = benchmark_by_case.get(case_id)
    return {
      case_id,
      available: viewer_status_by_case.get(case_id) === "available",
      series: (benchmark?.series ?? []).map((series) => ({
        passed: series.passed === true,
        ...(typeof series.normalized_max_error === "number" && Number.isFinite(series.normalized_max_error)
          ? { normalized_max_error: series.normalized_max_error }
          : {}),
        ...(typeof series.normalized_rmse === "number" && Number.isFinite(series.normalized_rmse)
          ? { normalized_rmse: series.normalized_rmse }
          : {}),
      })),
    }
  })
}

export const repairModelStage = defineModelStage({
  id: "repair_spice_model",
  depends_on: ["compare_simulation_outputs"],
  async execute({ context, services, dependency_outputs, signal, debug_dir }) {
    if (dependency_outputs.compare_simulation_outputs.passed) {
      return {
        status: "completed",
        output: {
          result_path: dependency_outputs.compare_simulation_outputs.result_path,
          model_path: dependency_outputs.compare_simulation_outputs.model_path,
          model_card_path: dependency_outputs.compare_simulation_outputs.model_card_path,
          manifest_path: dependency_outputs.compare_simulation_outputs.manifest_path,
          contract_path: dependency_outputs.compare_simulation_outputs.contract_path,
          plan_path: dependency_outputs.compare_simulation_outputs.plan_path,
          evidence_dir: dependency_outputs.compare_simulation_outputs.evidence_dir,
          passed: true,
          repair_attempts: 0,
          revision: dependency_outputs.compare_simulation_outputs.revision,
        },
        metrics: { repair_attempts: 0 },
      }
    }

    const { contract_path, plan_path, evidence_dir } = dependency_outputs.compare_simulation_outputs
    const [contract_value, plan_value] = await Promise.all([readJson(contract_path), readJson(plan_path)])
    const contract = parseFreshModelContract(contract_value)
    const plan = plan_value as ValidationPlan
    const strategy = services.strategy_registry.require(
      contract.characterization.strategy,
      contract.characterization.family,
    )
    let result = (await readJson(
      dependency_outputs.compare_simulation_outputs.result_path,
    )) as ValidationRunResult
    let repair_feedback =
      dependency_outputs.compare_simulation_outputs.repair_feedback ?? createModelRepairFeedback(result)
    const non_repairable_errors = getNonRepairableValidationErrors(result)
    if (non_repairable_errors.length > 0) {
      throw new PipelineError({
        code: "model_validation_infrastructure_failed",
        message:
          "Model repair was not started because validation failed outside the model boundary: " +
          non_repairable_errors.map(({ code, message }) => `${code}: ${message}`).join("; "),
        stage_id: "repair_spice_model",
        operation: "classify_validation_failure",
        artifact_refs: [{ path: dependency_outputs.compare_simulation_outputs.result_path }],
        hint: "Fix the validation plan, compiler, simulator installation, or raw-result pipeline, then retry without spending model repair attempts.",
      })
    }
    const currentRepairBudget = () =>
      Math.max(
        context.max_repair_attempts,
        Math.min(
          8,
          services.model_run_store.getModelRun(context.model_run_id)?.effort_multiplier ??
            context.max_repair_attempts,
        ),
      )
    let attempted_repairs = 0
    let previous_candidate = {
      model_path: dependency_outputs.compare_simulation_outputs.model_path,
      model_card_path: dependency_outputs.compare_simulation_outputs.model_card_path,
      manifest_path: dependency_outputs.compare_simulation_outputs.manifest_path,
      result_path: dependency_outputs.compare_simulation_outputs.result_path,
      revision: dependency_outputs.compare_simulation_outputs.revision,
      diagnostic_path: join(
        dirname(dependency_outputs.compare_simulation_outputs.result_path),
        "candidate-diagnostics.json",
      ),
    }
    let best_quality = createCandidateQuality({
      result,
      viewer_cases: await readStoredViewerQualityCases({
        result,
        validation_directory: dirname(dependency_outputs.compare_simulation_outputs.result_path),
      }),
    })
    for (let repair_attempt = 1; repair_attempt <= currentRepairBudget(); repair_attempt += 1) {
      attempted_repairs = repair_attempt
      services.model_run_store.updateModelRun(context.model_run_id, {
        status: "running",
        iteration: repair_attempt,
      })
      updateModelProgress({
        store: services.model_run_store,
        model_run_id: context.model_run_id,
        phase: "repairing",
        message: `Repairing the model from server validation (${repair_attempt}/${currentRepairBudget()})`,
        iteration: repair_attempt,
      })
      const candidate = await generateModelCandidate({
        model_dir: context.model_dir,
        contract,
        validation_plan: plan,
        evidence_dir,
        previous_candidate,
        strategy_guidance: strategy.guidance,
        feedback: formatModelRepairFeedback(repair_feedback),
        stage_id: "repair_spice_model",
        phase_label: `SPICE model repair ${repair_attempt}`,
        signal,
        use_openai: context.use_openai,
        agent_client: services.agent_client,
        ngspice: services.ngspice_executor,
        ngspice_path: services.ngspice_bin,
        tsci_path: services.tsci_bin,
        max_artifact_attempts: 2,
        debug_dir: join(debug_dir, `candidate-${repair_attempt}`),
        on_output: (stream, message) =>
          appendModelLog(services.model_run_store, context.model_run_id, stream, message),
      })
      services.model_run_store.updateModelRun(context.model_run_id, { status: "validating" })
      updateModelProgress({
        store: services.model_run_store,
        model_run_id: context.model_run_id,
        phase: "validating",
        message: `Validating repaired model ${repair_attempt}/${currentRepairBudget()}`,
        iteration: repair_attempt,
      })
      const validation_artifact_dir = join(candidate.value.artifact_dir, "validation")
      const validation = await validateCandidate({
        plan,
        contract,
        generated: candidate.value,
        model_dir: context.model_dir,
        validation_artifact_dir,
        evidence_dir,
        preview_generation: `${context.invocation_id}-${candidate.value.manifest.revision}`,
        model_run_store: services.model_run_store,
        model_run_id: context.model_run_id,
        tsci_bin: services.tsci_bin,
        process_runner: services.process_runner,
        signal,
        ngspice: services.ngspice_executor,
        ngspice_path: services.ngspice_bin,
        append: (stream, message) =>
          appendModelLog(services.model_run_store, context.model_run_id, stream, message),
      })
      const {
        diagnostic_path,
        infrastructure_failure,
        passed,
        preview_build,
        result_path,
        stimulus_causality,
      } = validation
      if (infrastructure_failure?.source === "server_validation") {
        throw new PipelineError({
          code: "model_validation_infrastructure_failed",
          message:
            `Validation of repaired model ${repair_attempt} failed outside the model boundary: ` +
            infrastructure_failure.errors.map(({ code, message }) => `${code}: ${message}`).join("; "),
          stage_id: "repair_spice_model",
          operation: "classify_validation_failure",
          artifact_refs: [{ path: result_path }, { path: diagnostic_path }],
          hint: "Inspect the simulator and validation trace; the failed TSX/reference preview was retained, but another model-generation attempt would not repair this failure.",
        })
      }
      if (infrastructure_failure?.source === "tscircuit_viewer") {
        throw new PipelineError({
          code: "model_viewer_simulation_failed",
          message:
            `Validation TSX for repaired model ${repair_attempt} did not produce the required tscircuit transient graph: ` +
            infrastructure_failure.failures
              .map(({ case_id, message }) => `${case_id}: ${message}`)
              .join("; "),
          stage_id: "repair_spice_model",
          operation: "validate_tscircuit_transient_graph",
          artifact_refs: [{ path: result_path }, { path: diagnostic_path }],
          hint: "Another model-only repair cannot fix a non-transient plan or broken TSX projection. Inspect the validation case and Circuit JSON trace.",
        })
      }
      if (passed) {
        return {
          status: "completed",
          output: {
            result_path,
            model_path: join(candidate.value.artifact_dir, "model.lib"),
            model_card_path: join(candidate.value.artifact_dir, "model-card.md"),
            manifest_path: join(candidate.value.artifact_dir, "model-manifest.json"),
            contract_path,
            plan_path,
            evidence_dir,
            passed: true,
            repair_attempts: repair_attempt,
            revision: candidate.value.manifest.revision,
          },
          artifacts: [
            await modelArtifact({
              id: "final_validation_results",
              path: result_path,
              media_type: "application/json",
              role: "validation_result",
            }),
            await modelArtifact({
              id: "final_candidate_diagnostics",
              path: diagnostic_path,
              media_type: "application/json",
              role: "debug",
            }),
          ],
          metrics: { repair_attempts: repair_attempt },
        }
      }
      const candidate_repair_feedback = createModelRepairFeedback(
        validation.result,
        preview_build.viewer_validation_by_case,
        stimulus_causality,
        preview_build.viewer_model_errors_by_case,
      )
      const candidate_quality = createCandidateQuality({
        result: validation.result,
        viewer_cases: viewerQualityCasesFromValidation({
          case_ids: plan.cases.map(({ id }) => id),
          viewer_validation_by_case: preview_build.viewer_validation_by_case,
        }),
      })
      const candidate_refs = {
        model_path: join(candidate.value.artifact_dir, "model.lib"),
        model_card_path: join(candidate.value.artifact_dir, "model-card.md"),
        manifest_path: join(candidate.value.artifact_dir, "model-manifest.json"),
        result_path: join(candidate.value.artifact_dir, "validation", "validation-results.json"),
        revision: candidate.value.manifest.revision,
        diagnostic_path,
      }
      if (compareCandidateQuality(candidate_quality, best_quality) < 0) {
        best_quality = candidate_quality
        previous_candidate = candidate_refs
        result = validation.result
        repair_feedback = candidate_repair_feedback
        await appendModelLog(
          services.model_run_store,
          context.model_run_id,
          "system",
          `Repair ${repair_attempt} improved authoritative candidate quality; the next repair will start from revision ${candidate.value.manifest.revision}.\n`,
        )
      } else {
        await restoreCandidateValidationUi({
          model_run_store: services.model_run_store,
          model_run_id: context.model_run_id,
          model_dir: context.model_dir,
          immutable_artifact_dir: dirname(previous_candidate.result_path),
          evidence_dir,
          revision: previous_candidate.revision,
          signal,
        })
        await appendModelLog(
          services.model_run_store,
          context.model_run_id,
          "system",
          `Repair ${repair_attempt} did not improve authoritative candidate quality; restored revision ${previous_candidate.revision} as the live preview and next repair seed.\n`,
        )
      }
    }

    throw new PipelineError({
      code: "model_validation_failed",
      message:
        `Model did not pass the immutable validation plan after ${attempted_repairs} repair attempt(s).\n` +
        formatModelRepairFeedback(repair_feedback),
      stage_id: "repair_spice_model",
      operation: "repair_and_validate_spice_model",
      artifact_refs: [
        { path: previous_candidate.result_path },
        { path: previous_candidate.diagnostic_path },
        { path: previous_candidate.model_path },
      ],
      entity_refs: [{ entity_type: "model_revision", entity_id: previous_candidate.revision }],
      hint: "Inspect validation-results.json and the repair_spice_model debug bundle. The comparison plan was not changed during repair.",
    })
  },
})
