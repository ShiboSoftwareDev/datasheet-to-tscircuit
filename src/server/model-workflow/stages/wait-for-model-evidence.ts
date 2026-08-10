import { prepareModelEvidenceInputs } from "../../modeling"
import { modelArtifact, updateModelProgress } from "../stage-helpers"
import { defineModelStage } from "./stage-factory"

export const waitForModelEvidenceStage = defineModelStage({
  id: "wait_for_model_evidence",
  depends_on: ["find_reference_graphs"],
  async execute({ context, services }) {
    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "designing_validation",
      message: "Capturing committed component and application evidence for comparison design",
    })
    const prepared = await prepareModelEvidenceInputs({
      job_dir: context.job_dir,
      model_dir: context.model_dir,
      invocation_id: context.invocation_id,
    })
    return {
      status: "completed",
      output: {
        model_interface_path: prepared.interface_path,
        application_fixture_path: prepared.application_fixture_path,
        application_fixture_sha256: prepared.application_fixture.contract_sha256,
      },
      artifacts: [
        await modelArtifact({
          id: "model_interface",
          path: prepared.interface_path,
          media_type: "application/json",
          role: "model_contract",
        }),
        await modelArtifact({
          id: "application_fixture_contract",
          path: prepared.application_fixture_path,
          media_type: "application/json",
          role: "model_contract",
        }),
      ],
      metrics: {
        application_fixture_documented: prepared.application_fixture.availability === "documented" ? 1 : 0,
      },
    }
  },
})
