import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { readCircuitBuildRecord, validateBuiltComponent } from "../component-validation"
import { componentArtifact } from "../stage-helpers"
import { defineComponentStage } from "./stage-factory"

export const validateComponentStage = defineComponentStage({
  id: "validate_component",
  depends_on: ["build_component"],
  async execute({ context, services, dependency_outputs }) {
    const result = await validateBuiltComponent({
      job_id: context.job_id,
      job_dir: context.job_dir,
      job_store: services.job_store,
      build: await readCircuitBuildRecord(dependency_outputs.build_component.result_path),
    })
    services.job_store.updateJob(context.job_id, {
      component_code: await readFile(join(context.job_dir, "index.circuit.tsx"), "utf8"),
      circuit_json: result.circuit_json,
    })
    const result_path = join(context.job_dir, "component-validation.json")
    return {
      status: "completed",
      output: { result_path, passed: result.passed, errors: result.errors },
      artifacts: [
        await componentArtifact({
          id: "initial_component_validation",
          path: result_path,
          media_type: "application/json",
          role: "validation_result",
        }),
      ],
      metrics: { validation_errors: result.errors.length },
    }
  },
})
