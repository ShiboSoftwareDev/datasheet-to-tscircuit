import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { runAgentArtifactStage } from "../../infrastructure/agent"
import { createStageWorkspace, readBoundedJsonArtifact } from "../../infrastructure/artifacts"
import { buildValidationPlanGuide, buildValidationPlanPrompt, parseModelContract } from "../../modeling"
import { parseValidationPlan, type ValidationPlan } from "../../spice-validation"
import {
  appendModelLog,
  modelArtifact,
  modeledRequirementIds,
  readJson,
  updateModelProgress,
  writeJson,
} from "../stage-helpers"
import { assertValidationPlanSensitiveToDut } from "../validation-sensitivity"
import { defineModelStage } from "./stage-factory"

async function assertPlanEvidencePaths(workspace: string, plan: ValidationPlan): Promise<void> {
  for (const validation_case of plan.cases) {
    for (const observation of validation_case.observations) {
      const image = observation.evidence?.image
      if (!image) continue
      if (!image.startsWith("evidence/") || image.split(/[\\/]/).includes("..")) {
        throw new Error(`Observation ${observation.id} evidence image must stay under evidence/: ${image}`)
      }
      if (!(await Bun.file(join(workspace, image)).exists())) {
        throw new Error(`Observation ${observation.id} references missing evidence image ${image}`)
      }
    }
  }
}

export const designValidationStage = defineModelStage({
  id: "design_validation",
  depends_on: ["characterize"],
  async execute({ context, services, dependency_outputs, signal, debug_dir }) {
    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "designing_validation",
      message: "Designing declarative validation fixtures from the model contract",
    })
    const contract_path = dependency_outputs.characterize.contract_path
    const attempt_dir = dirname(contract_path)
    const evidence_dir = join(attempt_dir, "evidence")
    const contract = parseModelContract(await readJson(contract_path))
    const requirement_ids = modeledRequirementIds(contract)
    await Bun.write(join(attempt_dir, "validation-plan-guide.md"), buildValidationPlanGuide(contract))
    const attempt = await runAgentArtifactStage({
      stage_id: "design_validation",
      phase_label: "Validation-plan design",
      max_artifact_attempts: 3,
      signal,
      use_openai: context.use_openai,
      agent_client: services.agent_client,
      create_workspace: () =>
        createStageWorkspace({
          prefix: "model-validation-plan",
          files: [
            { source: join(context.model_dir, "AGENTS.md") },
            { source: contract_path, destination: "model-contract.json" },
            { source: join(context.model_dir, "model-interface.json") },
            {
              source: join(attempt_dir, "validation-plan-guide.md"),
              destination: "validation-plan-guide.md",
            },
            { source: join(context.model_dir, "component.circuit.tsx") },
            { source: join(context.model_dir, "component-evidence.json") },
            { source: join(context.model_dir, "typical-application-plan.json") },
          ],
          directories: [{ source: evidence_dir, destination: "evidence", required: false }],
        }),
      build_prompt: (feedback) => buildValidationPlanPrompt({ contract, feedback }),
      heartbeat_paths: (workspace) => [join(workspace, "validation-plan.json")],
      on_output: (stream, message) =>
        appendModelLog(services.model_run_store, context.model_run_id, stream, message),
      rejection_debug: {
        debug_dir,
        files: ["validation-plan.json"],
      },
      validate: async (workspace) => {
        const raw = await readBoundedJsonArtifact({
          path: join(workspace, "validation-plan.json"),
          max_bytes: 4 * 1024 * 1024,
          max_depth: 64,
          max_nodes: 100_000,
        })
        const plan = parseValidationPlan(raw, {
          model_interface: contract.interface,
          model_requirements: contract.characterization.requirements,
        })
        await assertPlanEvidencePaths(workspace, plan)
        await assertValidationPlanSensitiveToDut({
          plan,
          contract,
          model_dir: context.model_dir,
          artifact_directory: join(attempt_dir, "private-sensitivity", randomUUID()),
          signal,
          ngspice: services.ngspice_executor,
          ngspice_path: services.ngspice_bin,
        })
        return plan
      },
      promote: async (_workspace, plan) => {
        await writeJson(join(attempt_dir, "validation-plan.json"), plan)
      },
    })
    const plan_path = join(attempt_dir, "validation-plan.json")
    return {
      status: "completed",
      output: {
        plan_path,
        contract_path,
        evidence_dir,
        case_count: attempt.value.cases.length,
        requirement_ids,
      },
      artifacts: [
        await modelArtifact({
          id: "validation_plan",
          path: plan_path,
          media_type: "application/json",
          role: "validation_contract",
        }),
      ],
      metrics: {
        agent_attempts: attempt.attempts,
        validation_cases: attempt.value.cases.length,
      },
    }
  },
})
