import { join } from "node:path"
import { readCircuitBuildRecord, validateBuiltApplication } from "../component-validation"
import { componentArtifact } from "../stage-helpers"
import { defineApplicationStage } from "./stage-factory"

export const validateApplicationStage = defineApplicationStage({
  id: "validate_application",
  depends_on: ["build_application"],
  async execute({ context, services, dependency_outputs }) {
    const result = await validateBuiltApplication({
      job_id: context.job_id,
      job_dir: context.job_dir,
      job_store: services.job_store,
      build: await readCircuitBuildRecord(dependency_outputs.build_application.result_path),
    })
    const result_path = join(context.job_dir, "application-validation.json")
    return {
      status: "completed",
      output: {
        result_path,
        available: dependency_outputs.build_application.available,
        passed: result.passed,
        errors: result.errors,
      },
      artifacts: [
        await componentArtifact({
          id: "initial_application_validation",
          path: result_path,
          media_type: "application/json",
          role: "validation_result",
        }),
      ],
      metrics: {
        application_available: dependency_outputs.build_application.available,
        validation_errors: result.errors.length,
      },
    }
  },
})
