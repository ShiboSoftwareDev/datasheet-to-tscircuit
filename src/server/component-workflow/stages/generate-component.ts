import { stat } from "node:fs/promises"
import { join } from "node:path"
import { generateComponentSource } from "../source-candidates"
import { appendJobLog, componentArtifact } from "../stage-helpers"
import { defineComponentStage } from "./stage-factory"

export const generateComponentStage = defineComponentStage({
  id: "generate_component",
  depends_on: ["extract_evidence"],
  async execute({ context, services, signal, debug_dir }) {
    const attempt = await generateComponentSource({
      job_dir: context.job_dir,
      signal,
      use_openai: context.use_openai,
      agent_client: services.agent_client,
      debug_dir,
      on_output: (stream, message) => appendJobLog(services.job_store, context.job_id, stream, message),
    })
    const source_path = join(context.job_dir, "index.circuit.tsx")
    const source_bytes = (await stat(source_path)).size
    return {
      status: "completed",
      output: { source_path, source_bytes },
      artifacts: [
        await componentArtifact({
          id: "component_candidate",
          path: source_path,
          media_type: "text/typescript",
          role: "generated_source",
        }),
      ],
      metrics: { agent_attempts: attempt.attempts, source_bytes },
    }
  },
})
