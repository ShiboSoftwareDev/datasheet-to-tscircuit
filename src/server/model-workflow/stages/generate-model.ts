import { join } from "node:path"
import { parseModelContract } from "../../modeling"
import { generateModelCandidate } from "../model-candidate"
import { appendModelLog, modelArtifact, readJson, updateModelProgress } from "../stage-helpers"
import { defineModelStage } from "./stage-factory"

export const generateModelStage = defineModelStage({
  id: "generate_model",
  depends_on: ["design_validation"],
  async execute({ context, services, dependency_outputs, signal, debug_dir }) {
    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "generating_model",
      message: "Generating a bounded self-contained SPICE subcircuit",
    })
    const { contract_path, plan_path, evidence_dir } = dependency_outputs.design_validation
    const contract = parseModelContract(await readJson(contract_path))
    const strategy = services.strategy_registry.require(
      contract.characterization.strategy,
      contract.characterization.family,
    )
    const attempt = await generateModelCandidate({
      model_dir: context.model_dir,
      contract,
      evidence_dir,
      strategy_guidance: strategy.guidance,
      stage_id: "generate_model",
      phase_label: "SPICE model generation",
      signal,
      use_openai: context.use_openai,
      agent_client: services.agent_client,
      max_artifact_attempts: 3,
      debug_dir,
      on_output: (stream, message) =>
        appendModelLog(services.model_run_store, context.model_run_id, stream, message),
    })
    const model_path = join(attempt.value.artifact_dir, "model.lib")
    const model_card_path = join(attempt.value.artifact_dir, "model-card.md")
    const manifest_path = join(attempt.value.artifact_dir, "model-manifest.json")
    return {
      status: "completed",
      output: {
        model_path,
        model_card_path,
        manifest_path,
        contract_path,
        plan_path,
        evidence_dir,
        revision: attempt.value.manifest.revision,
      },
      artifacts: [
        await modelArtifact({
          id: "spice_model",
          path: model_path,
          media_type: "text/plain",
          role: "generated_model",
        }),
        await modelArtifact({
          id: "model_manifest",
          path: manifest_path,
          media_type: "application/json",
          role: "model_manifest",
        }),
        await modelArtifact({
          id: "model_card",
          path: model_card_path,
          media_type: "text/markdown",
          role: "model_documentation",
        }),
      ],
      metrics: { agent_attempts: attempt.attempts },
    }
  },
})
