import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { TypicalApplicationPreview } from "@/shared/job-types"
import { applicationSourceRelativePath, applicationValidationRelativePath } from "../application-artifacts"
import { appendJobLog, readApplicationPlanCatalog, readCircuitValidationRecord } from "../stage-helpers"
import { defineApplicationStage } from "./stage-factory"

export const publishStage = defineApplicationStage({
  id: "publish_application",
  depends_on: ["repair_application"],
  async execute({ context, services, dependency_outputs, signal }) {
    const catalog = await readApplicationPlanCatalog(context.job_dir)
    const applications: TypicalApplicationPreview[] = []
    for (const entry of catalog.applications) {
      const repair = dependency_outputs.repair_application.applications.find(
        ({ application_id }) => application_id === entry.application_id,
      )
      if (!repair?.passed) continue
      const [code, validation] = await Promise.all([
        readFile(join(context.job_dir, applicationSourceRelativePath(entry)), "utf8"),
        readCircuitValidationRecord(join(context.job_dir, applicationValidationRelativePath(entry))),
      ])
      applications.push({
        application_id: entry.application_id,
        title: entry.title,
        origin: entry.origin,
        code,
        circuit_json: validation.circuit_json,
      })
    }
    const reference = applications.find(({ application_id }) => application_id === "reference")
    const default_application_id =
      applications.find(({ application_id }) => application_id === catalog.default_application_id)
        ?.application_id ?? applications[0]?.application_id
    let warnings = services.job_store.getJob(context.job_id)?.warnings ?? []
    if (dependency_outputs.repair_application.errors.length > 0) {
      const warning = `Some typical applications were not published: ${dependency_outputs.repair_application.errors.join("; ")}`
      if (!warnings.includes(warning)) warnings = [...warnings, warning]
    }
    signal.throwIfAborted()
    services.job_store.updateJob(context.job_id, {
      has_errors: false,
      error_message: undefined,
      warnings,
      typical_application_title: reference?.title ?? applications[0]?.title,
      typical_application_code: reference?.code,
      typical_application_circuit_json: reference?.circuit_json,
      typical_applications: default_application_id ? { default_application_id, applications } : undefined,
    })
    await appendJobLog(
      services.job_store,
      context.job_id,
      "system",
      applications.length > 0
        ? `${applications.length} typical application${applications.length === 1 ? " is" : "s are"} ready.\n`
        : "No validated typical application was published.\n",
    ).catch(() => undefined)
    return {
      status: "completed",
      commit_state: "committed",
      output: { application_ready: applications.length > 0 },
      metrics: {
        published_application_count: applications.length,
        generated_application_count: applications.filter(({ origin }) => origin === "ai_generated").length,
      },
    }
  },
})
