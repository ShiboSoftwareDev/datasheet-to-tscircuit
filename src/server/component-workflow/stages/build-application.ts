import { join } from "node:path"
import { buildApplicationCandidate } from "../component-validation"
import {
  applicationBuildRelativePath,
  applicationOutputStem,
  applicationSourceRelativePath,
} from "../application-artifacts"
import { executablePlanFromCatalogEntry } from "../application-plan-catalog"
import { appendJobLog, componentArtifact, readApplicationPlanCatalog } from "../stage-helpers"
import { defineApplicationStage } from "./stage-factory"

export const buildApplicationStage = defineApplicationStage({
  id: "build_application",
  depends_on: ["generate_application"],
  async execute({ context, services, dependency_outputs, signal }) {
    services.job_store.updateJob(context.job_id, { display_status: "building" })
    const available = dependency_outputs.generate_application.available
    if (!available) {
      return {
        status: "completed",
        output: { available: false, applications: [], build_errors: [], circuit_element_count: 0 },
        metrics: {
          application_available: false,
          application_count: 0,
          build_errors: 0,
          circuit_elements: 0,
        },
      }
    }
    const catalog = await readApplicationPlanCatalog(context.job_dir)
    const applications = []
    const build_errors: string[] = []
    let circuit_element_count = 0
    for (const entry of catalog.applications) {
      signal.throwIfAborted()
      const result_relative_path = applicationBuildRelativePath(entry)
      const result = await buildApplicationCandidate({
        job_id: context.job_id,
        job_dir: context.job_dir,
        job_store: services.job_store,
        tsci_bin: services.tsci_bin,
        process_runner: services.process_runner,
        signal,
        source_relative_path: applicationSourceRelativePath(entry),
        output_stem: applicationOutputStem(entry),
        build_result_relative_path: result_relative_path,
        application_plan: executablePlanFromCatalogEntry(entry),
        on_output: (stream, message) => appendJobLog(services.job_store, context.job_id, stream, message),
      })
      const entry_errors = [...result.source_errors, ...result.build_errors]
      build_errors.push(...entry_errors.map((error) => `${entry.application_id}: ${error}`))
      circuit_element_count += result.circuit_json.length
      applications.push({
        application_id: entry.application_id,
        result_path: join(context.job_dir, result_relative_path),
      })
    }
    return {
      status: "completed",
      output: {
        available,
        applications,
        build_errors,
        circuit_element_count,
      },
      artifacts: await Promise.all(
        applications.map(({ application_id, result_path }) =>
          componentArtifact({
            id: `application_build_${application_id}`,
            path: result_path,
            media_type: "application/json",
            role: "build_result",
          }),
        ),
      ),
      metrics: {
        application_available: available,
        application_count: applications.length,
        build_errors: build_errors.length,
        circuit_elements: circuit_element_count,
      },
    }
  },
})
