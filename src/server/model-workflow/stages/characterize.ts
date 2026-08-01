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
  type ModelCharacterization,
  type ModelInterface,
  parseModelCharacterization,
  parseModelInterface,
  writeModelContract,
} from "../../modeling"
import { appendModelLog, modelArtifact, readJson, updateModelProgress, writeJson } from "../stage-helpers"
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
    const attempt_dir = dependency_outputs.prepare_workspace.attempt_dir
    const extension = join(import.meta.dir, "../../infrastructure/agent/image-read-extension.ts")
    const attempt = await runAgentArtifactStage({
      stage_id: "characterize",
      phase_label: "Model characterization",
      max_artifact_attempts: 3,
      signal,
      use_openai: context.use_openai,
      agent_client: services.agent_client,
      extensions: [extension],
      create_workspace: () =>
        createStageWorkspace({
          prefix: "model-characterize",
          files: [
            { source: join(context.model_dir, "AGENTS.md") },
            { source: join(context.model_dir, "datasheet.pdf") },
            { source: join(context.model_dir, "model-interface.json") },
            { source: join(context.model_dir, "component-evidence.json") },
            { source: join(context.model_dir, "typical-application-plan.json") },
            { source: join(context.model_dir, "component.circuit.tsx") },
          ],
        }),
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
        const characterization = parseModelCharacterization(
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
        services.strategy_registry.require(characterization.strategy, characterization.family)
        await assertReferencedImagesExist(workspace, characterization)
        const evidence_dir = join(workspace, "evidence")
        if (await lstat(evidence_dir).catch(() => undefined)) {
          await validateStageDirectory({
            root: evidence_dir,
            max_files: 64,
            max_total_bytes: 32 * 1024 * 1024,
            validate_file: validatePngArtifact,
          })
        }
        return characterization
      },
      promote: async (workspace, characterization, promotion_signal) => {
        await writeJson(join(attempt_dir, "model-characterization.json"), characterization)
        await writeModelContract(attempt_dir, {
          version: 1,
          interface: model_interface,
          characterization,
        })
        await promoteStageDirectory({
          workspace,
          source: "evidence",
          destination_root: attempt_dir,
          required: false,
          max_files: 64,
          max_total_bytes: 32 * 1024 * 1024,
          validate_file: validatePngArtifact,
          signal: promotion_signal,
        })
      },
    })
    const modeled_requirement_ids = attempt.value.requirements.flatMap(({ requirement_id, support }) =>
      support.status === "modeled" ? [requirement_id] : [],
    )
    const contract_path = join(attempt_dir, "model-contract.json")
    return {
      status: "completed",
      output: {
        contract_path,
        family: attempt.value.family,
        strategy: attempt.value.strategy,
        modeled_requirement_ids,
        documented_only_count: attempt.value.requirements.length - modeled_requirement_ids.length,
      },
      artifacts: [
        await modelArtifact({
          id: "model_contract",
          path: contract_path,
          media_type: "application/json",
          role: "model_contract",
        }),
      ],
      metrics: {
        agent_attempts: attempt.attempts,
        modeled_requirements: modeled_requirement_ids.length,
        documented_only_requirements: attempt.value.requirements.length - modeled_requirement_ids.length,
      },
    }
  },
})
