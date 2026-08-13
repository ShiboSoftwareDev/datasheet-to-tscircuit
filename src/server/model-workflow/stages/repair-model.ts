import { readFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { AgentArtifactAttempt } from "../../infrastructure/agent"
import { ProcessError } from "../../infrastructure/process"
import { type GeneratedModel, parseFreshModelContract } from "../../modeling"
import { PipelineError } from "../../pipeline"
import type { ValidationPlan, ValidationRunResult } from "../../spice-validation"
import {
  compareCandidateQuality,
  createCandidateQuality,
  formatRejectedCandidateQualityFeedback,
  viewerQualityCasesFromValidation,
} from "../candidate-quality"
import { type CandidateValidationResult, validateCandidate } from "../candidate-validation"
import { hasRepairCandidateBudget } from "../repair-budget"
import { generateRepairCandidate, type StoredRepairCandidate } from "../repair-candidate"
import {
  createRepairEffectivenessReport,
  type RepairCandidateEvaluation,
  writeRepairEffectivenessReport,
} from "../repair-effectiveness"
import {
  appendModelLog,
  createModelRepairFeedback,
  formatModelRepairFeedback,
  modelArtifact,
  projectCandidateValidationUi,
  readJson,
  restoreCandidateValidationUi,
  updateModelProgress,
} from "../stage-helpers"
import { REPAIR_BUDGET_MS_PER_EFFORT } from "../types"
import { getNonRepairableValidationErrors } from "../validation-repair-policy"
import { defineModelStage } from "./stage-factory"

interface RepairBudgetSignal {
  signal: AbortSignal
  dispose: () => void
}

function createRepairBudgetSignal(input: { parent: AbortSignal; remaining_ms: number }): RepairBudgetSignal {
  const controller = new AbortController()
  const abortForParent = () => controller.abort(input.parent.reason)
  const timeout = setTimeout(
    () => controller.abort(new DOMException("The SPICE repair budget expired", "TimeoutError")),
    Math.max(1, Math.floor(input.remaining_ms)),
  )
  input.parent.addEventListener("abort", abortForParent, { once: true })
  if (input.parent.aborted) abortForParent()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      input.parent.removeEventListener("abort", abortForParent)
    },
  }
}

function budgetExpired(error: unknown, parent: AbortSignal, attempt: AbortSignal): boolean {
  if (parent.aborted || !attempt.aborted) return false
  return (
    error === attempt.reason ||
    (error instanceof ProcessError && error.code === "process_cancelled") ||
    (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
  )
}

export const repairModelStage = defineModelStage({
  id: "repair_spice_model",
  depends_on: ["compare_simulation_outputs"],
  async execute({ context, services, dependency_outputs, signal, debug_dir }) {
    const comparison = dependency_outputs.compare_simulation_outputs
    const [baseline_source, baseline_card, baseline_manifest] = await Promise.all([
      readFile(comparison.model_path, "utf8"),
      readFile(comparison.model_card_path, "utf8"),
      readJson(comparison.manifest_path),
    ])
    const baseline: GeneratedModel = {
      source: baseline_source,
      card: baseline_card,
      manifest: baseline_manifest as GeneratedModel["manifest"],
    }
    if (baseline.manifest.revision !== comparison.revision) {
      throw new PipelineError({
        code: "model_repair_baseline_invalid",
        message: "The retained comparison model revision does not match its manifest",
        stage_id: "repair_spice_model",
        operation: "restore_comparison_baseline",
        artifact_refs: [{ path: comparison.manifest_path }, { path: comparison.model_path }],
      })
    }
    // A task rerun starts a new invocation while its input still points at the
    // previous completed comparison. Re-project that complete bundle before
    // diagnosis so stale in-memory metadata can never hide its graphs, TSX,
    // simulation, or statistics. References are copied unchanged.
    await restoreCandidateValidationUi({
      model_run_store: services.model_run_store,
      model_run_id: context.model_run_id,
      model_dir: context.model_dir,
      immutable_artifact_dir: dirname(comparison.result_path),
      evidence_dir: comparison.evidence_dir,
      revision: comparison.revision,
      development_model: baseline,
      signal,
    })
    if (comparison.passed) {
      return {
        status: "completed",
        output: {
          result_path: comparison.result_path,
          model_path: comparison.model_path,
          model_card_path: comparison.model_card_path,
          manifest_path: comparison.manifest_path,
          contract_path: comparison.contract_path,
          plan_path: comparison.plan_path,
          evidence_dir: comparison.evidence_dir,
          passed: true,
          repair_attempts: 0,
          repair_elapsed_ms: 0,
          revision: comparison.revision,
        },
        metrics: {
          repair_attempts: 0,
          repair_elapsed_ms: 0,
          repair_promoted_candidates: 0,
          repair_rejected_candidates: 0,
          repair_quality_improved: false,
          repair_revision_changed: false,
          repair_baseline_failed_cases: 0,
          repair_final_failed_cases: 0,
        },
      }
    }

    const [contract_value, plan_value] = await Promise.all([
      readJson(comparison.contract_path),
      readJson(comparison.plan_path),
    ])
    const contract = parseFreshModelContract(contract_value)
    const plan = plan_value as ValidationPlan
    const strategy = services.strategy_registry.require(
      contract.characterization.strategy,
      contract.characterization.family,
    )
    let result = (await readJson(comparison.result_path)) as ValidationRunResult
    let repair_feedback = createModelRepairFeedback(
      result,
      undefined,
      comparison.stimulus_causality_failure
        ? { required: true, passed: false, ...comparison.stimulus_causality_failure }
        : undefined,
    )
    const non_repairable_errors = getNonRepairableValidationErrors(result)
    if (non_repairable_errors.length > 0) {
      throw new PipelineError({
        code: "model_validation_infrastructure_failed",
        message:
          "Model repair was not started because validation failed outside the model or TSX boundary: " +
          non_repairable_errors.map(({ code, message }) => `${code}: ${message}`).join("; "),
        stage_id: "repair_spice_model",
        operation: "classify_validation_failure",
        artifact_refs: [{ path: comparison.result_path }],
        hint: "Fix the validation plan, tscircuit installation, or retained-result pipeline before retrying repair.",
      })
    }

    const initial_repair_budget_ms =
      context.repair_budget_ms ?? Math.max(1, context.max_repair_attempts ?? 1) * REPAIR_BUDGET_MS_PER_EFFORT
    services.model_run_store.startRepairBudget(context.model_run_id, initial_repair_budget_ms)
    const repair_started_at = Date.now()
    let attempted_repairs = 0
    let previous_candidate = {
      model_path: comparison.model_path,
      model_card_path: comparison.model_card_path,
      manifest_path: comparison.manifest_path,
      source_dir: join(dirname(comparison.model_path), "simulation-tsx"),
      result_path: comparison.result_path,
      revision: comparison.revision,
      diagnostic_path: join(dirname(comparison.result_path), "candidate-diagnostics.json"),
    }
    let best_quality = createCandidateQuality({
      result,
      viewer_cases: result.cases.map(({ case_id, series }) => ({
        case_id,
        available: series.length > 0,
        series: series.map(({ passed, metrics }) => ({
          passed,
          normalized_max_error: metrics.normalized_max_error,
          normalized_rmse: metrics.normalized_rmse,
        })),
      })),
    })
    const baseline_quality = best_quality
    const candidate_evaluations: RepairCandidateEvaluation[] = []
    let rejected_candidate_feedback = ""
    let last_evaluated_candidate_ms: number | undefined

    const createEffectivenessArtifact = async (repair_elapsed_ms: number) => {
      const effectiveness_path = join(debug_dir, "repair-effectiveness.json")
      const report = createRepairEffectivenessReport({
        baseline_revision: comparison.revision,
        final_revision: previous_candidate.revision,
        baseline_quality,
        final_quality: best_quality,
        attempted_candidate_count: attempted_repairs,
        repair_elapsed_ms,
        repair_budget_ms: initial_repair_budget_ms,
        candidates: candidate_evaluations,
      })
      await writeRepairEffectivenessReport({ path: effectiveness_path, report })
      return {
        report,
        artifact: await modelArtifact({
          id: "repair_effectiveness",
          path: effectiveness_path,
          media_type: "application/json",
          role: "evaluation",
        }),
      }
    }

    try {
      while (true) {
        const live_run = services.model_run_store.getModelRun(context.model_run_id)
        const repair_budget_ms = live_run?.repair_budget_ms ?? initial_repair_budget_ms
        const elapsed_ms = Date.now() - repair_started_at
        const remaining_ms = repair_budget_ms - elapsed_ms
        if (!hasRepairCandidateBudget({ remaining_ms, last_evaluated_candidate_ms })) break
        const candidate_started_at = Date.now()
        attempted_repairs += 1
        const attempt_budget = createRepairBudgetSignal({ parent: signal, remaining_ms })
        const attempt_signal = attempt_budget.signal
        try {
          services.model_run_store.updateModelRun(context.model_run_id, {
            status: "running",
            iteration: attempted_repairs,
          })
          updateModelProgress({
            store: services.model_run_store,
            model_run_id: context.model_run_id,
            phase: "repairing",
            message: `Diagnosing model and TSX candidate ${attempted_repairs} (${Math.ceil(remaining_ms / 60_000)} min remaining)`,
            iteration: attempted_repairs,
          })
          let candidate: AgentArtifactAttempt<StoredRepairCandidate>
          try {
            candidate = await generateRepairCandidate({
              model_dir: context.model_dir,
              contract,
              plan,
              evidence_dir: comparison.evidence_dir,
              previous: previous_candidate,
              strategy_guidance: strategy.guidance,
              feedback: [formatModelRepairFeedback(repair_feedback), rejected_candidate_feedback]
                .filter(Boolean)
                .join("\n\n"),
              signal: attempt_signal,
              use_openai: context.use_openai,
              agent_client: services.agent_client,
              // Artifact corrections are bounded by the stage's abort deadline,
              // not exposed as the user's repair budget.
              max_artifact_attempts: 8,
              debug_dir: join(debug_dir, `candidate-${attempted_repairs}`),
              phase_label: `SPICE repair diagnosis and edit ${attempted_repairs}`,
              on_output: (stream, message) =>
                appendModelLog(services.model_run_store, context.model_run_id, stream, message),
            })
          } catch (error) {
            if (budgetExpired(error, signal, attempt_signal)) break
            throw error
          }

          services.model_run_store.updateModelRun(context.model_run_id, { status: "validating" })
          updateModelProgress({
            store: services.model_run_store,
            model_run_id: context.model_run_id,
            phase: "validating",
            message: `Running repaired candidate ${attempted_repairs} with tscircuit`,
            iteration: attempted_repairs,
          })
          const validation_artifact_dir = join(candidate.value.artifact_dir, "validation")
          let validation: CandidateValidationResult
          try {
            validation = await validateCandidate({
              plan,
              contract,
              generated: candidate.value,
              source_dir: candidate.value.source_dir,
              model_dir: context.model_dir,
              validation_artifact_dir,
              evidence_dir: comparison.evidence_dir,
              preview_generation: `${context.invocation_id}-${candidate.value.manifest.revision}`,
              model_run_store: services.model_run_store,
              model_run_id: context.model_run_id,
              tsci_bin: services.tsci_bin,
              process_runner: services.process_runner,
              signal: attempt_signal,
              append: (stream, message) =>
                appendModelLog(services.model_run_store, context.model_run_id, stream, message),
              fixture_policy: "repairable",
            })
          } catch (error) {
            if (budgetExpired(error, signal, attempt_signal)) break
            throw error
          }

          const candidate_quality = createCandidateQuality({
            result: validation.result,
            viewer_cases: viewerQualityCasesFromValidation({
              case_ids: plan.cases.map(({ id }) => id),
              viewer_validation_by_case: validation.preview_build.viewer_validation_by_case,
            }),
          })
          last_evaluated_candidate_ms = Date.now() - candidate_started_at
          const improved = validation.passed || compareCandidateQuality(candidate_quality, best_quality) < 0
          candidate_evaluations.push({
            attempt: attempted_repairs,
            target: candidate.value.diagnosis.target,
            revision: candidate.value.manifest.revision,
            outcome: improved ? "promoted" : "rejected",
            quality: candidate_quality,
          })
          if (!improved) {
            rejected_candidate_feedback = [
              formatRejectedCandidateQualityFeedback({
                candidate: candidate_quality,
                incumbent: best_quality,
              }),
              "Redacted failure categories from that rejected candidate:",
              formatModelRepairFeedback(
                createModelRepairFeedback(
                  validation.result,
                  validation.preview_build.viewer_validation_by_case,
                  validation.stimulus_causality,
                  validation.preview_build.viewer_model_errors_by_case,
                ),
              ),
            ].join("\n")
            // The model, TSX, diagnosis, and agent trace are sufficient to
            // reproduce a rejected repair. Its multi-megabyte simulation/viewer
            // bundle is neither live nor consumed by a later stage, so retaining
            // one for every budget iteration makes repair storage grow without a
            // bound. Keep complete bundles only for the baseline and candidates
            // that become the new best revision.
            await rm(validation_artifact_dir, { recursive: true, force: true })
            await appendModelLog(
              services.model_run_store,
              context.model_run_id,
              "system",
              `Repair ${attempted_repairs} (${candidate.value.diagnosis.target}) did not improve the candidate; its derived validation bundle was discarded and the live TSX, simulation, and plots were left unchanged.\n`,
            )
            continue
          }

          await projectCandidateValidationUi({
            model_run_store: services.model_run_store,
            model_run_id: context.model_run_id,
            model_dir: context.model_dir,
            immutable_artifact_dir: validation_artifact_dir,
            evidence_dir: comparison.evidence_dir,
            revision: candidate.value.manifest.revision,
            projection: validation.projection,
            development_model: candidate.value,
            signal: attempt_signal,
          })
          best_quality = candidate_quality
          rejected_candidate_feedback = ""
          result = validation.result
          repair_feedback = createModelRepairFeedback(
            validation.result,
            validation.preview_build.viewer_validation_by_case,
            validation.stimulus_causality,
            validation.preview_build.viewer_model_errors_by_case,
          )
          previous_candidate = {
            model_path: join(candidate.value.artifact_dir, "model.lib"),
            model_card_path: join(candidate.value.artifact_dir, "model-card.md"),
            manifest_path: join(candidate.value.artifact_dir, "model-manifest.json"),
            source_dir: candidate.value.source_dir,
            result_path: validation.result_path,
            revision: candidate.value.manifest.revision,
            diagnostic_path: validation.diagnostic_path,
          }
          await appendModelLog(
            services.model_run_store,
            context.model_run_id,
            "system",
            `Repair ${attempted_repairs} diagnosed ${candidate.value.diagnosis.target} and atomically promoted the improved model/TSX/simulation/comparison bundle.\n`,
          )

          if (validation.passed) {
            const repair_elapsed_ms = Date.now() - repair_started_at
            const effectiveness = await createEffectivenessArtifact(repair_elapsed_ms)
            return {
              status: "completed",
              output: {
                result_path: validation.result_path,
                model_path: previous_candidate.model_path,
                model_card_path: previous_candidate.model_card_path,
                manifest_path: previous_candidate.manifest_path,
                contract_path: comparison.contract_path,
                plan_path: comparison.plan_path,
                evidence_dir: comparison.evidence_dir,
                passed: true,
                repair_attempts: attempted_repairs,
                repair_elapsed_ms,
                revision: previous_candidate.revision,
              },
              artifacts: [
                await modelArtifact({
                  id: "final_validation_results",
                  path: validation.result_path,
                  media_type: "application/json",
                  role: "validation_result",
                }),
                await modelArtifact({
                  id: "repair_diagnosis",
                  path: join(candidate.value.artifact_dir, "repair-plan.json"),
                  media_type: "application/json",
                  role: "debug",
                }),
                effectiveness.artifact,
              ],
              metrics: {
                repair_attempts: attempted_repairs,
                repair_elapsed_ms,
                repair_promoted_candidates: effectiveness.report.promoted_candidate_count,
                repair_rejected_candidates: effectiveness.report.rejected_candidate_count,
                repair_quality_improved: effectiveness.report.quality_improved,
                repair_revision_changed: effectiveness.report.revision_changed,
                repair_baseline_failed_cases: baseline_quality.failed_case_count,
                repair_final_failed_cases: best_quality.failed_case_count,
              },
            }
          }
        } finally {
          attempt_budget.dispose()
        }
      }
    } finally {
      services.model_run_store.finishRepairBudget(context.model_run_id)
    }

    const repair_elapsed_ms = Date.now() - repair_started_at
    const effectiveness = await createEffectivenessArtifact(repair_elapsed_ms)
    const quality_message =
      `Repair completed within its ${Math.ceil(initial_repair_budget_ms / 60_000)} minute budget after ${attempted_repairs} candidate(s), but the best model and TSX remain outside the validation target.\n` +
      formatModelRepairFeedback(repair_feedback)
    const quality_hint = `The best complete candidate remains visible. Repair used ${Math.ceil(repair_elapsed_ms / 1_000)} seconds without changing any reference artifact.`
    await appendModelLog(
      services.model_run_store,
      context.model_run_id,
      "system",
      `${quality_message}\n${quality_hint}\n`,
    )
    return {
      status: "completed",
      output: {
        result_path: previous_candidate.result_path,
        model_path: previous_candidate.model_path,
        model_card_path: previous_candidate.model_card_path,
        manifest_path: previous_candidate.manifest_path,
        contract_path: comparison.contract_path,
        plan_path: comparison.plan_path,
        evidence_dir: comparison.evidence_dir,
        passed: false,
        repair_attempts: attempted_repairs,
        repair_elapsed_ms,
        revision: previous_candidate.revision,
      },
      diagnostics: [
        {
          code: "model_quality_target_not_met",
          severity: "warning",
          message: quality_message,
          stage_id: "repair_spice_model",
          operation: "diagnose_repair_and_validate_with_tscircuit",
          artifact_refs: [
            { path: previous_candidate.result_path },
            { path: previous_candidate.diagnostic_path },
            { path: previous_candidate.model_path },
          ],
          entity_refs: [{ entity_type: "model_revision", entity_id: previous_candidate.revision }],
          cause_chain: [],
          hint: quality_hint,
          retryable: false,
        },
      ],
      artifacts: [effectiveness.artifact],
      metrics: {
        repair_attempts: attempted_repairs,
        repair_elapsed_ms,
        repair_promoted_candidates: effectiveness.report.promoted_candidate_count,
        repair_rejected_candidates: effectiveness.report.rejected_candidate_count,
        repair_quality_improved: effectiveness.report.quality_improved,
        repair_revision_changed: effectiveness.report.revision_changed,
        repair_baseline_failed_cases: baseline_quality.failed_case_count,
        repair_final_failed_cases: best_quality.failed_case_count,
      },
    }
  },
})
