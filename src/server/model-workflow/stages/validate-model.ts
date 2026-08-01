import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { type GeneratedModel, parseFreshModelContract } from "../../modeling"
import { PipelineError } from "../../pipeline"
import type { ValidationPlan } from "../../spice-validation"
import { validateCandidate } from "../candidate-validation"
import {
  appendModelLog,
  createModelRepairFeedback,
  modelArtifact,
  readJson,
  updateModelProgress,
} from "../stage-helpers"
import { defineModelStage } from "./stage-factory"

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
    const contract = parseFreshModelContract(contract_value)
    const plan = plan_value as ValidationPlan
    const generated: GeneratedModel = {
      source: model_source,
      card: model_card,
      manifest: manifest as GeneratedModel["manifest"],
    }
    const validation_artifact_dir = join(dirname(dependency_outputs.generate_model.model_path), "validation")
    const validation = await validateCandidate({
      plan,
      contract,
      generated,
      model_dir: context.model_dir,
      validation_artifact_dir,
      evidence_dir,
      preview_generation: `${context.invocation_id}-${generated.manifest.revision}`,
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
      infrastructure_failure,
      passed,
      preview_build,
      projection,
      result,
      result_path,
      stimulus_causality,
      viewer_failures,
    } = validation
    if (infrastructure_failure?.source === "server_validation") {
      throw new PipelineError({
        code: "model_validation_infrastructure_failed",
        message:
          "Model validation failed outside the repairable model boundary: " +
          infrastructure_failure.errors.map(({ code, message }) => `${code}: ${message}`).join("; "),
        stage_id: "validate_model",
        operation: "classify_validation_failure",
        artifact_refs: [{ path: result_path }],
        hint: "Inspect the simulator, raw-result, and validation-plan trace. The failed TSX/reference preview was retained, but model repair was not started for this infrastructure or contract error.",
      })
    }
    if (infrastructure_failure?.source === "tscircuit_viewer") {
      throw new PipelineError({
        code: "model_viewer_simulation_failed",
        message:
          "The validation TSX did not produce the required tscircuit transient graph: " +
          infrastructure_failure.failures.map(({ case_id, message }) => `${case_id}: ${message}`).join("; "),
        stage_id: "validate_model",
        operation: "validate_tscircuit_transient_graph",
        artifact_refs: [{ path: result_path }],
        hint: "Inspect the named validation case and Circuit JSON trace. Only an elapsed-time reference curve backed by one completed tscircuit transient experiment is publishable.",
      })
    }
    const failing_case_ids = [
      ...new Set([
        ...result.cases.filter(({ status }) => status !== "passed").map(({ case_id }) => case_id),
        ...viewer_failures.map(({ case_id }) => case_id),
      ]),
    ]
    const repair_feedback = passed
      ? undefined
      : createModelRepairFeedback(result, preview_build.viewer_validation_by_case, stimulus_causality)
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
        passed,
        case_count: result.cases.length,
        failing_case_ids,
        ...(repair_feedback ? { repair_feedback } : {}),
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
        passing_cases: projection.validation.passing_count,
      },
    }
  },
})
