import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { type GeneratedModel, parseModelContract } from "../../modeling"
import { runSpiceValidation, type ValidationPlan } from "../../spice-validation"
import {
  appendModelLog,
  modelArtifact,
  persistCandidateValidationUi,
  projectCandidateValidationUi,
  readJson,
  updateModelProgress,
} from "../stage-helpers"
import { defineModelStage } from "./stage-factory"
import { buildValidationCircuitPreviews } from "../validation-circuit-previews"

export const validateModelStage = defineModelStage({
  id: "validate_model",
  depends_on: ["generate_model"],
  async execute({ context, services, dependency_outputs, signal }) {
    services.model_run_store.updateModelRun(context.model_run_id, { status: "validating" })
    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "validating",
      message: "Compiling declarative fixtures and running ngspice",
    })
    const { contract_path, plan_path, evidence_dir } = dependency_outputs.generate_model
    const [contract_value, plan_value, model_source, model_card, manifest] = await Promise.all([
      readJson(contract_path),
      readJson(plan_path),
      readFile(dependency_outputs.generate_model.model_path, "utf8"),
      readFile(dependency_outputs.generate_model.model_card_path, "utf8"),
      readJson(dependency_outputs.generate_model.manifest_path),
    ])
    const contract = parseModelContract(contract_value)
    const plan = plan_value as ValidationPlan
    const generated: GeneratedModel = {
      source: model_source,
      card: model_card,
      manifest: manifest as GeneratedModel["manifest"],
    }
    const validation_artifact_dir = join(dirname(dependency_outputs.generate_model.model_path), "validation")
    const result = await runSpiceValidation({
      plan,
      manifest: generated.manifest,
      model_source: generated.source,
      model_dir: context.model_dir,
      model_contract: contract,
      artifact_directory: validation_artifact_dir,
      signal,
      ngspice: services.ngspice_executor,
      ngspice_path: services.ngspice_bin,
      append: (stream, message) =>
        appendModelLog(services.model_run_store, context.model_run_id, stream, message),
    })
    const preview_build = await buildValidationCircuitPreviews({
      model_dir: context.model_dir,
      plan,
      generated,
      tsci_bin: services.tsci_bin,
      process_runner: services.process_runner,
      signal,
      append: (stream, message) =>
        appendModelLog(services.model_run_store, context.model_run_id, stream, message),
    })
    const projection = await persistCandidateValidationUi({
      plan,
      result,
      generated,
      contract,
      immutable_artifact_dir: validation_artifact_dir,
      preview_generation: `${context.invocation_id}-${generated.manifest.revision}`,
      circuit_json_by_case: preview_build.circuit_json_by_case,
      circuit_build_errors_by_case: preview_build.errors_by_case,
    })
    await projectCandidateValidationUi({
      model_run_store: services.model_run_store,
      model_run_id: context.model_run_id,
      model_dir: context.model_dir,
      immutable_artifact_dir: validation_artifact_dir,
      evidence_dir,
      revision: generated.manifest.revision,
      projection,
      signal,
    })
    const failing_case_ids = result.cases
      .filter(({ status }) => status !== "passed")
      .map(({ case_id }) => case_id)
    const result_path = join(validation_artifact_dir, "validation-results.json")
    return {
      status: "completed",
      output: {
        result_path,
        model_path: dependency_outputs.generate_model.model_path,
        model_card_path: dependency_outputs.generate_model.model_card_path,
        manifest_path: dependency_outputs.generate_model.manifest_path,
        contract_path,
        plan_path,
        evidence_dir,
        passed: result.passed,
        case_count: result.cases.length,
        failing_case_ids,
        revision: generated.manifest.revision,
      },
      artifacts: [
        await modelArtifact({
          id: "initial_validation_results",
          path: result_path,
          media_type: "application/json",
          role: "validation_result",
        }),
      ],
      metrics: {
        validation_cases: result.cases.length,
        passing_cases: result.cases.filter(({ status }) => status === "passed").length,
      },
    }
  },
})
