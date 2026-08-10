import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { appendJobLog, readCircuitValidationRecord, updateJobValidation } from "../stage-helpers"
import { defineApplicationStage } from "./stage-factory"

export const publishStage = defineApplicationStage({
  id: "publish_application",
  depends_on: ["repair_application"],
  async execute({ context, services, dependency_outputs, signal }) {
    const application_ready =
      dependency_outputs.repair_application.available && dependency_outputs.repair_application.passed
    let warnings = services.job_store.getJob(context.job_id)?.warnings ?? []
    if (!application_ready && dependency_outputs.repair_application.errors.length > 0) {
      const warning = `Typical application was not published: ${dependency_outputs.repair_application.errors.join("; ")}`
      if (!warnings.includes(warning)) warnings = [...warnings, warning]
      const current = services.job_store.getJob(context.job_id)?.validation
      if (current) {
        updateJobValidation(services.job_store, context.job_id, {
          application_build: current.application_build === "failed" ? "warning" : current.application_build,
          application_connectivity:
            current.application_connectivity === "failed" ? "warning" : current.application_connectivity,
          application_schematic:
            current.application_schematic === "failed" ? "warning" : current.application_schematic,
          application_visual:
            current.application_visual === "failed" ? "warning" : current.application_visual,
        })
      }
    }
    if (!dependency_outputs.repair_application.available) {
      updateJobValidation(services.job_store, context.job_id, {
        application_build: "not_applicable",
        application_connectivity: "not_applicable",
        application_schematic: "not_applicable",
        application_visual: "not_applicable",
      })
    }
    const typical_application_code =
      application_ready && dependency_outputs.repair_application.available
        ? await readFile(join(context.job_dir, "typical-application.circuit.tsx"), "utf8")
        : undefined
    const typical_application_circuit_json = typical_application_code
      ? (await readCircuitValidationRecord(join(context.job_dir, "application-validation.json"))).circuit_json
      : undefined
    signal.throwIfAborted()
    services.job_store.updateJob(context.job_id, {
      has_errors: false,
      error_message: undefined,
      warnings,
      typical_application_code,
      typical_application_circuit_json,
    })
    await appendJobLog(
      services.job_store,
      context.job_id,
      "system",
      application_ready && dependency_outputs.repair_application.available
        ? "Typical application is ready.\n"
        : dependency_outputs.repair_application.available
          ? "No validated typical application was published.\n"
          : "Datasheet has no typical application to publish.\n",
    ).catch(() => undefined)
    return {
      status: "completed",
      commit_state: "committed",
      output: { application_ready },
    }
  },
})
