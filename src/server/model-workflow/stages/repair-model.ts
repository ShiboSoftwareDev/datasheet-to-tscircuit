import { join } from "node:path"
import { parseModelContract } from "../../modeling"
import { PipelineError } from "../../pipeline"
import { runSpiceValidation, type ValidationPlan, type ValidationRunResult } from "../../spice-validation"
import { generateModelCandidate } from "../model-candidate"
import {
  appendModelLog,
  modelArtifact,
  persistCandidateValidationUi,
  readJson,
  updateModelProgress,
  validationFailureFeedback,
} from "../stage-helpers"
import { getNonRepairableValidationErrors } from "../validation-repair-policy"
import { defineModelStage } from "./stage-factory"

export const repairModelStage = defineModelStage({
  id: "repair_model",
  depends_on: ["validate_model"],
  async execute({ context, services, dependency_outputs, signal, debug_dir }) {
    if (dependency_outputs.validate_model.passed) {
      return {
        status: "completed",
        output: {
          result_path: dependency_outputs.validate_model.result_path,
          model_path: dependency_outputs.validate_model.model_path,
          model_card_path: dependency_outputs.validate_model.model_card_path,
          manifest_path: dependency_outputs.validate_model.manifest_path,
          contract_path: dependency_outputs.validate_model.contract_path,
          plan_path: dependency_outputs.validate_model.plan_path,
          evidence_dir: dependency_outputs.validate_model.evidence_dir,
          passed: true,
          repair_attempts: 0,
          revision: dependency_outputs.validate_model.revision,
        },
        metrics: { repair_attempts: 0 },
      }
    }

    const { contract_path, plan_path, evidence_dir } = dependency_outputs.validate_model
    const [contract_value, plan_value] = await Promise.all([readJson(contract_path), readJson(plan_path)])
    const contract = parseModelContract(contract_value)
    const plan = plan_value as ValidationPlan
    const strategy = services.strategy_registry.require(
      contract.characterization.strategy,
      contract.characterization.family,
    )
    let result = (await readJson(dependency_outputs.validate_model.result_path)) as ValidationRunResult
    const non_repairable_errors = getNonRepairableValidationErrors(result)
    if (non_repairable_errors.length > 0) {
      throw new PipelineError({
        code: "model_validation_infrastructure_failed",
        message:
          "Model repair was not started because validation failed outside the model boundary: " +
          non_repairable_errors.map(({ code, message }) => `${code}: ${message}`).join("; "),
        stage_id: "repair_model",
        operation: "classify_validation_failure",
        artifact_refs: [{ path: dependency_outputs.validate_model.result_path }],
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
      model_path: dependency_outputs.validate_model.model_path,
      model_card_path: dependency_outputs.validate_model.model_card_path,
      manifest_path: dependency_outputs.validate_model.manifest_path,
      result_path: dependency_outputs.validate_model.result_path,
      revision: dependency_outputs.validate_model.revision,
    }
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
        evidence_dir,
        previous_candidate,
        strategy_guidance: strategy.guidance,
        feedback: validationFailureFeedback(result),
        stage_id: "repair_model",
        phase_label: `SPICE model repair ${repair_attempt}`,
        signal,
        use_openai: context.use_openai,
        agent_client: services.agent_client,
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
      result = await runSpiceValidation({
        plan,
        manifest: candidate.value.manifest,
        model_source: candidate.value.source,
        model_dir: context.model_dir,
        model_contract: contract,
        artifact_directory: join(candidate.value.artifact_dir, "validation"),
        signal,
        ngspice: services.ngspice_executor,
        ngspice_path: services.ngspice_bin,
        append: (stream, message) =>
          appendModelLog(services.model_run_store, context.model_run_id, stream, message),
      })
      await persistCandidateValidationUi({
        plan,
        result,
        generated: candidate.value,
        immutable_artifact_dir: join(candidate.value.artifact_dir, "validation"),
      })
      if (result.passed) {
        const result_path = join(candidate.value.artifact_dir, "validation", "validation-results.json")
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
          ],
          metrics: { repair_attempts: repair_attempt },
        }
      }
      const non_repairable_repair_errors = getNonRepairableValidationErrors(result)
      if (non_repairable_repair_errors.length > 0) {
        throw new PipelineError({
          code: "model_validation_infrastructure_failed",
          message:
            `Validation of repaired model ${repair_attempt} failed outside the model boundary: ` +
            non_repairable_repair_errors.map(({ code, message }) => `${code}: ${message}`).join("; "),
          stage_id: "repair_model",
          operation: "classify_validation_failure",
          artifact_refs: [
            { path: join(candidate.value.artifact_dir, "validation", "validation-results.json") },
          ],
          hint: "Inspect the simulator and validation trace; another model-generation attempt would not repair this failure.",
        })
      }
      previous_candidate = {
        model_path: join(candidate.value.artifact_dir, "model.lib"),
        model_card_path: join(candidate.value.artifact_dir, "model-card.md"),
        manifest_path: join(candidate.value.artifact_dir, "model-manifest.json"),
        result_path: join(candidate.value.artifact_dir, "validation", "validation-results.json"),
        revision: candidate.value.manifest.revision,
      }
    }

    throw new PipelineError({
      code: "model_validation_failed",
      message:
        `Model did not pass the immutable validation plan after ${attempted_repairs} repair attempt(s).\n` +
        validationFailureFeedback(result),
      stage_id: "repair_model",
      operation: "repair_and_validate_model",
      artifact_refs: [{ path: previous_candidate.result_path }, { path: previous_candidate.model_path }],
      entity_refs: [{ entity_type: "model_revision", entity_id: previous_candidate.revision }],
      hint: "Inspect validation-results.json and the repair_model debug bundle. The validation plan was not changed during repair.",
    })
  },
})
