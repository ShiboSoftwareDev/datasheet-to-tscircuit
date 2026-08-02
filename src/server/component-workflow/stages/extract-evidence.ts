import { createHash } from "node:crypto"
import { join } from "node:path"
import {
  canonicalizeComponentEvidenceInput,
  COMPONENT_EVIDENCE_SCHEMA_ID,
  createFootprintPlanFromEvidence,
  getComponentEvidenceBlockingReasons,
  getFootprintEvidenceErrors,
  parseComponentEvidence,
} from "../../component-evidence"
import { createComponentSchematicPlan } from "../../component-schematic-plan"
import { runAgentArtifactStage, type AgentArtifactAttempt } from "../../infrastructure/agent"
import {
  createStageWorkspace,
  readBoundedJsonArtifact,
  validatePngArtifact,
  validateStageDirectory,
} from "../../infrastructure/artifacts"
import { applicationTargetIdentityFromEvidence, parseTypicalApplicationPlan } from "../application-plan"
import {
  APPLICATION_CONNECTIVITY_OBSERVER_CONTRACT_SHA256,
  applyApplicationConnectivityObservation,
  type ApplicationConnectivityObservation,
  installApplicationConnectivityObservation,
  observeApplicationConnectivity,
  verifyApplicationConnectivity,
} from "../application-connectivity-verification"
import { hasCommittedEvidence, writeEvidenceCommit } from "../evidence-commit"
import {
  assertEvidenceImageManifest,
  type EvidenceImageManifest,
  materializeEvidenceImages,
} from "../evidence-image-materialization"
import { assertEvidenceImageProvenance } from "../evidence-image-provenance"
import { COMPONENT_EVIDENCE_GUIDE, COMPONENT_EVIDENCE_GUIDE_SHA256 } from "../evidence-schema"
import {
  FOOTPRINT_GEOMETRY_OBSERVER_CONTRACT_SHA256,
  applyFootprintGeometryObservation,
  type FootprintGeometryObservation,
  observeFootprintGeometry,
  verifyFootprintGeometry,
} from "../footprint-geometry-verification"
import { evidencePrompt } from "../prompts"
import { appendJobLog, componentArtifact, updateJobValidation } from "../stage-helpers"
import { EVIDENCE_STAGE_INSTRUCTIONS } from "../stage-instructions"
import { defineComponentStage } from "./stage-factory"

type ExtractedEvidence = {
  component_evidence: ReturnType<typeof parseComponentEvidence>
  footprint_plan: ReturnType<typeof createFootprintPlanFromEvidence>
  application_plan: ReturnType<typeof parseTypicalApplicationPlan>
  footprint_verification: Awaited<ReturnType<typeof verifyFootprintGeometry>>
  connectivity_verification: Awaited<ReturnType<typeof verifyApplicationConnectivity>>
  canonicalization_count: number
}

function observationFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function footprintObservationFingerprint(input: { manifest: EvidenceImageManifest }): string {
  return observationFingerprint({
    reviewer_contract_sha256: FOOTPRINT_GEOMETRY_OBSERVER_CONTRACT_SHA256,
    source_pdf_sha256: input.manifest.source_pdf_sha256,
    land_pattern: input.manifest.aliases.land_pattern,
  })
}

function applicationObservationFingerprint(input: { manifest: EvidenceImageManifest }): string {
  // The application observer sees only the immutable PDF and its own contract.
  // Extractor page, crop, pin, inventory, and topology claims are deliberately
  // absent from both the reviewer workspace and this cache identity.
  return observationFingerprint({
    reviewer_contract_sha256: APPLICATION_CONNECTIVITY_OBSERVER_CONTRACT_SHA256,
    source_pdf_sha256: input.manifest.source_pdf_sha256,
  })
}

export const extractEvidenceStage = defineComponentStage({
  id: "extract_evidence",
  depends_on: ["prepare"],
  async execute({ context, services, signal, debug_dir }) {
    const extension = join(import.meta.dir, "../../infrastructure/agent/image-read-extension.ts")
    let attempt: AgentArtifactAttempt<ExtractedEvidence>
    let committed_evidence_dir: string | undefined
    let footprint_observation_cache:
      | { fingerprint: string; observation: FootprintGeometryObservation }
      | undefined
    let application_observation_cache:
      | { fingerprint: string; observation: ApplicationConnectivityObservation }
      | undefined
    try {
      await Bun.write(join(context.job_dir, "EVIDENCE-SCHEMA.md"), COMPONENT_EVIDENCE_GUIDE)
      attempt = await runAgentArtifactStage<ExtractedEvidence>({
        stage_id: "extract_evidence",
        phase_label: "Datasheet evidence extraction",
        max_artifact_attempts: 4,
        signal,
        use_openai: context.use_openai,
        agent_client: services.agent_client,
        extensions: [extension],
        contract_id: COMPONENT_EVIDENCE_SCHEMA_ID,
        contract_sha256: COMPONENT_EVIDENCE_GUIDE_SHA256,
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
          files: [
            "component-evidence.json",
            "typical-application-plan.json",
            "footprint-geometry-review.json",
            "footprint-geometry-verification.json",
            "application-connectivity-review.json",
            "evidence-image-manifest.json",
          ],
          directories: ["visual-reference"],
        },
        validate: async (workspace, outer_attempt) => {
          const [raw_component_evidence, raw_application_plan] = await Promise.all([
            readBoundedJsonArtifact({
              path: join(workspace, "component-evidence.json"),
              max_bytes: 4 * 1024 * 1024,
              max_depth: 48,
              max_nodes: 100_000,
            }),
            readBoundedJsonArtifact({
              path: join(workspace, "typical-application-plan.json"),
              max_bytes: 4 * 1024 * 1024,
              max_depth: 48,
              max_nodes: 100_000,
            }),
          ])
          const canonicalization = canonicalizeComponentEvidenceInput(raw_component_evidence)
          const contract_errors: Error[] = []
          let component_evidence: ReturnType<typeof parseComponentEvidence> | undefined
          let application_plan: ReturnType<typeof parseTypicalApplicationPlan> | undefined
          try {
            component_evidence = parseComponentEvidence(canonicalization.value)
          } catch (error) {
            contract_errors.push(
              new Error(`component-evidence.json: ${error instanceof Error ? error.message : String(error)}`),
            )
          }
          try {
            application_plan = parseTypicalApplicationPlan(
              raw_application_plan,
              component_evidence ? applicationTargetIdentityFromEvidence(component_evidence) : undefined,
            )
          } catch (error) {
            contract_errors.push(
              new Error(
                `typical-application-plan.json: ${error instanceof Error ? error.message : String(error)}`,
              ),
            )
          }
          if (contract_errors.length > 0) {
            throw new AggregateError(contract_errors, "Evidence artifact contract validation failed")
          }
          if (!component_evidence || !application_plan) {
            throw new Error("Evidence artifact validation returned no canonical value")
          }
          const materialized = await materializeEvidenceImages({
            workspace,
            component_evidence,
            application_plan,
            process_runner: services.process_runner,
            signal,
            on_output: (stream, message) =>
              appendJobLog(services.job_store, context.job_id, stream, message).catch(() => undefined),
          })
          component_evidence = materialized.component_evidence
          application_plan = materialized.application_plan
          const footprint_plan = createFootprintPlanFromEvidence(component_evidence)
          const blocking = [
            ...getComponentEvidenceBlockingReasons(component_evidence),
            ...getFootprintEvidenceErrors(component_evidence, footprint_plan),
          ]
          if (blocking.length > 0) throw new AggregateError(blocking, "Evidence is unresolved")
          await validateStageDirectory({
            root: join(workspace, "visual-reference"),
            max_files: 64,
            max_total_bytes: 32 * 1024 * 1024,
            validate_file: validatePngArtifact,
          })
          await assertEvidenceImageManifest({
            root: workspace,
            manifest: materialized.manifest,
            application_available: application_plan.availability === "documented",
          })
          await assertEvidenceImageProvenance({ workspace, component_evidence, application_plan })
          const footprint_fingerprint = footprintObservationFingerprint({
            manifest: materialized.manifest,
          })
          if (footprint_observation_cache?.fingerprint !== footprint_fingerprint) {
            footprint_observation_cache = {
              fingerprint: footprint_fingerprint,
              observation: await observeFootprintGeometry({
                workspace,
                evidence: component_evidence,
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
              `Reusing immutable footprint observation ${footprint_fingerprint} for extractor attempt ${outer_attempt}.\n`,
            ).catch(() => undefined)
          }
          const application_fingerprint = applicationObservationFingerprint({
            manifest: materialized.manifest,
          })
          if (application_observation_cache?.fingerprint !== application_fingerprint) {
            application_observation_cache = {
              fingerprint: application_fingerprint,
              observation: await observeApplicationConnectivity({
                workspace,
                plan: application_plan,
                evidence: component_evidence,
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
              `Reusing immutable application observation ${application_fingerprint} for extractor attempt ${outer_attempt}.\n`,
            ).catch(() => undefined)
          }
          signal.throwIfAborted()
          const installed_application_observation = installApplicationConnectivityObservation({
            workspace,
            plan: application_plan,
            observation: application_observation_cache.observation,
          })

          let footprint_verification: Awaited<ReturnType<typeof verifyFootprintGeometry>> | undefined
          let connectivity_verification: Awaited<ReturnType<typeof verifyApplicationConnectivity>> | undefined
          const verification_errors: Error[] = []
          try {
            footprint_verification = applyFootprintGeometryObservation({
              workspace,
              evidence: component_evidence,
              observation: footprint_observation_cache.observation,
            })
          } catch (error) {
            verification_errors.push(error instanceof Error ? error : new Error(String(error)))
          }
          try {
            connectivity_verification = applyApplicationConnectivityObservation({
              plan: application_plan,
              evidence: component_evidence,
              observation: installed_application_observation,
            })
          } catch (error) {
            verification_errors.push(error instanceof Error ? error : new Error(String(error)))
          }
          if (verification_errors.length > 0) {
            throw new AggregateError(
              verification_errors,
              "Independent footprint/application verification failed",
            )
          }
          if (!footprint_verification || !connectivity_verification) {
            throw new Error("Independent verification returned no agreement records")
          }
          if (canonicalization.changes.length > 0) {
            await appendJobLog(
              services.job_store,
              context.job_id,
              "system",
              `Canonicalized representation-safe evidence fields: ${canonicalization.changes.join("; ")}.\n`,
            ).catch(() => undefined)
          }
          return {
            component_evidence,
            footprint_plan,
            application_plan,
            footprint_verification,
            connectivity_verification,
            canonicalization_count: canonicalization.changes.length,
          }
        },
        promote: async (workspace, evidence) => {
          const workspace_writes = await Promise.allSettled([
            Bun.write(
              join(workspace, "component-evidence.json"),
              `${JSON.stringify(evidence.component_evidence, null, 2)}\n`,
            ),
            Bun.write(
              join(workspace, "footprint-plan.json"),
              `${JSON.stringify(evidence.footprint_plan, null, 2)}\n`,
            ),
            Bun.write(
              join(workspace, "component-schematic-plan.json"),
              `${JSON.stringify(createComponentSchematicPlan(evidence.component_evidence), null, 2)}\n`,
            ),
            Bun.write(
              join(workspace, "typical-application-plan.json"),
              `${JSON.stringify(evidence.application_plan, null, 2)}\n`,
            ),
            Bun.write(
              join(workspace, "footprint-geometry-verification.json"),
              `${JSON.stringify(evidence.footprint_verification, null, 2)}\n`,
            ),
            Bun.write(
              join(workspace, "application-connectivity-verification.json"),
              `${JSON.stringify(evidence.connectivity_verification, null, 2)}\n`,
            ),
          ])
          signal.throwIfAborted()
          const workspace_write_failures = workspace_writes.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          )
          if (workspace_write_failures.length > 0) {
            throw new AggregateError(
              workspace_write_failures,
              "Evidence workspace publication did not complete",
            )
          }
          // The complete candidate is copied into a unique immutable revision.
          // Only the final evidence-commit.json rename can change what readers see.
          const committed = await writeEvidenceCommit(workspace, {
            signal,
            destination_root: context.job_dir,
          })
          committed_evidence_dir = committed.evidence_dir
          if (committed.durability_warning) {
            await appendJobLog(
              services.job_store,
              context.job_id,
              "system",
              `${committed.durability_warning}\n`,
            ).catch(() => undefined)
          }
        },
      })
    } catch (error) {
      const evidence_available = await hasCommittedEvidence(context.job_dir)
      if (!evidence_available) {
        services.job_store.updateJob(context.job_id, {
          evidence_available: false,
          typical_application_title: undefined,
        })
      }
      if (!signal.aborted) updateJobValidation(services.job_store, context.job_id, { evidence: "failed" })
      throw error
    }
    updateJobValidation(services.job_store, context.job_id, { evidence: "passed" })
    services.job_store.updateJob(context.job_id, {
      evidence_available: true,
      typical_application_title:
        attempt.value.application_plan.availability === "documented"
          ? attempt.value.application_plan.title
          : undefined,
    })
    if (!committed_evidence_dir) {
      throw new Error("Evidence stage completed without an immutable committed revision")
    }
    const evidence_path = join(committed_evidence_dir, "component-evidence.json")
    return {
      status: "completed",
      commit_state: "committed",
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
          path: join(committed_evidence_dir, "visual-reference", "land-pattern.png"),
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
        canonicalized_fields: attempt.value.canonicalization_count,
        footprint_geometry_verified: attempt.value.footprint_verification.status === "verified",
        footprint_verifier_attempts: attempt.value.footprint_verification.verifier_attempts ?? 0,
        footprint_verifier_agent_duration_ms:
          attempt.value.footprint_verification.verifier_agent_duration_ms ?? 0,
        application_graph_verified: attempt.value.connectivity_verification.status === "verified",
        application_verifier_attempts: attempt.value.connectivity_verification.verifier_attempts ?? 0,
        application_verifier_agent_duration_ms:
          attempt.value.connectivity_verification.verifier_agent_duration_ms ?? 0,
      },
    }
  },
})
