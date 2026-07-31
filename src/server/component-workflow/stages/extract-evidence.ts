import { join } from "node:path"
import {
  createFootprintPlanFromEvidence,
  getComponentEvidenceBlockingReasons,
  getFootprintEvidenceErrors,
  parseComponentEvidence,
} from "../../component-evidence"
import { createComponentSchematicPlan } from "../../component-schematic-plan"
import { runAgentArtifactStage } from "../../infrastructure/agent"
import {
  createStageWorkspace,
  promoteStageDirectory,
  validatePngArtifact,
  validateStageDirectory,
} from "../../infrastructure/artifacts"
import { parseTypicalApplicationPlan } from "../application-plan"
import { clearEvidenceCommit, writeEvidenceCommit } from "../evidence-commit"
import { COMPONENT_EVIDENCE_GUIDE } from "../evidence-schema"
import { evidencePrompt } from "../prompts"
import { appendJobLog, componentArtifact, readJson, updateJobValidation, writeJson } from "../stage-helpers"
import { EVIDENCE_STAGE_INSTRUCTIONS } from "../stage-instructions"
import { defineComponentStage } from "./stage-factory"

export const extractEvidenceStage = defineComponentStage({
  id: "extract_evidence",
  depends_on: ["prepare"],
  async execute({ context, services, signal, debug_dir }) {
    await clearEvidenceCommit(context.job_dir)
    await Bun.write(join(context.job_dir, "EVIDENCE-SCHEMA.md"), COMPONENT_EVIDENCE_GUIDE)
    const extension = join(import.meta.dir, "../../infrastructure/agent/image-read-extension.ts")
    const attempt = await runAgentArtifactStage({
      stage_id: "extract_evidence",
      phase_label: "Datasheet evidence extraction",
      max_artifact_attempts: 3,
      signal,
      use_openai: context.use_openai,
      agent_client: services.agent_client,
      extensions: [extension],
      create_workspace: async () => {
        const workspace = await createStageWorkspace({
          prefix: "component-evidence",
          files: [
            { source: join(context.job_dir, "EVIDENCE-SCHEMA.md") },
            { source: join(context.job_dir, "datasheet.pdf") },
          ],
        })
        await Bun.write(join(workspace.path, "AGENTS.md"), EVIDENCE_STAGE_INSTRUCTIONS)
        return workspace
      },
      build_prompt: (feedback) =>
        evidencePrompt({ additional_instructions: context.additional_instructions, feedback }),
      heartbeat_paths: (workspace) => [
        join(workspace, "component-evidence.json"),
        join(workspace, "typical-application-plan.json"),
        join(workspace, "visual-reference"),
      ],
      on_output: (stream, message) => appendJobLog(services.job_store, context.job_id, stream, message),
      rejection_debug: {
        debug_dir,
        files: ["component-evidence.json", "typical-application-plan.json"],
        directories: ["visual-reference"],
      },
      validate: async (workspace) => {
        const component_evidence = parseComponentEvidence(
          await readJson(join(workspace, "component-evidence.json")),
        )
        const footprint_plan = createFootprintPlanFromEvidence(component_evidence)
        const application_plan = parseTypicalApplicationPlan(
          await readJson(join(workspace, "typical-application-plan.json")),
          component_evidence.part_number.value,
        )
        const blocking = [
          ...getComponentEvidenceBlockingReasons(component_evidence),
          ...getFootprintEvidenceErrors(component_evidence, footprint_plan),
        ]
        if (blocking.length > 0) throw new AggregateError(blocking, "Evidence is unresolved")
        for (const required_image of [
          "visual-reference/land-pattern.png",
          ...(application_plan.availability === "documented"
            ? ["visual-reference/typical-application.png"]
            : []),
        ]) {
          if (!(await Bun.file(join(workspace, required_image)).exists())) {
            throw new Error(`Evidence extraction did not produce ${required_image}`)
          }
        }
        await validateStageDirectory({
          root: join(workspace, "visual-reference"),
          max_files: 64,
          max_total_bytes: 32 * 1024 * 1024,
          validate_file: validatePngArtifact,
        })
        return { component_evidence, footprint_plan, application_plan }
      },
      promote: async (workspace, evidence) => {
        await Promise.all([
          writeJson(join(context.job_dir, "component-evidence.json"), evidence.component_evidence),
          writeJson(join(context.job_dir, "footprint-plan.json"), evidence.footprint_plan),
          writeJson(
            join(context.job_dir, "component-schematic-plan.json"),
            createComponentSchematicPlan(evidence.component_evidence),
          ),
          writeJson(join(context.job_dir, "typical-application-plan.json"), evidence.application_plan),
          promoteStageDirectory({
            workspace,
            source: "visual-reference",
            destination_root: context.job_dir,
            max_files: 64,
            max_total_bytes: 32 * 1024 * 1024,
            validate_file: validatePngArtifact,
            signal,
          }),
        ])
        await writeEvidenceCommit(context.job_dir)
      },
    })
    updateJobValidation(services.job_store, context.job_id, { evidence: "passed" })
    services.job_store.updateJob(context.job_id, {
      evidence_available: true,
      typical_application_title:
        attempt.value.application_plan.availability === "documented"
          ? attempt.value.application_plan.title
          : undefined,
    })
    const evidence_path = join(context.job_dir, "component-evidence.json")
    return {
      status: "completed",
      output: {
        evidence_path,
        part_number: attempt.value.component_evidence.part_number.value,
        pin_count: attempt.value.component_evidence.pinout.pins.length,
        application_available: attempt.value.application_plan.availability === "documented",
      },
      artifacts: [
        await componentArtifact({
          id: "component_evidence",
          path: evidence_path,
          media_type: "application/json",
          role: "evidence",
        }),
        await componentArtifact({
          id: "land_pattern_reference",
          path: join(context.job_dir, "visual-reference", "land-pattern.png"),
          media_type: "image/png",
          role: "reference_image",
        }),
        await componentArtifact({
          id: "evidence_commit",
          path: join(context.job_dir, "evidence-commit.json"),
          media_type: "application/json",
          role: "commit_manifest",
        }),
      ],
      metrics: {
        agent_attempts: attempt.attempts,
        pin_count: attempt.value.component_evidence.pinout.pins.length,
      },
    }
  },
})
