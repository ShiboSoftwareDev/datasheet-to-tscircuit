import { join } from "node:path"
import { readCircuitBuildRecord, validateBuiltApplication } from "../component-validation"
import { applicationSourceRelativePath, applicationValidationRelativePath } from "../application-artifacts"
import { executablePlanFromCatalogEntry } from "../application-plan-catalog"
import { componentArtifact, readApplicationPlanCatalog, updateJobValidation } from "../stage-helpers"
import { defineApplicationStage } from "./stage-factory"

export const validateApplicationStage = defineApplicationStage({
  id: "validate_application",
  depends_on: ["build_application"],
  async execute({ context, services, dependency_outputs }) {
    const catalog = await readApplicationPlanCatalog(context.job_dir)
    const applications = []
    const errors: string[] = []
    for (const entry of catalog.applications) {
      const build = dependency_outputs.build_application.applications.find(
        ({ application_id }) => application_id === entry.application_id,
      )
      if (!build) throw new Error(`Application build output is missing ${entry.application_id}`)
      const result_relative_path = applicationValidationRelativePath(entry)
      const result = await validateBuiltApplication({
        job_id: context.job_id,
        job_dir: context.job_dir,
        job_store: services.job_store,
        build: await readCircuitBuildRecord(build.result_path),
        application_plan: executablePlanFromCatalogEntry(entry),
        source_relative_path: applicationSourceRelativePath(entry),
        validation_result_relative_path: result_relative_path,
        update_job_validation: false,
      })
      errors.push(...result.errors.map((error) => `${entry.application_id}: ${error}`))
      applications.push({
        application_id: entry.application_id,
        result_path: join(context.job_dir, result_relative_path),
        passed: result.passed,
        errors: result.errors,
      })
    }
    const passed = applications.every((application) => application.passed)
    updateJobValidation(services.job_store, context.job_id, {
      application_build: passed ? "passed" : "failed",
      application_connectivity: passed ? "passed" : "failed",
      application_schematic: passed ? "passed" : "failed",
      application_visual: passed ? "inconclusive" : "failed",
    })
    return {
      status: "completed",
      output: {
        available: dependency_outputs.build_application.available,
        applications,
        passed,
        errors,
      },
      artifacts: await Promise.all(
        applications.map(({ application_id, result_path }) =>
          componentArtifact({
            id: `initial_application_validation_${application_id}`,
            path: result_path,
            media_type: "application/json",
            role: "validation_result",
          }),
        ),
      ),
      metrics: {
        application_available: dependency_outputs.build_application.available,
        application_count: applications.length,
        validation_errors: errors.length,
      },
    }
  },
})
