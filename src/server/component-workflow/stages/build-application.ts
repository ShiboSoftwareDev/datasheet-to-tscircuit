import { join } from "node:path"
import { buildApplicationCandidate } from "../component-validation"
import { appendJobLog, componentArtifact } from "../stage-helpers"
import { defineApplicationStage } from "./stage-factory"

export const buildApplicationStage = defineApplicationStage({
  id: "build_application",
  depends_on: ["generate_application"],
  async execute({ context, services, dependency_outputs, signal }) {
    services.job_store.updateJob(context.job_id, { display_status: "building" })
    const result = await buildApplicationCandidate({
      job_id: context.job_id,
      job_dir: context.job_dir,
      job_store: services.job_store,
      tsci_bin: services.tsci_bin,
      process_runner: services.process_runner,
      signal,
      on_output: (stream, message) => appendJobLog(services.job_store, context.job_id, stream, message),
    })
    const result_path = join(context.job_dir, "application-build.json")
    const available = dependency_outputs.generate_application.available
    return {
      status: "completed",
      output: {
        result_path,
        available,
        build_errors: [...result.source_errors, ...result.build_errors],
        circuit_element_count: result.circuit_json.length,
      },
      artifacts: [
        await componentArtifact({
          id: "application_build",
          path: result_path,
          media_type: "application/json",
          role: "build_result",
        }),
      ],
      metrics: {
        application_available: available,
        build_errors: result.source_errors.length + result.build_errors.length,
        circuit_elements: result.circuit_json.length,
      },
    }
  },
})
