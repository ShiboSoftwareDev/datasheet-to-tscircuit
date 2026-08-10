import { createHash } from "node:crypto"
import { join } from "node:path"
import { runAgentArtifactStage, type AgentArtifactAttempt } from "../../infrastructure/agent"
import {
  createStageWorkspace,
  readBoundedJsonArtifact,
  validatePngArtifact,
  validateStageDirectory,
} from "../../infrastructure/artifacts"
import {
  type ApplicationEvidenceCommitResult,
  writeApplicationEvidenceCommit,
} from "../application-evidence-commit"
import { materializeApplicationEvidenceImages } from "../application-evidence-image-materialization"
import { parseTypicalApplicationPlan, parseUnmaterializedTypicalApplicationPlan } from "../application-plan"
import {
  APPLICATION_CONNECTIVITY_OBSERVER_CONTRACT_SHA256,
  applyApplicationConnectivityObservation,
  type ApplicationConnectivityObservation,
  installApplicationConnectivityObservation,
  observeApplicationConnectivity,
} from "../application-connectivity-verification"
import { assertApplicationEvidenceImageProvenance } from "../evidence-image-provenance"
import { APPLICATION_EVIDENCE_GUIDE, APPLICATION_EVIDENCE_GUIDE_SHA256 } from "../evidence-schema"
import { applicationEvidencePrompt } from "../prompts"
import { appendJobLog, componentArtifact } from "../stage-helpers"
import { APPLICATION_EVIDENCE_STAGE_INSTRUCTIONS } from "../stage-instructions"
import { defineApplicationStage } from "./stage-factory"

type ExtractedApplicationEvidence = {
  application_plan: ReturnType<typeof parseTypicalApplicationPlan>
  connectivity_verification: ReturnType<typeof applyApplicationConnectivityObservation>
}

function observationFingerprint(source_pdf_sha256: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        reviewer_contract_sha256: APPLICATION_CONNECTIVITY_OBSERVER_CONTRACT_SHA256,
        source_pdf_sha256,
      }),
    )
    .digest("hex")
}

export const extractApplicationEvidenceStage = defineApplicationStage({
  id: "extract_application_evidence",
  depends_on: [],
  async execute({ context, services, signal, debug_dir }) {
    const extension = join(import.meta.dir, "../../infrastructure/agent/image-read-extension.ts")
    let observation_cache:
      | { fingerprint: string; observation: ApplicationConnectivityObservation }
      | undefined
    let committed: ApplicationEvidenceCommitResult | undefined
    const attempt: AgentArtifactAttempt<ExtractedApplicationEvidence> =
      await runAgentArtifactStage<ExtractedApplicationEvidence>({
        stage_id: "extract_application_evidence",
        phase_label: "Typical-application evidence extraction",
        max_artifact_attempts: 4,
        signal,
        use_openai: context.use_openai,
        agent_client: services.agent_client,
        extensions: [extension],
        contract_id: "typical-application-plan/v4",
        contract_sha256: APPLICATION_EVIDENCE_GUIDE_SHA256,
        create_workspace: async () => {
          const workspace = await createStageWorkspace({
            prefix: "application-evidence",
            files: [{ source: join(context.job_dir, "datasheet.pdf") }],
          })
          await Promise.all([
            Bun.write(join(workspace.path, "APPLICATION-EVIDENCE-SCHEMA.md"), APPLICATION_EVIDENCE_GUIDE),
            Bun.write(join(workspace.path, "AGENTS.md"), APPLICATION_EVIDENCE_STAGE_INSTRUCTIONS),
          ])
          return workspace
        },
        build_prompt: (feedback) =>
          applicationEvidencePrompt({
            additional_instructions: context.additional_instructions,
            feedback,
          }),
        heartbeat_paths: (workspace) => [
          join(workspace, "typical-application-plan.json"),
          join(workspace, "visual-reference"),
        ],
        rejection_debug: {
          debug_dir,
          files: [
            "typical-application-plan.json",
            "application-connectivity-review.json",
            "application-connectivity-verification.json",
            "application-evidence-image-manifest.json",
          ],
          directories: ["visual-reference"],
        },
        on_output: (stream, message) => appendJobLog(services.job_store, context.job_id, stream, message),
        validate: async (workspace, outer_attempt) => {
          let application_plan = parseUnmaterializedTypicalApplicationPlan(
            await readBoundedJsonArtifact({
              path: join(workspace, "typical-application-plan.json"),
              max_bytes: 4 * 1024 * 1024,
              max_depth: 48,
              max_nodes: 100_000,
            }),
          )
          const materialized = await materializeApplicationEvidenceImages({
            workspace,
            application_plan,
            process_runner: services.process_runner,
            signal,
            on_output: (stream, message) =>
              appendJobLog(services.job_store, context.job_id, stream, message).catch(() => undefined),
          })
          application_plan = parseTypicalApplicationPlan(materialized.application_plan)
          await validateStageDirectory({
            root: join(workspace, "visual-reference"),
            max_files: 64,
            max_total_bytes: 32 * 1024 * 1024,
            validate_file: validatePngArtifact,
          })
          await assertApplicationEvidenceImageProvenance({ workspace, application_plan })
          const fingerprint = observationFingerprint(materialized.manifest.source_pdf_sha256)
          if (observation_cache?.fingerprint !== fingerprint) {
            observation_cache = {
              fingerprint,
              observation: await observeApplicationConnectivity({
                workspace,
                plan: application_plan,
                outer_attempt,
                debug_dir,
                signal,
                use_openai: context.use_openai,
                agent_client: services.agent_client,
                image_extension: extension,
                on_output: (stream, message) =>
                  appendJobLog(services.job_store, context.job_id, stream, message),
              }),
            }
          } else {
            await appendJobLog(
              services.job_store,
              context.job_id,
              "system",
              `Reusing immutable application observation ${fingerprint} for extractor attempt ${outer_attempt}.\n`,
            ).catch(() => undefined)
          }
          const installed = installApplicationConnectivityObservation({
            workspace,
            plan: application_plan,
            observation: observation_cache.observation,
          })
          return {
            application_plan,
            connectivity_verification: applyApplicationConnectivityObservation({
              plan: application_plan,
              observation: installed,
            }),
          }
        },
        promote: async (workspace, value) => {
          await Promise.all([
            Bun.write(
              join(workspace, "typical-application-plan.json"),
              `${JSON.stringify(value.application_plan, null, 2)}\n`,
            ),
            Bun.write(
              join(workspace, "application-connectivity-verification.json"),
              `${JSON.stringify(value.connectivity_verification, null, 2)}\n`,
            ),
          ])
          signal.throwIfAborted()
          committed = await writeApplicationEvidenceCommit({
            source_dir: workspace,
            destination_root: context.job_dir,
            signal,
          })
        },
      })
    if (!committed) throw new Error("Application evidence completed without a committed revision")
    services.job_store.updateJob(context.job_id, {
      typical_application_title:
        attempt.value.application_plan.availability === "documented"
          ? attempt.value.application_plan.title
          : undefined,
    })
    const plan_path = join(committed.evidence_dir, "typical-application-plan.json")
    return {
      status: "completed",
      commit_state: "committed",
      output: {
        evidence_path: plan_path,
        application_available: attempt.value.application_plan.availability === "documented",
        application_title:
          attempt.value.application_plan.availability === "documented"
            ? attempt.value.application_plan.title
            : undefined,
      },
      artifacts: [
        await componentArtifact({
          id: "application_evidence",
          path: plan_path,
          media_type: "application/json",
          role: "evidence",
        }),
        await componentArtifact({
          id: "application_evidence_commit",
          path: committed.commit_path,
          media_type: "application/json",
          role: "commit_manifest",
        }),
        ...(attempt.value.application_plan.availability === "documented"
          ? [
              await componentArtifact({
                id: "typical_application_reference",
                path: join(committed.evidence_dir, "visual-reference", "typical-application.png"),
                media_type: "image/png",
                role: "reference_image",
              }),
            ]
          : []),
      ],
      metrics: {
        application_available: attempt.value.application_plan.availability === "documented",
        agent_attempts: attempt.attempts,
        application_graph_verified: true,
        application_verifier_attempts: attempt.value.connectivity_verification.verifier_attempts ?? 0,
        application_verifier_agent_duration_ms:
          attempt.value.connectivity_verification.verifier_agent_duration_ms ?? 0,
      },
    }
  },
})
