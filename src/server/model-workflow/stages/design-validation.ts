import { dirname, join } from "node:path"
import {
  buildValidationPlanGuide,
  parseApplicationFixtureContract,
  parseFreshModelContract,
  parseModelInterface,
} from "../../modeling"
import { runCharacterizer } from "../characterization/run-characterizer"
import { digitizeReferenceGraphs } from "../characterization/source-inventory"
import { projectComparisonGraphsUi } from "../comparison-draft-ui"
import {
  modelArtifact,
  modeledRequirementIds,
  readJson,
  updateModelProgress,
  writeJson,
} from "../stage-helpers"
import { buildGraphValidationPlan } from "../validation-plan-from-graphs"
import { defineModelStage } from "./stage-factory"

export const designValidationStage = defineModelStage({
  id: "create_comparison_graphs",
  depends_on: ["find_reference_graphs"],
  async execute({ context, services, dependency_outputs, signal, debug_dir }) {
    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "designing_validation",
      message: "Digitizing found references and building their comparison circuits",
    })
    const found = dependency_outputs.find_reference_graphs
    const attempt_dir = dirname(found.reference_observation_path)
    const model_interface = parseModelInterface(await readJson(found.model_interface_path))
    const application_fixture = parseApplicationFixtureContract(
      await readJson(found.application_fixture_path),
    )
    const inventory = await digitizeReferenceGraphs({
      context,
      services,
      attempt_dir,
      debug_dir,
      signal,
      model_interface,
      application_fixture,
      found_observation_path: found.reference_observation_path,
    })
    await runCharacterizer({
      context,
      services,
      attempt_dir,
      debug_dir,
      signal,
      model_interface,
      application_fixture,
      time_graph_hints_path: inventory.time_graph_hints_path,
      source_observation: inventory.observation,
      source_proof: inventory.source_proof,
    })
    const contract_path = join(attempt_dir, "model-contract.json")
    const evidence_dir = join(attempt_dir, "evidence")
    const contract = parseFreshModelContract(await readJson(contract_path))
    const requirement_ids = modeledRequirementIds(contract)
    const plan = buildGraphValidationPlan(contract)
    await Promise.all([
      Bun.write(join(attempt_dir, "validation-plan-guide.md"), buildValidationPlanGuide(contract)),
      writeJson(join(attempt_dir, "validation-plan.json"), plan),
    ])

    await projectComparisonGraphsUi({
      model_run_store: services.model_run_store,
      model_run_id: context.model_run_id,
      model_dir: context.model_dir,
      contract,
      plan,
      evidence_dir,
      signal,
    })
    const plan_path = join(attempt_dir, "validation-plan.json")
    return {
      status: "completed",
      output: {
        plan_path,
        contract_path,
        evidence_dir,
        case_count: plan.cases.length,
        requirement_ids,
      },
      artifacts: [
        await modelArtifact({
          id: "model_contract",
          path: contract_path,
          media_type: "application/json",
          role: "model_contract",
        }),
        await modelArtifact({
          id: "model_reference_observation",
          path: join(attempt_dir, "model-reference-observation.json"),
          media_type: "application/json",
          role: "source_observation",
        }),
        await modelArtifact({
          id: "model_reference_source_proof",
          path: join(attempt_dir, "model-reference-source-proof.json"),
          media_type: "application/json",
          role: "source_verification",
        }),
        await modelArtifact({
          id: "model_reference_verification",
          path: join(attempt_dir, "model-reference-verification.json"),
          media_type: "application/json",
          role: "source_verification",
        }),
        await modelArtifact({
          id: "validation_plan",
          path: plan_path,
          media_type: "application/json",
          role: "validation_contract",
        }),
      ],
      metrics: {
        agent_attempts: inventory.observer_attempts,
        validation_cases: plan.cases.length,
      },
    }
  },
})
