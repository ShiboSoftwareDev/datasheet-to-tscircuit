import { join } from "node:path"
import { PipelineError } from "../../pipeline"
import { componentArtifact, readApprovedEvidence } from "../stage-helpers"
import { defineApplicationStage } from "./stage-factory"

export const prepareApplicationStage = defineApplicationStage({
  id: "prepare_application",
  depends_on: [],
  async execute({ context }) {
    const component_path = join(context.job_dir, "component.circuit.tsx")
    const component_circuit_json_path = join(context.job_dir, "component.circuit.json")
    if (
      !(await Bun.file(component_path).exists()) ||
      !(await Bun.file(component_circuit_json_path).exists())
    ) {
      throw new PipelineError({
        code: "validated_component_required",
        message: "Typical-application generation requires a validated component input bundle.",
        stage_id: "prepare_application",
        operation: "prepare_application_input",
        artifact_refs: [{ path: component_path }, { path: component_circuit_json_path }],
        hint: "Run the component_generation pipeline before this pipeline.",
      })
    }
    const { application_plan } = await readApprovedEvidence(context.job_dir)
    return {
      status: "completed",
      output: {
        component_path,
        component_circuit_json_path,
        application_available: application_plan.availability !== "not_present",
      },
      artifacts: [
        await componentArtifact({
          id: "application_component_input",
          path: component_path,
          media_type: "text/typescript",
          role: "pipeline_input",
        }),
        await componentArtifact({
          id: "application_component_circuit_json_input",
          path: component_circuit_json_path,
          media_type: "application/json",
          role: "pipeline_input",
        }),
      ],
      metrics: { application_available: application_plan.availability !== "not_present" },
    }
  },
})
