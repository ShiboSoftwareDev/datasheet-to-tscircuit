import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  applicationBuildRelativePath,
  applicationOutputStem,
  applicationSourceRelativePath,
  applicationValidationRelativePath,
} from "../application-artifacts"
import { executablePlanFromCatalogEntry } from "../application-plan-catalog"
import { buildApplicationCandidate, validateBuiltApplication } from "../component-validation"
import { generateApplicationSource } from "../source-candidates"
import {
  appendJobLog,
  componentArtifact,
  readApplicationPlanCatalog,
  readCircuitValidationRecord,
  updateJobValidation,
} from "../stage-helpers"
import { defineApplicationStage } from "./stage-factory"

export const repairApplicationStage = defineApplicationStage({
  id: "repair_application",
  depends_on: ["validate_application"],
  async execute({ context, services, dependency_outputs, signal, debug_dir }) {
    const catalog = await readApplicationPlanCatalog(context.job_dir)
    const applications = []
    const max_repairs = 2
    for (const entry of catalog.applications) {
      signal.throwIfAborted()
      const initial = dependency_outputs.validate_application.applications.find(
        ({ application_id }) => application_id === entry.application_id,
      )
      if (!initial) throw new Error(`Application validation output is missing ${entry.application_id}`)
      let result = await readCircuitValidationRecord(initial.result_path)
      let repair_attempts = 0
      const plan = executablePlanFromCatalogEntry(entry)
      for (let repair_attempt = 1; !result.passed && repair_attempt <= max_repairs; repair_attempt += 1) {
        repair_attempts = repair_attempt
        await generateApplicationSource({
          job_dir: context.job_dir,
          component_source_path: join(context.job_dir, "component.circuit.tsx"),
          plan,
          plan_origin: entry.origin,
          source_relative_path: applicationSourceRelativePath(entry),
          signal,
          use_openai: context.use_openai,
          agent_client: services.agent_client,
          debug_dir: join(debug_dir, entry.application_id, `candidate-${repair_attempt}`),
          feedback: result.errors.join("\n"),
          on_output: (stream, message) => appendJobLog(services.job_store, context.job_id, stream, message),
        })
        const build = await buildApplicationCandidate({
          job_id: context.job_id,
          job_dir: context.job_dir,
          job_store: services.job_store,
          tsci_bin: services.tsci_bin,
          process_runner: services.process_runner,
          signal,
          application_plan: plan,
          source_relative_path: applicationSourceRelativePath(entry),
          output_stem: applicationOutputStem(entry),
          build_result_relative_path: applicationBuildRelativePath(entry),
          on_output: (stream, message) => appendJobLog(services.job_store, context.job_id, stream, message),
        })
        result = await validateBuiltApplication({
          job_id: context.job_id,
          job_dir: context.job_dir,
          job_store: services.job_store,
          build,
          application_plan: plan,
          source_relative_path: applicationSourceRelativePath(entry),
          validation_result_relative_path: applicationValidationRelativePath(entry),
          update_job_validation: false,
        })
      }
      if (!result.passed) {
        const source_relative_path = applicationSourceRelativePath(entry)
        const rejected_source = await readFile(join(context.job_dir, source_relative_path)).catch(
          () => undefined,
        )
        if (rejected_source) {
          await Bun.write(
            join(debug_dir, entry.application_id, "rejected-application.circuit.tsx"),
            rejected_source,
          )
        }
        await Promise.all([
          rm(join(context.job_dir, source_relative_path), { force: true }),
          rm(join(context.job_dir, "dist", applicationOutputStem(entry)), {
            recursive: true,
            force: true,
          }),
        ])
      }
      applications.push({
        application_id: entry.application_id,
        result_path: join(context.job_dir, applicationValidationRelativePath(entry)),
        passed: result.passed,
        repair_attempts,
        errors: result.errors,
      })
    }
    const passed = applications.every((application) => application.passed)
    const errors = applications.flatMap((application) =>
      application.errors.map((error) => `${application.application_id}: ${error}`),
    )
    const repair_attempts = applications.reduce(
      (total, application) => total + application.repair_attempts,
      0,
    )
    updateJobValidation(services.job_store, context.job_id, {
      application_build: passed ? "passed" : "warning",
      application_connectivity: passed ? "passed" : "warning",
      application_schematic: passed ? "passed" : "warning",
      application_visual: passed ? "inconclusive" : "warning",
    })
    if (!passed) {
      await appendJobLog(
        services.job_store,
        context.job_id,
        "system",
        `Some application variants remained invalid after repair: ${errors.join("; ")}\n`,
      )
    }
    return {
      status: "completed",
      output: {
        available: applications.length > 0,
        passed,
        repair_attempts,
        errors,
        applications,
      },
      artifacts: await Promise.all(
        applications
          .filter(({ passed: application_passed }) => application_passed)
          .map((application) => {
            const entry = catalog.applications.find(
              ({ application_id }) => application_id === application.application_id,
            )
            if (!entry) throw new Error(`Application catalog lost ${application.application_id}`)
            return componentArtifact({
              id: `validated_application_${application.application_id}`,
              path: join(context.job_dir, applicationSourceRelativePath(entry)),
              media_type: "text/typescript",
              role: "validated_application",
            })
          }),
      ),
      diagnostics: errors.length
        ? [
            {
              code: "application_validation_failed",
              severity: "warning",
              message: errors.join("; "),
              stage_id: "repair_application",
              operation: "repair_application",
              entity_refs: [],
              artifact_refs: applications.map(({ result_path }) => ({ path: result_path })),
              cause_chain: [],
              retryable: false,
            },
          ]
        : [],
      metrics: {
        application_count: applications.length,
        valid_application_count: applications.filter((application) => application.passed).length,
        repair_attempts,
      },
    }
  },
})
