import { join } from "node:path"
import {
  readComponentFootprintBuilds,
  validateComponentFootprintCandidates,
} from "../component-footprint-validation"
import { componentArtifact } from "../stage-helpers"
import { defineComponentStage } from "./stage-factory"

export const validateComponentStage = defineComponentStage({
  id: "validate_component",
  depends_on: ["build_component"],
  async execute({ context, services }) {
    const { summary: result } = await validateComponentFootprintCandidates({
      job_id: context.job_id,
      job_dir: context.job_dir,
      job_store: services.job_store,
      builds: await readComponentFootprintBuilds(context.job_dir),
    })
    const result_path = join(context.job_dir, "component-validation.json")
    return {
      status: "completed",
      output: { result_path, passed: result.passed, errors: result.errors },
      artifacts: [
        await componentArtifact({
          id: "initial_component_validation",
          path: result_path,
          media_type: "application/json",
          role: "validation_result",
        }),
      ],
      metrics: { validation_errors: result.errors.length },
    }
  },
})
