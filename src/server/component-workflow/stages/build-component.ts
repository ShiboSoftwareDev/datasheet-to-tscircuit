import { join } from "node:path"
import { buildComponentFootprintCandidates } from "../component-footprint-validation"
import { appendJobLog, componentArtifact } from "../stage-helpers"
import { defineComponentStage } from "./stage-factory"

export const buildComponentStage = defineComponentStage({
  id: "build_component",
  depends_on: ["generate_component"],
  async execute({ context, services, signal }) {
    services.job_store.updateJob(context.job_id, { display_status: "building" })
    const builds = await buildComponentFootprintCandidates({
      job_id: context.job_id,
      job_dir: context.job_dir,
      job_store: services.job_store,
      tsci_bin: services.tsci_bin,
      process_runner: services.process_runner,
      signal,
      on_output: (stream, message) => appendJobLog(services.job_store, context.job_id, stream, message),
    })
    const result = builds.find((build) => build.build_result_relative_path === "component-build.json")?.build
    if (!result) throw new Error("Component build produced no default footprint result")
    const result_path = join(context.job_dir, "component-build.json")
    return {
      status: "completed",
      output: {
        result_path,
        build_errors: builds.flatMap((build) =>
          build.build.build_errors.map((error) => `${build.footprint_id}: ${error}`),
        ),
        drc_errors: builds.flatMap((build) =>
          build.build.drc_errors.map((error) => `${build.footprint_id}: ${error}`),
        ),
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
        build_errors: builds.reduce((total, build) => total + build.build.build_errors.length, 0),
        drc_errors: builds.reduce((total, build) => total + build.build.drc_errors.length, 0),
        circuit_elements: builds.reduce((total, build) => total + build.build.circuit_json.length, 0),
        footprint_count: builds.length,
      },
    }
  },
})
