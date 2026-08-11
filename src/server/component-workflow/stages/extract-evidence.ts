import { createHash } from "node:crypto"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import {
  canonicalizeComponentEvidenceInput,
  COMPONENT_EVIDENCE_SCHEMA_ID,
  createSingleFootprintCatalog,
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
  readBoundedJsonArtifact,
  validatePngArtifact,
  validateStageDirectory,
} from "../../infrastructure/artifacts"
import { hasCommittedEvidence, writeEvidenceCommit } from "../evidence-commit"
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
  type FootprintGeometryObservation,
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

function extractedFootprintGeometryFingerprint(evidence: ReturnType<typeof parseComponentEvidence>): string {
  return observationFingerprint(
    evidence.footprint.pads.map(({ pin, kind, x, y, width, height, hole_width, hole_height }) => ({
      pin,
      kind,
      x,
      y,
      width,
      height,
      hole_width: hole_width ?? null,
      hole_height: hole_height ?? null,
    })),
  )
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
    let footprint_observation_cache:
      | {
          fingerprint: string
          observation: FootprintGeometryObservation
          rejected_extractor_geometry_fingerprint?: string
        }
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
          evidencePrompt({
            additional_instructions: context.additional_instructions,
            footprint_hints,
            feedback,
          }),
        heartbeat_paths: (workspace) => [
          join(workspace, "component-evidence.json"),
          join(workspace, "component-footprint-catalog.json"),
          join(workspace, "visual-reference"),
        ],
        on_output: (stream, message) => appendJobLog(services.job_store, context.job_id, stream, message),
        rejection_debug: {
          debug_dir,
          files: [
            "component-evidence.json",
            "component-footprint-catalog.json",
            "footprint-geometry-review.json",
            "footprint-geometry-verification.json",
            "evidence-image-manifest.json",
          ],
          directories: ["visual-reference"],
        },
        validate: async (workspace, outer_attempt) => {
          const catalog_path = join(workspace, "component-footprint-catalog.json")
          const has_catalog = await Bun.file(catalog_path).exists()
          let canonicalization_count = 0
          const component_footprint_catalog = has_catalog
            ? parseComponentFootprintCatalog(
                await readBoundedJsonArtifact({
                  path: catalog_path,
                  max_bytes: 8 * 1024 * 1024,
                  max_depth: 56,
                  max_nodes: 240_000,
                }),
              )
            : await (async () => {
                const raw_component_evidence = await readBoundedJsonArtifact({
                  path: join(workspace, "component-evidence.json"),
                  max_bytes: 4 * 1024 * 1024,
                  max_depth: 48,
                  max_nodes: 100_000,
                })
                const canonicalization = canonicalizeComponentEvidenceInput(raw_component_evidence)
                canonicalization_count = canonicalization.changes.length
                return createSingleFootprintCatalog({
                  component_evidence: parseComponentEvidence(canonicalization.value),
                })
              })()
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
          const canonical_catalog = materialized.component_footprint_catalog
          const component_evidence = materialized.component_evidence
          const footprint_plan = createFootprintPlanFromEvidence(component_evidence)
          const blocking = canonical_catalog.footprints.flatMap((footprint) => {
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
            canonical_catalog.footprints.map((footprint) =>
              assertComponentEvidenceImageProvenance({
                workspace,
                component_evidence: footprint.component_evidence,
              }),
            ),
          )
          const footprint_fingerprint = footprintObservationFingerprint({
            manifest: materialized.manifest,
          })
          const extractor_geometry_fingerprint = extractedFootprintGeometryFingerprint(component_evidence)
          const reviewer_should_be_resampled =
            footprint_observation_cache?.fingerprint === footprint_fingerprint &&
            footprint_observation_cache.rejected_extractor_geometry_fingerprint ===
              extractor_geometry_fingerprint
          if (
            footprint_observation_cache?.fingerprint !== footprint_fingerprint ||
            reviewer_should_be_resampled
          ) {
            if (reviewer_should_be_resampled) {
              await appendJobLog(
                services.job_store,
                context.job_id,
                "system",
                `Extractor retained geometry ${extractor_geometry_fingerprint}; requesting a fresh independent footprint observation instead of reusing the disputed review.\n`,
              ).catch(() => undefined)
            }
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
          signal.throwIfAborted()

          let footprint_verification: Awaited<ReturnType<typeof verifyFootprintGeometry>> | undefined
          const verification_errors: Error[] = []
          try {
            footprint_verification = applyFootprintGeometryObservation({
              workspace,
              evidence: component_evidence,
              observation: footprint_observation_cache.observation,
            })
          } catch (error) {
            footprint_observation_cache.rejected_extractor_geometry_fingerprint =
              extractor_geometry_fingerprint
            verification_errors.push(error instanceof Error ? error : new Error(String(error)))
          }
          if (verification_errors.length > 0) {
            throw new AggregateError(verification_errors, "Independent footprint verification failed")
          }
          if (!footprint_verification) {
            throw new Error("Independent footprint verification returned no agreement record")
          }
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
            canonicalization_count,
          }
        },
        promote: async (workspace, evidence) => {
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
