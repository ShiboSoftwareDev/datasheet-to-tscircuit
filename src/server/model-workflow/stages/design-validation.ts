import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { buildValidationPlanGuide, parseFreshModelContract } from "../../modeling"
import {
  modelArtifact,
  modeledRequirementIds,
  readJson,
  updateModelProgress,
  writeJson,
} from "../stage-helpers"
import { assertValidationPlanSensitiveToDut } from "../validation-sensitivity"
import { buildGraphValidationPlan } from "../validation-plan-from-graphs"
import { projectReferenceDraftUi } from "../reference-draft-ui"
import { defineModelStage } from "./stage-factory"

export const designValidationStage = defineModelStage({
  id: "create_comparison_graphs",
  depends_on: ["find_reference_graphs"],
  async execute({ context, services, dependency_outputs, signal }) {
    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "designing_validation",
      message: "Building one transient analog-simulation circuit for each reference graph",
    })
    const contract_path = dependency_outputs.find_reference_graphs.contract_path
    const attempt_dir = dirname(contract_path)
    const evidence_dir = join(attempt_dir, "evidence")
    const contract = parseFreshModelContract(await readJson(contract_path))
    const requirement_ids = modeledRequirementIds(contract)
    const plan = buildGraphValidationPlan(contract)
    await Promise.all([
      Bun.write(join(attempt_dir, "validation-plan-guide.md"), buildValidationPlanGuide(contract)),
      writeJson(join(attempt_dir, "validation-plan.json"), plan),
    ])

    // Publish the graph screenshot and independently digitized curve before
    // model generation starts. The circuit pane is explicitly pending until a
    // real model candidate is available; later validation atomically replaces
    // this draft with the TSX, Circuit JSON, and comparison waveform.
    await projectReferenceDraftUi({
      model_run_store: services.model_run_store,
      model_run_id: context.model_run_id,
      model_dir: context.model_dir,
      plan,
      evidence_dir,
      signal,
    })

    await assertValidationPlanSensitiveToDut({
      plan,
      contract,
      model_dir: context.model_dir,
      artifact_directory: join(attempt_dir, "private-sensitivity", randomUUID()),
      signal,
      ngspice: services.ngspice_executor,
      ngspice_path: services.ngspice_bin,
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
          id: "validation_plan",
          path: plan_path,
          media_type: "application/json",
          role: "validation_contract",
        }),
      ],
      metrics: {
        agent_attempts: 0,
        validation_cases: plan.cases.length,
      },
    }
  },
})
