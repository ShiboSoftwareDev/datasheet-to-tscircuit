import { mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { type AgentArtifactAttempt, type AgentClient, runAgentArtifactStage } from "../infrastructure/agent"
import { createStageWorkspace, promoteStageFile } from "../infrastructure/artifacts"
import {
  buildModelGenerationPrompt,
  createModelTrainingContract,
  type GeneratedModel,
  type ModelContract,
} from "../modeling"
import type { NgspiceExecutor, ValidationPlan } from "../spice-validation"
import {
  assertModelCandidateCheckReceiptMatches,
  checkModelCandidate,
  MODEL_CANDIDATE_CHECK_RECEIPT_FILE,
  readModelCandidateCheckReceipt,
} from "./model-candidate-check"

export interface StoredGeneratedModel extends GeneratedModel {
  artifact_dir: string
}

export async function generateModelCandidate(input: {
  model_dir: string
  contract: ModelContract
  validation_plan: ValidationPlan
  evidence_dir: string
  previous_candidate?: { model_path: string; model_card_path: string }
  strategy_guidance: string
  feedback?: string
  stage_id: "infer_spice_model" | "repair_spice_model" | "generate_model" | "repair_model"
  phase_label: string
  signal: AbortSignal
  use_openai: boolean
  agent_client: AgentClient
  /** @deprecated Inference performs static validation only. */
  ngspice?: NgspiceExecutor
  /** @deprecated Inference performs static validation only. */
  ngspice_path?: string
  /** @deprecated Inference performs no simulation. */
  tsci_path?: string
  max_artifact_attempts: number
  debug_dir: string
  on_output: (stream: "system" | "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<AgentArtifactAttempt<StoredGeneratedModel>> {
  const is_repair = input.stage_id === "repair_spice_model" || input.stage_id === "repair_model"
  if (is_repair && !input.previous_candidate) {
    throw new Error("Model repair requires the exact prior immutable candidate")
  }
  const previous_candidate = input.previous_candidate
  const repair_inputs =
    is_repair && previous_candidate
      ? [
          { source: previous_candidate.model_path, destination: "model.lib" },
          { source: previous_candidate.model_card_path, destination: "model-card.md" },
        ]
      : []
  const training_contract = createModelTrainingContract(input.contract)
  return runAgentArtifactStage({
    stage_id: input.stage_id,
    phase_label: input.phase_label,
    max_artifact_attempts: input.max_artifact_attempts,
    signal: input.signal,
    use_openai: input.use_openai,
    agent_client: input.agent_client,
    tool_profile: "model_candidate_files",
    create_workspace: async () => {
      const workspace = await createStageWorkspace({
        prefix: input.stage_id.replaceAll("_", "-"),
        files: [
          { source: join(input.model_dir, "AGENTS.md") },
          { source: join(input.model_dir, "model-interface.json") },
          { source: join(input.model_dir, "component-evidence.json") },
          { source: join(input.model_dir, "package.json"), required: false },
          { source: join(input.model_dir, "tsconfig.json"), required: false },
          { source: join(input.model_dir, "tscircuit.config.json"), required: false },
          { source: join(input.model_dir, "tscircuit.config.ts"), required: false },
          ...repair_inputs,
        ],
        directories: [{ source: input.evidence_dir, destination: "evidence", required: false }],
      })
      try {
        await Bun.write(
          join(workspace.path, "model-contract.json"),
          `${JSON.stringify(training_contract, null, 2)}\n`,
        )
        return workspace
      } catch (error) {
        await workspace.dispose().catch(() => undefined)
        throw error
      }
    },
    build_prompt: (artifact_feedback) =>
      buildModelGenerationPrompt({
        contract: input.contract,
        strategy_guidance: input.strategy_guidance,
        feedback: [input.feedback, artifact_feedback].filter(Boolean).join("\n\n"),
      }),
    heartbeat_paths: (workspace) => [join(workspace, "model.lib"), join(workspace, "model-card.md")],
    on_output: input.on_output,
    rejection_debug: {
      debug_dir: input.debug_dir,
      files: ["model.lib", "model-card.md", MODEL_CANDIDATE_CHECK_RECEIPT_FILE],
    },
    validate: async (workspace) => {
      const checked = await checkModelCandidate({
        workspace,
        model_interface: input.contract.interface,
        model_contract: input.contract,
        signal: input.signal,
      })
      const agent_receipt = await readModelCandidateCheckReceipt(workspace)
      assertModelCandidateCheckReceiptMatches(agent_receipt, checked)
      const { generated } = checked
      return {
        ...generated,
        artifact_dir: join(
          input.model_dir,
          "candidates",
          `${generated.manifest.revision}-${crypto.randomUUID()}`,
        ),
      }
    },
    promote: async (workspace, generated, signal) => {
      await mkdir(generated.artifact_dir, { recursive: true })
      await Promise.all([
        promoteStageFile({
          workspace,
          source: "model.lib",
          destination_root: generated.artifact_dir,
          max_bytes: 2 * 1024 * 1024,
          signal,
        }),
        promoteStageFile({
          workspace,
          source: "model-card.md",
          destination_root: generated.artifact_dir,
          max_bytes: 512 * 1024,
          signal,
        }),
        promoteStageFile({
          workspace,
          source: MODEL_CANDIDATE_CHECK_RECEIPT_FILE,
          destination_root: generated.artifact_dir,
          max_bytes: 16 * 1024,
          signal,
        }),
      ])
      // The manifest is derived by the server from the validated source; it is
      // never accepted from the agent workspace.
      const manifest_text = `${JSON.stringify(generated.manifest, null, 2)}\n`
      await Bun.write(join(generated.artifact_dir, "model-manifest.json"), manifest_text)
      const promoted_source = await readFile(join(generated.artifact_dir, "model.lib"), "utf8")
      if (promoted_source !== generated.source) {
        throw new Error("Stored immutable model.lib differs from the validated candidate")
      }
    },
  })
}
