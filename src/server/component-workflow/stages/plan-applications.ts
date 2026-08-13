import { join } from "node:path"
import { planGeneratedApplications } from "../application-planner"
import { appendJobLog, componentArtifact } from "../stage-helpers"
import { defineApplicationStage } from "./stage-factory"

export const planApplicationsStage = defineApplicationStage({
  id: "plan_applications",
  depends_on: ["extract_application_evidence", "wait_for_component"],
  async execute({ context, services, signal, debug_dir }) {
    const result = await planGeneratedApplications({
      job_dir: context.job_dir,
      signal,
      use_openai: context.use_openai,
      agent_client: services.agent_client,
      debug_dir,
      on_output: (stream, message) => appendJobLog(services.job_store, context.job_id, stream, message),
    })
    const catalog_path = join(context.job_dir, "application-plan-catalog.json")
    return {
      status: "completed",
      commit_state: "committed",
      output: {
        catalog_path,
        application_count: result.catalog.applications.length,
      },
      artifacts: [
        await componentArtifact({
          id: "application_plan_catalog",
          path: catalog_path,
          media_type: "application/json",
          role: "application_plan",
        }),
      ],
      metrics: {
        application_count: result.catalog.applications.length,
        generated_application_count: result.catalog.applications.filter(
          ({ origin }) => origin === "ai_generated",
        ).length,
        agent_attempts: result.attempts,
      },
    }
  },
})
