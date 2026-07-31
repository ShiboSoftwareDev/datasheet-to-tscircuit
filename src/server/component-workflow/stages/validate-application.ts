import { join } from "node:path"
import { validateApplication } from "../component-validation"
import { appendJobLog, componentArtifact } from "../stage-helpers"
import { defineComponentStage } from "./stage-factory"

export const validateApplicationStage = defineComponentStage({
  id: "validate_application",
  depends_on: ["generate_application"],
  async execute({ context, services, dependency_outputs, signal }) {
    const result = await validateApplication({
      job_id: context.job_id,
      job_dir: context.job_dir,
      job_store: services.job_store,
      tsci_bin: services.tsci_bin,
      process_runner: services.process_runner,
      signal,
      on_output: (stream, message) => appendJobLog(services.job_store, context.job_id, stream, message),
    })
    const result_path = join(context.job_dir, "application-validation.json")
    return {
      status: "completed",
      output: { result_path, passed: result.passed, errors: result.errors },
      artifacts: [
        await componentArtifact({
          id: "initial_application_validation",
          path: result_path,
          media_type: "application/json",
          role: "validation_result",
        }),
      ],
      metrics: {
        application_available: dependency_outputs.generate_application.available,
        validation_errors: result.errors.length,
      },
    }
  },
})
