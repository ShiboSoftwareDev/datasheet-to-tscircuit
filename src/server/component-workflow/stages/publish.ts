import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import type { JobValidation } from "@/shared/job-types"
import { appendJobLog, readJson, updateJobValidation } from "../stage-helpers"
import { defineComponentStage } from "./stage-factory"

export const publishStage = defineComponentStage({
  id: "publish",
  depends_on: ["repair_component", "generate_application", "repair_application"],
  async execute({ context, services, dependency_outputs, signal }) {
    const application_ready =
      dependency_outputs.generate_application.available && dependency_outputs.repair_application.passed
    const component_code = await readFile(join(context.job_dir, "index.circuit.tsx"), "utf8")
    const component_circuit_json = (await readJson(
      join(context.job_dir, "component.circuit.json"),
    )) as AnyCircuitElement[]
    let warnings = services.job_store.getJob(context.job_id)?.warnings ?? []
    if (!application_ready && dependency_outputs.repair_application.errors.length > 0) {
      const warning = `Typical application was not published: ${dependency_outputs.repair_application.errors.join("; ")}`
      if (!warnings.includes(warning)) warnings = [...warnings, warning]
      const current = services.job_store.getJob(context.job_id)?.validation
      if (current) {
        const validation = Object.fromEntries(
          Object.entries(current).map(([key, status]) => [
            key,
            key.startsWith("application_") && status === "failed" ? "warning" : status,
          ]),
        ) as unknown as JobValidation
        services.job_store.updateJob(context.job_id, { validation })
      }
    }
    if (!dependency_outputs.generate_application.available) {
      updateJobValidation(services.job_store, context.job_id, {
        application_build: "not_applicable",
        application_connectivity: "not_applicable",
        application_schematic: "not_applicable",
        application_visual: "not_applicable",
      })
    }
    const typical_application_code =
      application_ready && dependency_outputs.generate_application.available
        ? await readFile(join(context.job_dir, "typical-application.circuit.tsx"), "utf8")
        : undefined
    const typical_application_circuit_json = typical_application_code
      ? (
          (await readJson(join(context.job_dir, "application-validation.json"))) as {
            circuit_json?: AnyCircuitElement[]
          }
        ).circuit_json
      : undefined
    signal.throwIfAborted()
    services.job_store.updateJob(context.job_id, {
      has_errors: false,
      error_message: undefined,
      warnings,
      component_ready: true,
      component_code,
      circuit_json: component_circuit_json,
      typical_application_code,
      typical_application_circuit_json,
    })
    await appendJobLog(
      services.job_store,
      context.job_id,
      "system",
      application_ready && dependency_outputs.generate_application.available
        ? "Component and typical application are ready.\n"
        : "Validated component is ready.\n",
    ).catch(() => undefined)
    return {
      status: "completed",
      commit_state: "committed",
      output: { component_ready: true, application_ready },
    }
  },
})
