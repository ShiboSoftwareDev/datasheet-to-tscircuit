import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { PipelineError } from "../../pipeline"
import { validateComponent } from "../component-validation"
import { generateComponentSource } from "../source-candidates"
import { appendJobLog, type CircuitValidationRecord, componentArtifact, readJson } from "../stage-helpers"
import type { ComponentPipelineContext, ComponentPipelineServices } from "../types"
import { defineComponentStage } from "./stage-factory"

async function publishComponentMilestone(input: {
  context: Readonly<ComponentPipelineContext>
  services: Readonly<ComponentPipelineServices>
  result: CircuitValidationRecord
}): Promise<void> {
  const component_code = await readFile(join(input.context.job_dir, "index.circuit.tsx"), "utf8")
  await Bun.write(join(input.context.job_dir, "component.circuit.tsx"), component_code)
  input.services.job_store.updateJob(input.context.job_id, {
    display_status: "agent_running",
    component_ready: true,
    component_code,
    circuit_json: input.result.circuit_json,
  })
  await appendJobLog(
    input.services.job_store,
    input.context.job_id,
    "system",
    "Component passed source, pinout, footprint, schematic, and board-level checks.\n",
  ).catch(() => undefined)
}

export const repairComponentStage = defineComponentStage({
  id: "repair_component",
  depends_on: ["validate_component"],
  async execute({ context, services, dependency_outputs, signal, debug_dir }) {
    let result = (await readJson(
      dependency_outputs.validate_component.result_path,
    )) as CircuitValidationRecord
    if (dependency_outputs.validate_component.passed) {
      signal.throwIfAborted()
      await publishComponentMilestone({ context, services, result })
      return {
        status: "completed",
        commit_state: "committed",
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
      result = await validateComponent({
        job_id: context.job_id,
        job_dir: context.job_dir,
        job_store: services.job_store,
        tsci_bin: services.tsci_bin,
        process_runner: services.process_runner,
        signal,
        on_output: (stream, message) => appendJobLog(services.job_store, context.job_id, stream, message),
      })
      if (!result.passed) continue
      signal.throwIfAborted()
      await publishComponentMilestone({ context, services, result })
      const result_path = join(context.job_dir, "component-validation.json")
      return {
        status: "completed",
        commit_state: "committed",
        output: { result_path, passed: true, repair_attempts: repair_attempt },
        artifacts: [
          await componentArtifact({
            id: "validated_component",
            path: join(context.job_dir, "component.circuit.tsx"),
            media_type: "text/typescript",
            role: "validated_component",
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
