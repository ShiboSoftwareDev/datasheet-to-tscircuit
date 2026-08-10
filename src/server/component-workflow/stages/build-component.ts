import { join } from "node:path"
import { buildComponentCandidate } from "../component-validation"
import { appendJobLog, componentArtifact } from "../stage-helpers"
import { defineComponentStage } from "./stage-factory"

export const buildComponentStage = defineComponentStage({
  id: "build_component",
  depends_on: ["generate_component"],
  async execute({ context, services, signal }) {
    services.job_store.updateJob(context.job_id, { display_status: "building" })
    const result = await buildComponentCandidate({
      job_id: context.job_id,
      job_dir: context.job_dir,
      job_store: services.job_store,
      tsci_bin: services.tsci_bin,
      process_runner: services.process_runner,
      signal,
      on_output: (stream, message) => appendJobLog(services.job_store, context.job_id, stream, message),
    })
    const result_path = join(context.job_dir, "component-build.json")
    return {
      status: "completed",
      output: {
        result_path,
        build_errors: result.build_errors,
        drc_errors: result.drc_errors,
        circuit_element_count: result.circuit_json.length,
      },
      artifacts: [
        await componentArtifact({
          id: "component_build",
          path: result_path,
          media_type: "application/json",
          role: "build_result",
        }),
      ],
      metrics: {
        build_errors: result.build_errors.length,
        drc_errors: result.drc_errors.length,
        circuit_elements: result.circuit_json.length,
      },
    }
  },
})
