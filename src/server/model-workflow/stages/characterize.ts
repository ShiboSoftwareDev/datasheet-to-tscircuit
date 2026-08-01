import { lstat } from "node:fs/promises"
import { join } from "node:path"
import { runAgentArtifactStage } from "../../infrastructure/agent"
import {
  createStageWorkspace,
  promoteStageDirectory,
  readBoundedJsonArtifact,
  validatePngArtifact,
  validateStageDirectory,
} from "../../infrastructure/artifacts"
import {
  buildCharacterizationPrompt,
  type ApplicationFixtureContract,
  type ModelCharacterization,
  type ModelInterface,
  parseApplicationFixtureContract,
  parseModelCharacterization,
  parseModelInterface,
  writeModelContract,
} from "../../modeling"
import { PipelineError } from "../../pipeline"
import { appendModelLog, modelArtifact, readJson, updateModelProgress, writeJson } from "../stage-helpers"
import { materializeModelEvidencePages } from "../model-evidence-pages"
import {
  applyReferenceGraphSourceEligibility,
  buildReferenceGraphSourceProof,
} from "../reference-graph-axis-proof"
import { canonicalizeCharacterizationReferenceCrops } from "../reference-graph-crop-proof"
import {
  buildReferenceGraphObserverPrompt,
  eligibleObservedGraphs,
  parseReferenceGraphObservation,
  projectReferenceGraphObservationForCharacterizer,
  verifyCharacterizationGraphEvidence,
  verifyReferenceGraphObservationPixels,
  verifyReferenceGraphTracePixels,
} from "../reference-graph-observation"
import { discoverTimeGraphHints } from "../time-graph-hints"
import { defineModelStage } from "./stage-factory"

async function assertReferencedImagesExist(workspace: string, characterization: ModelCharacterization) {
  const image_paths = characterization.requirements.flatMap((requirement) => [
    ...(requirement.reference_curve?.image ? [requirement.reference_curve.image] : []),
    ...requirement.sources.flatMap(({ image }) => (image ? [image] : [])),
  ])
  for (const image_path of new Set(image_paths)) {
    if (!image_path.startsWith("evidence/") || image_path.split(/[\\/]/).includes("..")) {
      throw new Error(`Referenced image must stay under evidence/: ${image_path}`)
    }
    if (!(await Bun.file(join(workspace, image_path)).exists())) {
      throw new Error(`Referenced evidence image does not exist: ${image_path}`)
    }
  }
}

function boundedDiagnosticText(value: string, max_length: number): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length <= max_length ? normalized : `${normalized.slice(0, max_length - 1)}…`
}

function noEligibleTimeDomainGraphError(graph_diagnostics: readonly string[] = []): PipelineError {
  const graph_detail = graph_diagnostics.length > 0
    ? ` Reviewed graph diagnostics: ${graph_diagnostics.slice(0, 4).join(" | ")}`
    : ""
  return new PipelineError({
    code: "no_eligible_time_domain_graph",
    message:
      "The complete PDF scan and independent source observer found no eligible printed elapsed-time voltage graph for a fresh executable SPICE model." +
      graph_detail,
    stage_id: "characterize",
    operation: "validate_model_characterization",
    hint: "Only a public-pin transient voltage waveform with a supported reproducible fixture and an independently matched cited-page graph crop can start model generation; scalar, operating-point, DC-only, current-only, and protocol-dependent specifications remain documented-only.",
    retryable: false,
  })
}

export function assertHasEligibleTimeDomainGraph(characterization: ModelCharacterization): void {
  if (characterization.requirements.some(({ support }) => support.status === "modeled")) return
  throw noEligibleTimeDomainGraphError()
}

export function assertObserverFoundEligibleTimeDomainGraph(
  observation: Parameters<typeof eligibleObservedGraphs>[0],
): void {
  if (eligibleObservedGraphs(observation).length > 0) return
  // Stop before asking another agent to invent a characterization or model for
  // a datasheet that has no graph the installed viewer can actually reproduce.
  throw noEligibleTimeDomainGraphError(
    observation.graphs.map(
      ({ page, locator, reason }) =>
        `PDF page ${page} ${boundedDiagnosticText(locator, 80)}: ${boundedDiagnosticText(reason, 240)}`,
    ),
  )
}

export const characterizeStage = defineModelStage({
  id: "characterize",
  depends_on: ["prepare_workspace"],
  async execute({ context, services, dependency_outputs, signal, debug_dir }) {
    services.model_run_store.startSegment(context.model_run_id)
    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "characterizing",
      message: "Extracting model requirements and reference curves from the datasheet",
    })
    const model_interface: ModelInterface = parseModelInterface(
      await readJson(join(context.model_dir, "model-interface.json")),
    )
    const application_fixture: ApplicationFixtureContract = parseApplicationFixtureContract(
      await readJson(join(context.model_dir, "application-fixture-contract.json")),
    )
    const attempt_dir = dependency_outputs.prepare_workspace.attempt_dir
    const extension = join(import.meta.dir, "../../infrastructure/agent/image-read-extension.ts")
    const datasheet_path = join(context.model_dir, "datasheet.pdf")
    const time_graph_discovery = await discoverTimeGraphHints({
      datasheet_path,
      process_runner: services.process_runner,
      signal,
      on_output: (stream, message) =>
        appendModelLog(services.model_run_store, context.model_run_id, stream, message),
    })
    const time_graph_hints_path = join(attempt_dir, "time-graph-hints.json")
    await writeJson(time_graph_hints_path, time_graph_discovery)
    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "characterizing",
      message: "Independently inventorying elapsed-time graphs in the complete datasheet",
    })
    const reference_observer = await runAgentArtifactStage({
      stage_id: "verify_model_reference_graphs",
      phase_label: "Independent datasheet graph inventory",
      max_artifact_attempts: 2,
      signal,
      use_openai: context.use_openai,
      agent_client: services.agent_client,
      extensions: [extension],
      create_workspace: () =>
        createStageWorkspace({
          prefix: "model-reference-observer",
          files: [
            { source: join(context.model_dir, "AGENTS.md") },
            { source: datasheet_path, destination: "datasheet.pdf" },
            { source: join(context.model_dir, "model-interface.json") },
            { source: join(context.model_dir, "application-fixture-contract.json") },
            { source: time_graph_hints_path },
          ],
        }),
      build_prompt: () => buildReferenceGraphObserverPrompt(),
      heartbeat_paths: (workspace) => [join(workspace, "model-reference-observation.json")],
      on_output: (stream, message) =>
        appendModelLog(services.model_run_store, context.model_run_id, stream, message),
      rejection_debug: {
        debug_dir: join(debug_dir, "reference-observer"),
        files: ["model-reference-observation.json"],
      },
      validate: async (workspace) => {
        const observation = parseReferenceGraphObservation(
          await readBoundedJsonArtifact({
            path: join(workspace, "model-reference-observation.json"),
            max_bytes: 2 * 1024 * 1024,
            max_depth: 32,
            max_nodes: 20_000,
          }),
          time_graph_discovery,
          model_interface,
          application_fixture,
        )
        await verifyReferenceGraphObservationPixels({
          observation,
          datasheet_path,
          process_runner: services.process_runner,
          signal,
          on_output: (stream, message) =>
            appendModelLog(services.model_run_store, context.model_run_id, stream, message),
        })
        return observation
      },
      promote: async (_workspace, observation) => {
        await writeJson(join(attempt_dir, "model-reference-observation.json"), observation)
      },
    })
    let reference_source_proof: Awaited<ReturnType<typeof buildReferenceGraphSourceProof>>
    try {
      reference_source_proof = await buildReferenceGraphSourceProof({
        observation: reference_observer.value,
        datasheet_path,
        process_runner: services.process_runner,
        signal,
      })
    } catch (error) {
      signal.throwIfAborted()
      throw new PipelineError(
        {
          code: "reference_axis_infrastructure_failed",
          message: `Canonical PDF reference-axis verification could not run: ${error instanceof Error ? error.message : String(error)}`,
          stage_id: "characterize",
          operation: "verify_reference_axis",
          hint: "Install and verify pdftoppm, pdftotext, and tesseract with English OCR data in the server runtime. This is an infrastructure failure, not an agent artifact rejection.",
          retryable: false,
        },
        { cause: error },
      )
    }
    await writeJson(join(attempt_dir, "model-reference-source-proof.json"), reference_source_proof)
    const source_observation = applyReferenceGraphSourceEligibility({
      observation: reference_observer.value,
      proof: reference_source_proof,
    })
    assertObserverFoundEligibleTimeDomainGraph(source_observation)
    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "characterizing",
      message: "Extracting model requirements and verified reference curves from the datasheet",
    })
    const attempt = await runAgentArtifactStage({
      stage_id: "characterize",
      phase_label: "Model characterization",
      max_artifact_attempts: 3,
      signal,
      use_openai: context.use_openai,
      agent_client: services.agent_client,
      extensions: [extension],
      create_workspace: async () => {
        const workspace = await createStageWorkspace({
          prefix: "model-characterize",
          files: [
            { source: join(context.model_dir, "AGENTS.md") },
            { source: join(context.model_dir, "datasheet.pdf") },
            { source: join(context.model_dir, "model-interface.json") },
            { source: join(context.model_dir, "component-evidence.json") },
            { source: join(context.model_dir, "typical-application-plan.json") },
            { source: join(context.model_dir, "application-fixture-contract.json") },
            { source: join(context.model_dir, "component.circuit.tsx") },
            { source: time_graph_hints_path },
          ],
        })
        try {
          await writeJson(
            join(workspace.path, "model-reference-observation.json"),
            projectReferenceGraphObservationForCharacterizer(source_observation),
          )
          return workspace
        } catch (error) {
          await workspace.dispose().catch(() => undefined)
          throw error
        }
      },
      build_prompt: buildCharacterizationPrompt,
      heartbeat_paths: (workspace) => [
        join(workspace, "model-characterization.json"),
        join(workspace, "evidence"),
      ],
      on_output: (stream, message) =>
        appendModelLog(services.model_run_store, context.model_run_id, stream, message),
      rejection_debug: {
        debug_dir,
        files: ["model-characterization.json"],
        directories: ["evidence"],
      },
      validate: async (workspace) => {
        const parsed_characterization = parseModelCharacterization(
          await readBoundedJsonArtifact({
            path: join(workspace, "model-characterization.json"),
            max_bytes: 4 * 1024 * 1024,
            max_depth: 64,
            max_nodes: 100_000,
          }),
          {
            policy: "fresh",
            reject_unknown_fields: true,
          },
        )
        const canonical_characterization = canonicalizeCharacterizationReferenceCrops({
          characterization: parsed_characterization,
          observation: source_observation,
        })
        const numeric_verification = verifyCharacterizationGraphEvidence({
          characterization: canonical_characterization,
          observation: source_observation,
          source_proof: reference_source_proof,
        })
        assertHasEligibleTimeDomainGraph(canonical_characterization)
        const characterization = await materializeModelEvidencePages({
          workspace,
          datasheet_path,
          characterization: canonical_characterization,
          process_runner: services.process_runner,
          signal,
          on_output: (stream, message) =>
            appendModelLog(services.model_run_store, context.model_run_id, stream, message),
        })
        const verification = await verifyReferenceGraphTracePixels({
          characterization,
          observation: source_observation,
          numeric_verification,
          evidence_dir: join(workspace, "evidence"),
        })
        services.strategy_registry.require(characterization.strategy, characterization.family)
        await assertReferencedImagesExist(workspace, characterization)
        const evidence_dir = join(workspace, "evidence")
        if (await lstat(evidence_dir).catch(() => undefined)) {
          await validateStageDirectory({
            root: evidence_dir,
            max_files: 64,
            max_total_bytes: 64 * 1024 * 1024,
            validate_file: validatePngArtifact,
          })
        }
        return { characterization, verification }
      },
      promote: async (workspace, value, promotion_signal) => {
        const { characterization, verification } = value
        await writeJson(join(attempt_dir, "model-characterization.json"), characterization)
        await writeJson(join(attempt_dir, "model-reference-verification.json"), verification)
        await writeModelContract(attempt_dir, {
          version: 1,
          interface: model_interface,
          characterization,
          application_fixture,
        })
        await promoteStageDirectory({
          workspace,
          source: "evidence",
          destination_root: attempt_dir,
          required: false,
          max_files: 64,
          max_total_bytes: 64 * 1024 * 1024,
          validate_file: validatePngArtifact,
          signal: promotion_signal,
        })
      },
    })
    const characterization = attempt.value.characterization
    const modeled_requirement_ids = characterization.requirements.flatMap(({ requirement_id, support }) =>
      support.status === "modeled" ? [requirement_id] : [],
    )
    const contract_path = join(attempt_dir, "model-contract.json")
    const reference_observation_path = join(attempt_dir, "model-reference-observation.json")
    const reference_source_proof_path = join(attempt_dir, "model-reference-source-proof.json")
    const reference_verification_path = join(attempt_dir, "model-reference-verification.json")
    return {
      status: "completed",
      output: {
        contract_path,
        family: characterization.family,
        strategy: characterization.strategy,
        modeled_requirement_ids,
        documented_only_count: characterization.requirements.length - modeled_requirement_ids.length,
        application_fixture_path: join(attempt_dir, "application-fixture-contract.json"),
        application_fixture_sha256: application_fixture.contract_sha256,
        time_graph_hints_path,
        reference_observation_path,
        reference_source_proof_path,
        reference_verification_path,
      },
      artifacts: [
        await modelArtifact({
          id: "model_contract",
          path: contract_path,
          media_type: "application/json",
          role: "model_contract",
        }),
        await modelArtifact({
          id: "application_fixture_contract",
          path: join(attempt_dir, "application-fixture-contract.json"),
          media_type: "application/json",
          role: "model_contract",
        }),
        await modelArtifact({
          id: "time_graph_hints",
          path: time_graph_hints_path,
          media_type: "application/json",
          role: "source_observation",
        }),
        await modelArtifact({
          id: "model_reference_observation",
          path: reference_observation_path,
          media_type: "application/json",
          role: "source_observation",
        }),
        await modelArtifact({
          id: "model_reference_source_proof",
          path: reference_source_proof_path,
          media_type: "application/json",
          role: "source_verification",
        }),
        await modelArtifact({
          id: "model_reference_verification",
          path: reference_verification_path,
          media_type: "application/json",
          role: "source_verification",
        }),
      ],
      metrics: {
        agent_attempts: attempt.attempts,
        reference_observer_attempts: reference_observer.attempts,
        modeled_requirements: modeled_requirement_ids.length,
        documented_only_requirements: characterization.requirements.length - modeled_requirement_ids.length,
        application_fixture_documented: application_fixture.availability === "documented" ? 1 : 0,
      },
    }
  },
})
