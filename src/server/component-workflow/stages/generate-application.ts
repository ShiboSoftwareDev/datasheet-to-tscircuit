import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { PipelineError } from "../../pipeline"
import { generateApplicationSource } from "../source-candidates"
import { applicationSourceRelativePath } from "../application-artifacts"
import { executablePlanFromCatalogEntry } from "../application-plan-catalog"
import {
  appendJobLog,
  componentArtifact,
  readApplicationPlanCatalog,
  readApprovedApplicationEvidence,
  readComponentBoundApplicationEvidence,
} from "../stage-helpers"
import { defineApplicationStage } from "./stage-factory"

export const generateApplicationStage = defineApplicationStage({
  id: "generate_application",
  depends_on: ["plan_applications", "wait_for_component"],
  async execute({ context, services, dependency_outputs, signal, debug_dir }) {
    const extracted_application_plan = await readApprovedApplicationEvidence(context.job_dir)
    const application_plan =
      extracted_application_plan.availability === "documented"
        ? await readComponentBoundApplicationEvidence(context.job_dir)
        : extracted_application_plan
    const component_input = dependency_outputs.wait_for_component
    if (!component_input.component_required) {
      throw new Error("Application generation received no component input")
    }
    const component_path = component_input.component_path
    const component_circuit_json_path = component_input.component_circuit_json_path
    if (
      !(await Bun.file(component_path).exists()) ||
      !(await Bun.file(component_circuit_json_path).exists())
    ) {
      throw new PipelineError({
        code: "validated_component_required",
        message: "Typical-application generation requires a validated component input bundle.",
        stage_id: "generate_application",
        operation: "load_application_component_input",
        artifact_refs: [{ path: component_path }, { path: component_circuit_json_path }],
        hint: "Run the component_generation pipeline before this pipeline.",
      })
    }
    const [component_bytes, component_circuit_json_bytes] = await Promise.all([
      readFile(component_path),
      readFile(component_circuit_json_path),
    ])
    if (
      createHash("sha256").update(component_bytes).digest("hex") !== component_input.component_sha256 ||
      createHash("sha256").update(component_circuit_json_bytes).digest("hex") !==
        component_input.component_circuit_json_sha256
    ) {
      throw new PipelineError({
        code: "validated_component_required",
        message: "The validated component changed after the application wait completed.",
        stage_id: "generate_application",
        operation: "verify_application_component_input",
        artifact_refs: [{ path: component_path }, { path: component_circuit_json_path }],
      })
    }
    const catalog = await readApplicationPlanCatalog(context.job_dir)
    const applications = []
    let agent_attempts = 0
    for (const entry of catalog.applications) {
      signal.throwIfAborted()
      const plan =
        entry.origin === "datasheet_reference" ? application_plan : executablePlanFromCatalogEntry(entry)
      const source_relative_path = applicationSourceRelativePath(entry)
      const attempt = await generateApplicationSource({
        job_dir: context.job_dir,
        component_source_path: component_path,
        plan,
        plan_origin: entry.origin,
        source_relative_path,
        signal,
        use_openai: context.use_openai,
        agent_client: services.agent_client,
        debug_dir: join(debug_dir, entry.application_id),
        on_output: (stream, message) => appendJobLog(services.job_store, context.job_id, stream, message),
      })
      agent_attempts += attempt.attempts
      applications.push({
        application_id: entry.application_id,
        source_path: join(context.job_dir, source_relative_path),
      })
    }
    return {
      status: "completed",
      output: { available: true, applications },
      artifacts: await Promise.all(
        applications.map(({ application_id, source_path }) =>
          componentArtifact({
            id: `application_candidate_${application_id}`,
            path: source_path,
            media_type: "text/typescript",
            role: "generated_source",
          }),
        ),
      ),
      metrics: {
        application_available: true,
        application_count: applications.length,
        agent_attempts,
      },
    }
  },
})
