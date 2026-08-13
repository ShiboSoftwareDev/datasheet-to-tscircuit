import { createHash } from "node:crypto"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import {
  COMPONENT_EVIDENCE_SCHEMA_ID,
  createFootprintPlanFromEvidence,
  getComponentEvidenceBlockingReasons,
  getFootprintEvidenceErrors,
  parseComponentFootprintCatalog,
  parseComponentEvidence,
} from "../../component-evidence"
import { createComponentSchematicPlan } from "../../component-schematic-plan"
import { runAgentArtifactStage, type AgentArtifactAttempt } from "../../infrastructure/agent"
import {
  createStageWorkspace,
  validatePngArtifact,
  validateStageDirectory,
} from "../../infrastructure/artifacts"
import { hasCommittedEvidence, writeEvidenceCommit } from "../evidence-commit"
import { readExtractedFootprintCatalog } from "../extracted-footprint-catalog"
import {
  assertEvidenceImageManifest,
  type EvidenceImageManifest,
  materializeComponentFootprintCatalogImages,
} from "../evidence-image-materialization"
import { assertComponentEvidenceImageProvenance } from "../evidence-image-provenance"
import { COMPONENT_EVIDENCE_GUIDE, COMPONENT_EVIDENCE_GUIDE_SHA256 } from "../evidence-schema"
import {
  FOOTPRINT_GEOMETRY_OBSERVER_CONTRACT_SHA256,
  applyFootprintGeometryObservation,
  componentEvidenceWithVerifiedFootprintGeometry,
  createFootprintGeometryVerificationEntry,
  type FootprintGeometryObservation,
  type FootprintGeometryVerificationCatalog,
  observeFootprintGeometry,
  verifyFootprintGeometry,
} from "../footprint-geometry-verification"
import { evidencePrompt } from "../prompts"
import { collectJobProvenance } from "../provenance"
import {
  discoverFootprintLandPatterns,
  getMissingLandPatternHints,
} from "../footprint-land-pattern-inventory"
import {
  appendJobLog,
  componentFootprintPreviewsFromCatalog,
  componentArtifact,
  INITIAL_JOB_VALIDATION,
  updateJobValidation,
  writeJson,
} from "../stage-helpers"
import { EVIDENCE_STAGE_INSTRUCTIONS } from "../stage-instructions"
import { defineComponentStage } from "./stage-factory"

type ExtractedEvidence = {
  component_evidence: ReturnType<typeof parseComponentEvidence>
  component_footprint_catalog: ReturnType<typeof parseComponentFootprintCatalog>
  footprint_plan: ReturnType<typeof createFootprintPlanFromEvidence>
  footprint_verification: Awaited<ReturnType<typeof verifyFootprintGeometry>>
  footprint_verification_catalog: FootprintGeometryVerificationCatalog
  canonicalization_count: number
}

function observationFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function footprintObservationFingerprint(input: {
  manifest: EvidenceImageManifest
  evidence: ReturnType<typeof parseComponentEvidence>
  footprint_id: string
}): string {
  const visual_source = [
    ...input.evidence.footprint.drawing_orientation.sources,
    ...input.evidence.footprint.pads.flatMap(({ sources }) => sources),
  ].find(
    (source) =>
      source.method === "pdf_visual" &&
      source.render_dpi === input.manifest.render_dpi &&
      typeof source.image === "string",
  )
  if (!visual_source) throw new Error("Footprint evidence has no rendered pdf_visual geometry source")
  const rendered_page = input.manifest.pages.find(({ page }) => page === visual_source.page)
  if (!rendered_page) {
    throw new Error(`Footprint geometry PDF page ${visual_source.page} was not rendered`)
  }
  return observationFingerprint({
    reviewer_contract_sha256: FOOTPRINT_GEOMETRY_OBSERVER_CONTRACT_SHA256,
    source_pdf_sha256: input.manifest.source_pdf_sha256,
    footprint_id: input.footprint_id,
    source_page: rendered_page,
  })
}

export const extractEvidenceStage = defineComponentStage({
  id: "extract_evidence",
  depends_on: [],
  async execute({ context, services, signal, debug_dir }) {
    const provenance = await collectJobProvenance({
      job_dir: context.job_dir,
      additional_instructions: context.additional_instructions,
    })
    const provenance_path = join(context.job_dir, "provenance.json")
    await writeJson(provenance_path, provenance)
    services.job_store.updateJob(context.job_id, {
      display_status: "agent_running",
      validation: INITIAL_JOB_VALIDATION,
      provenance,
      is_complete: false,
      has_errors: false,
      error_message: undefined,
    })
    await appendJobLog(
      services.job_store,
      context.job_id,
      "system",
      `Starting evidence extraction for job ${context.job_id}, invocation ${context.invocation_id}, ` +
        `source ${provenance.source_commit}, workflow ${provenance.workflow_source_sha256}, ` +
        `evidence contract ${provenance.evidence_contract_sha256}.\n`,
    )
    const footprint_hints = await discoverFootprintLandPatterns({
      datasheet_path: join(context.job_dir, "datasheet.pdf"),
      debug_dir: join(debug_dir, "land-pattern-inventory"),
      process_runner: services.process_runner,
      signal,
      on_output: (stream, message) =>
        appendJobLog(services.job_store, context.job_id, stream, message).catch(() => undefined),
    })
    if (footprint_hints.length > 0) {
      await appendJobLog(
        services.job_store,
        context.job_id,
        "system",
        `Server inventory found ${footprint_hints.length} coded PCB land-pattern package(s): ${footprint_hints.map(({ package_code }) => package_code).join(", ")}.\n`,
      )
    }
    const extension = join(import.meta.dir, "../../infrastructure/agent/image-read-extension.ts")
    let attempt: AgentArtifactAttempt<ExtractedEvidence>
    let committed_evidence_dir: string | undefined
    const footprint_observation_cache: Array<{
      fingerprint: string
      observation: FootprintGeometryObservation
    }> = []
    try {
      await Bun.write(join(context.job_dir, "EVIDENCE-SCHEMA.md"), COMPONENT_EVIDENCE_GUIDE)
      attempt = await runAgentArtifactStage<ExtractedEvidence>({
        stage_id: "extract_evidence",
        phase_label: "Datasheet evidence extraction",
        max_artifact_attempts: footprint_hints.length > 1 ? 6 : 4,
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
          evidencePrompt({
            additional_instructions: context.additional_instructions,
            footprint_hints,
            feedback,
          }),
        heartbeat_paths: (workspace) => [
          join(workspace, "component-footprint-catalog.json"),
          join(workspace, "component-footprints"),
          join(workspace, "visual-reference"),
        ],
        on_output: (stream, message) => appendJobLog(services.job_store, context.job_id, stream, message),
        rejection_debug: {
          debug_dir,
          files: [
            "component-footprint-catalog.json",
            "footprint-geometry-review.json",
            "footprint-geometry-verification.json",
            "evidence-image-manifest.json",
          ],
          directories: ["component-footprints", "visual-reference"],
        },
        validate: async (workspace, outer_attempt) => {
          const extracted_catalog = await readExtractedFootprintCatalog(workspace)
          const component_footprint_catalog = extracted_catalog.component_footprint_catalog
          const canonicalization_count = extracted_catalog.canonicalization_count
          const missing_land_patterns = getMissingLandPatternHints({
            catalog: component_footprint_catalog,
            hints: footprint_hints,
          })
          if (missing_land_patterns.length > 0) {
            throw new Error(
              `Catalog omits server-discovered PCB land-pattern packages: ${missing_land_patterns
                .map(
                  ({ package_code, page, pin_count }) =>
                    `${package_code} (PDF page ${page}, ${pin_count} pins)`,
                )
                .join(", ")}`,
            )
          }
          const materialized = await materializeComponentFootprintCatalogImages({
            workspace,
            component_footprint_catalog,
            process_runner: services.process_runner,
            signal,
            on_output: (stream, message) =>
              appendJobLog(services.job_store, context.job_id, stream, message).catch(() => undefined),
          })
          const materialized_catalog = materialized.component_footprint_catalog
          const blocking = materialized_catalog.footprints.flatMap((footprint) => {
            const variant_plan = createFootprintPlanFromEvidence(footprint.component_evidence)
            return [
              ...getComponentEvidenceBlockingReasons(footprint.component_evidence),
              ...getFootprintEvidenceErrors(footprint.component_evidence, variant_plan),
            ].map((reason) => `${footprint.footprint_id}: ${reason}`)
          })
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
            application_available: false,
          })
          await Promise.all(
            materialized_catalog.footprints.map((footprint) =>
              assertComponentEvidenceImageProvenance({
                workspace,
                component_evidence: footprint.component_evidence,
              }),
            ),
          )
          const reconciled_footprints = []
          const observations: Array<{
            footprint_id: string
            observation: FootprintGeometryObservation
          }> = []
          for (const footprint of materialized_catalog.footprints) {
            signal.throwIfAborted()
            const footprint_fingerprint = footprintObservationFingerprint({
              manifest: materialized.manifest,
              evidence: footprint.component_evidence,
              footprint_id: footprint.footprint_id,
            })
            const cached = footprint_observation_cache.find(
              ({ fingerprint }) => fingerprint === footprint_fingerprint,
            )
            const observation = cached
              ? cached.observation
              : await observeFootprintGeometry({
                  workspace,
                  evidence: footprint.component_evidence,
                  outer_attempt,
                  debug_dir: join(debug_dir, footprint.footprint_id),
                  signal,
                  use_openai: context.use_openai,
                  agent_client: services.agent_client,
                  image_extension: extension,
                  subject: `${footprint.label} (${footprint.footprint_id})`,
                  on_output: (stream, message) =>
                    appendJobLog(services.job_store, context.job_id, stream, message),
                })
            if (!cached) {
              footprint_observation_cache.push({
                fingerprint: footprint_fingerprint,
                observation,
              })
            } else {
              await appendJobLog(
                services.job_store,
                context.job_id,
                "system",
                `Reusing immutable footprint observation ${footprint_fingerprint} for ${footprint.footprint_id} on extractor attempt ${outer_attempt}.\n`,
              ).catch(() => undefined)
            }
            observations.push({ footprint_id: footprint.footprint_id, observation })
            reconciled_footprints.push({
              ...footprint,
              component_evidence: componentEvidenceWithVerifiedFootprintGeometry({
                evidence: footprint.component_evidence,
                observation,
              }),
            })
          }
          const canonical_catalog = parseComponentFootprintCatalog({
            ...materialized_catalog,
            footprints: reconciled_footprints,
          })
          const component_evidence = canonical_catalog.footprints.find(
            ({ footprint_id }) => footprint_id === canonical_catalog.default_footprint_id,
          )?.component_evidence
          if (!component_evidence) throw new Error("Default footprint evidence is unavailable")
          const footprint_plan = createFootprintPlanFromEvidence(component_evidence)
          const verification_entries = canonical_catalog.footprints.map((footprint) => {
            const observation = observations.find(
              (candidate) => candidate.footprint_id === footprint.footprint_id,
            )?.observation
            if (!observation) {
              throw new Error(`No independent geometry observation for ${footprint.footprint_id}`)
            }
            return createFootprintGeometryVerificationEntry({
              footprint_id: footprint.footprint_id,
              evidence: footprint.component_evidence,
              observation,
            })
          })
          const footprint_verification_catalog: FootprintGeometryVerificationCatalog = {
            version: 1,
            footprints: verification_entries,
          }
          const default_verification = footprint_verification_catalog.footprints.find(
            ({ footprint_id }) => footprint_id === canonical_catalog.default_footprint_id,
          )
          if (!default_verification) throw new Error("Default footprint has no independent verification")
          const footprint_verification = applyFootprintGeometryObservation({
            workspace,
            evidence: component_evidence,
            observation: {
              review: default_verification.review,
              verifier_attempts: default_verification.verification.verifier_attempts ?? 0,
              verifier_agent_duration_ms: default_verification.verification.verifier_agent_duration_ms ?? 0,
            },
          })
          if (canonicalization_count > 0) {
            await appendJobLog(
              services.job_store,
              context.job_id,
              "system",
              `Canonicalized ${canonicalization_count} representation-safe evidence field(s).\n`,
            ).catch(() => undefined)
          }
          return {
            component_evidence,
            component_footprint_catalog: canonical_catalog,
            footprint_plan,
            footprint_verification,
            footprint_verification_catalog,
            canonicalization_count,
          }
        },
        promote: async (workspace, evidence) => {
          await rm(join(workspace, "component-footprints"), { recursive: true, force: true })
          await Promise.all(
            [
              "typical-application-plan.json",
              "application-connectivity-review.json",
              "application-connectivity-verification.json",
              "application-evidence-image-manifest.json",
            ].map((file) => rm(join(workspace, file), { force: true })),
          )
          const workspace_writes = await Promise.allSettled([
            Bun.write(
              join(workspace, "component-evidence.json"),
              `${JSON.stringify(evidence.component_evidence, null, 2)}\n`,
            ),
            Bun.write(
              join(workspace, "component-footprint-catalog.json"),
              `${JSON.stringify(evidence.component_footprint_catalog, null, 2)}\n`,
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
              join(workspace, "footprint-geometry-verification.json"),
              `${JSON.stringify(evidence.footprint_verification, null, 2)}\n`,
            ),
            Bun.write(
              join(workspace, "footprint-geometry-verification-catalog.json"),
              `${JSON.stringify(evidence.footprint_verification_catalog, null, 2)}\n`,
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
      component_footprints: componentFootprintPreviewsFromCatalog(attempt.value.component_footprint_catalog),
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
        footprint_count: attempt.value.component_footprint_catalog.footprints.length,
      },
      artifacts: [
        await componentArtifact({
          id: "datasheet",
          path: join(context.job_dir, "datasheet.pdf"),
          media_type: "application/pdf",
          role: "source",
        }),
        await componentArtifact({
          id: "component_provenance",
          path: provenance_path,
          media_type: "application/json",
          role: "provenance",
        }),
        await componentArtifact({
          id: "component_evidence",
          path: evidence_path,
          media_type: "application/json",
          role: "evidence",
        }),
        await componentArtifact({
          id: "component_footprint_catalog",
          path: join(committed_evidence_dir, "component-footprint-catalog.json"),
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
        footprint_count: attempt.value.component_footprint_catalog.footprints.length,
        canonicalized_fields: attempt.value.canonicalization_count,
        footprint_geometry_verified: attempt.value.footprint_verification.status === "verified",
        footprint_verifier_attempts: attempt.value.footprint_verification.verifier_attempts ?? 0,
        footprint_verifier_agent_duration_ms:
          attempt.value.footprint_verification.verifier_agent_duration_ms ?? 0,
      },
    }
  },
})
