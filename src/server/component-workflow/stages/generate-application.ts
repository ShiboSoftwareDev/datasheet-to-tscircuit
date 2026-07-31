import { join } from "node:path"
import { generateApplicationSource } from "../source-candidates"
import { appendJobLog, componentArtifact, readApprovedEvidence } from "../stage-helpers"
import { defineComponentStage } from "./stage-factory"

export const generateApplicationStage = defineComponentStage({
  id: "generate_application",
  depends_on: ["repair_component"],
  async execute({ context, services, signal, debug_dir }) {
    const { application_plan } = await readApprovedEvidence(context.job_dir)
    if (application_plan.availability === "not_present") {
      return {
        status: "completed",
        output: { available: false, source_path: "" },
        metrics: { application_available: false, agent_attempts: 0 },
      }
    }
    const attempt = await generateApplicationSource({
      job_dir: context.job_dir,
      plan: application_plan,
      signal,
      use_openai: context.use_openai,
      agent_client: services.agent_client,
      debug_dir,
      on_output: (stream, message) => appendJobLog(services.job_store, context.job_id, stream, message),
    })
    const source_path = join(context.job_dir, "typical-application.circuit.tsx")
    return {
      status: "completed",
      output: { available: true, source_path },
      artifacts: [
        await componentArtifact({
          id: "application_candidate",
          path: source_path,
          media_type: "text/typescript",
          role: "generated_source",
        }),
      ],
      metrics: { application_available: true, agent_attempts: attempt.attempts },
    }
  },
})
