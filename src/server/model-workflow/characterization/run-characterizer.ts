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
  parseModelCharacterization,
  writeModelContract,
} from "../../modeling"
import type { ModelPipelineContext, ModelPipelineServices } from "../types"
import type { JobLogStream } from "../../../shared/job-types"
import { appendModelLog, writeJson } from "../stage-helpers"
import { materializeModelEvidencePages } from "../model-evidence-pages"
import type { ReferenceGraphSourceProof } from "../reference-graph-axis-proof"
import { canonicalizeCharacterizationReferenceCrops } from "../reference-graph-crop-proof"
import {
  projectReferenceGraphObservationForCharacterizer,
  type ModelReferenceVerification,
  type ReferenceGraphObservation,
  verifyCharacterizationGraphEvidence,
  verifyReferenceGraphTracePixels,
} from "../reference-graph-observation"
import { assertHasEligibleTimeDomainGraph } from "./eligibility"

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

export async function runCharacterizer(input: {
  context: ModelPipelineContext
  services: ModelPipelineServices
  attempt_dir: string
  debug_dir: string
  signal: AbortSignal
  model_interface: ModelInterface
  application_fixture: ApplicationFixtureContract
  time_graph_hints_path: string
  source_observation: ReferenceGraphObservation
  source_proof: ReferenceGraphSourceProof
}): Promise<{ characterization: ModelCharacterization; attempts: number }> {
  const {
    context,
    services,
    attempt_dir,
    debug_dir,
    signal,
    model_interface,
    application_fixture,
    time_graph_hints_path,
    source_observation,
    source_proof,
  } = input
  const datasheet_path = join(context.model_dir, "datasheet.pdf")
  const extension = join(import.meta.dir, "../../infrastructure/agent/image-read-extension.ts")
  const logOutput = (stream: JobLogStream, message: string) =>
    appendModelLog(services.model_run_store, context.model_run_id, stream, message)

  const attempt = await runAgentArtifactStage<{
    characterization: ModelCharacterization
    verification: ModelReferenceVerification
  }>({
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
          { source: datasheet_path },
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
    on_output: logOutput,
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
        { policy: "fresh", reject_unknown_fields: true },
      )
      const canonical_characterization = canonicalizeCharacterizationReferenceCrops({
        characterization: parsed_characterization,
        observation: source_observation,
      })
      const numeric_verification = verifyCharacterizationGraphEvidence({
        characterization: canonical_characterization,
        observation: source_observation,
        source_proof,
      })
      assertHasEligibleTimeDomainGraph(canonical_characterization)
      const characterization = await materializeModelEvidencePages({
        workspace,
        datasheet_path,
        characterization: canonical_characterization,
        process_runner: services.process_runner,
        signal,
        on_output: logOutput,
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
      await writeJson(join(attempt_dir, "model-characterization.json"), value.characterization)
      await writeJson(join(attempt_dir, "model-reference-verification.json"), value.verification)
      await writeModelContract(attempt_dir, {
        version: 1,
        interface: model_interface,
        characterization: value.characterization,
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
  return { characterization: attempt.value.characterization, attempts: attempt.attempts }
}
