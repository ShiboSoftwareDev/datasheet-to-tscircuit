import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { validateApplication } from "../component-validation"
import { generateApplicationSource } from "../source-candidates"
import {
  appendJobLog,
  componentArtifact,
  type CircuitValidationRecord,
  readApprovedEvidence,
  readJson,
} from "../stage-helpers"
import { defineComponentStage } from "./stage-factory"

export const repairApplicationStage = defineComponentStage({
  id: "repair_application",
  depends_on: ["validate_application"],
  async execute({ context, services, dependency_outputs, signal, debug_dir }) {
    let result = (await readJson(
      dependency_outputs.validate_application.result_path,
    )) as CircuitValidationRecord
    if (result.passed) {
      return {
        status: "completed",
        output: {
          result_path: dependency_outputs.validate_application.result_path,
          passed: true,
          repair_attempts: 0,
          errors: [],
        },
        metrics: { repair_attempts: 0 },
      }
    }
    const { application_plan } = await readApprovedEvidence(context.job_dir)
    const max_repairs = 2
    for (let repair_attempt = 1; repair_attempt <= max_repairs; repair_attempt += 1) {
      await generateApplicationSource({
        job_dir: context.job_dir,
        plan: application_plan,
        signal,
        use_openai: context.use_openai,
        agent_client: services.agent_client,
        debug_dir: join(debug_dir, `candidate-${repair_attempt}`),
        feedback: result.errors.join("\n"),
        on_output: (stream, message) => appendJobLog(services.job_store, context.job_id, stream, message),
      })
      result = await validateApplication({
        job_id: context.job_id,
        job_dir: context.job_dir,
        job_store: services.job_store,
        tsci_bin: services.tsci_bin,
        process_runner: services.process_runner,
        signal,
        on_output: (stream, message) => appendJobLog(services.job_store, context.job_id, stream, message),
      })
      if (!result.passed) continue
      const result_path = join(context.job_dir, "application-validation.json")
      return {
        status: "completed",
        output: {
          result_path,
          passed: true,
          repair_attempts: repair_attempt,
          errors: [],
        },
        artifacts: [
          await componentArtifact({
            id: "validated_application",
            path: join(context.job_dir, "typical-application.circuit.tsx"),
            media_type: "text/typescript",
            role: "validated_application",
          }),
        ],
        metrics: { repair_attempts: repair_attempt },
      }
    }
    await appendJobLog(
      services.job_store,
      context.job_id,
      "system",
      `Typical application remained invalid after ${max_repairs} repairs; the validated component will still be published.\n`,
    )
    const rejected_source_path = join(context.job_dir, "typical-application.circuit.tsx")
    const rejected_source = await readFile(rejected_source_path).catch(() => undefined)
    if (rejected_source) {
      await Bun.write(join(debug_dir, "rejected-application.circuit.tsx"), rejected_source)
    }
    await Promise.all([
      rm(rejected_source_path, { force: true }),
      rm(join(context.job_dir, "dist", "typical-application"), {
        recursive: true,
        force: true,
      }),
    ])
    return {
      status: "completed",
      output: {
        result_path: join(context.job_dir, "application-validation.json"),
        passed: false,
        repair_attempts: max_repairs,
        errors: result.errors,
      },
      diagnostics: [
        {
          code: "application_validation_failed",
          severity: "warning",
          message: result.errors.join("; "),
          stage_id: "repair_application",
          operation: "repair_application",
          entity_refs: [],
          artifact_refs: [{ path: join(context.job_dir, "application-validation.json") }],
          cause_chain: [],
          retryable: false,
        },
      ],
      metrics: { repair_attempts: max_repairs },
    }
  },
})
