import { join } from "node:path"
import { PipelineError } from "../../pipeline"
import { buildComponentCandidate, validateBuiltComponent } from "../component-validation"
import { generateComponentSource } from "../source-candidates"
import { appendJobLog, componentArtifact, readCircuitValidationRecord } from "../stage-helpers"
import { defineComponentStage } from "./stage-factory"

export const repairComponentStage = defineComponentStage({
  id: "repair_component",
  depends_on: ["validate_component"],
  async execute({ context, services, dependency_outputs, signal, debug_dir }) {
    let result = await readCircuitValidationRecord(dependency_outputs.validate_component.result_path)
    if (dependency_outputs.validate_component.passed) {
      return {
        status: "completed",
        output: {
          result_path: dependency_outputs.validate_component.result_path,
          passed: true,
          repair_attempts: 0,
        },
        metrics: { repair_attempts: 0 },
      }
    }
    const max_repairs = 2
    for (let repair_attempt = 1; repair_attempt <= max_repairs; repair_attempt += 1) {
      services.job_store.updateJob(context.job_id, { display_status: "agent_running" })
      await generateComponentSource({
        job_dir: context.job_dir,
        signal,
        use_openai: context.use_openai,
        agent_client: services.agent_client,
        debug_dir: join(debug_dir, `candidate-${repair_attempt}`),
        feedback: result.errors.join("\n"),
        on_output: (stream, message) => appendJobLog(services.job_store, context.job_id, stream, message),
      })
      services.job_store.updateJob(context.job_id, { display_status: "building" })
      const build = await buildComponentCandidate({
        job_id: context.job_id,
        job_dir: context.job_dir,
        job_store: services.job_store,
        tsci_bin: services.tsci_bin,
        process_runner: services.process_runner,
        signal,
        on_output: (stream, message) => appendJobLog(services.job_store, context.job_id, stream, message),
      })
      result = await validateBuiltComponent({
        job_id: context.job_id,
        job_dir: context.job_dir,
        job_store: services.job_store,
        build,
      })
      if (!result.passed) continue
      const result_path = join(context.job_dir, "component-validation.json")
      return {
        status: "completed",
        commit_state: "committed",
        output: { result_path, passed: true, repair_attempts: repair_attempt },
        artifacts: [
          await componentArtifact({
            id: "repaired_component_candidate",
            path: join(context.job_dir, "index.circuit.tsx"),
            media_type: "text/typescript",
            role: "generated_source",
          }),
        ],
        metrics: { repair_attempts: repair_attempt },
      }
    }
    throw new PipelineError({
      code: "component_validation_failed",
      message: `Component did not pass deterministic validation after ${max_repairs} repairs: ${result.errors.join("; ")}`,
      stage_id: "repair_component",
      operation: "repair_component",
      artifact_refs: [
        { path: join(context.job_dir, "component-validation.json") },
        { path: join(context.job_dir, "index.circuit.tsx") },
      ],
      hint: "Inspect the repair_component debug bundle and component-validation.json.",
    })
  },
})
