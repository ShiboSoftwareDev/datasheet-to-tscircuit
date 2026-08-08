import { copyFile, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { ensureJobTscircuitRuntimeConfig } from "../../job-scaffold"
import {
  createModelManifest,
  type GeneratedModel,
  parseFreshModelContract,
  validateFreshModelSource,
} from "../../modeling"
import type { ValidationPlan } from "../../spice-validation"
import { generateModelCandidate } from "../model-candidate"
import { appendModelLog, modelArtifact, readJson, updateModelProgress } from "../stage-helpers"
import { defineModelStage } from "./stage-factory"

async function materializeCandidateRuntime(input: { job_dir: string; model_dir: string }): Promise<void> {
  await Promise.all([
    ensureJobTscircuitRuntimeConfig(input.model_dir),
    ...["package.json", "tsconfig.json", "tscircuit.config.json"].map(async (file_name) => {
      const source = join(input.job_dir, file_name)
      if (await Bun.file(source).exists()) {
        await copyFile(source, join(input.model_dir, file_name))
      }
    }),
  ])
}

async function retainedCandidateForRetry(input: {
  model_dir: string
  revision?: string
  contract: ReturnType<typeof parseFreshModelContract>
}): Promise<{ artifact_dir: string; generated: GeneratedModel } | undefined> {
  if (!input.revision) return undefined
  const candidates_root = join(input.model_dir, "candidates")
  let entries
  try {
    entries = await readdir(candidates_root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  const matches = entries.filter(
    (entry) => entry.isDirectory() && entry.name.startsWith(`${input.revision}-`),
  )
  if (matches.length !== 1) return undefined
  const artifact_dir = join(candidates_root, matches[0]!.name)
  try {
    const [source, card, persisted_manifest] = await Promise.all([
      readFile(join(artifact_dir, "model.lib"), "utf8"),
      readFile(join(artifact_dir, "model-card.md"), "utf8"),
      readFile(join(artifact_dir, "model-manifest.json"), "utf8").then(JSON.parse),
    ])
    if (!card.trim()) return undefined
    validateFreshModelSource(source, input.contract)
    const derived = createModelManifest({
      model_interface: input.contract.interface,
      model_source: source,
      simulator: "ngspice",
    })
    if (
      typeof persisted_manifest !== "object" ||
      persisted_manifest === null ||
      persisted_manifest.revision !== derived.revision ||
      persisted_manifest.entry_name !== derived.entry_name ||
      persisted_manifest.part_number !== derived.part_number ||
      persisted_manifest.simulator !== derived.simulator ||
      JSON.stringify(persisted_manifest.pins) !== JSON.stringify(derived.pins) ||
      !Number.isFinite(Date.parse(persisted_manifest.generated_at))
    ) {
      return undefined
    }
    return {
      artifact_dir,
      generated: { source, card, manifest: persisted_manifest as GeneratedModel["manifest"] },
    }
  } catch {
    return undefined
  }
}

export const generateModelStage = defineModelStage({
  id: "infer_spice_model",
  depends_on: ["create_comparison_graphs"],
  async execute({ context, services, dependency_outputs, signal, debug_dir }) {
    updateModelProgress({
      store: services.model_run_store,
      model_run_id: context.model_run_id,
      phase: "generating_model",
      message: "Generating a bounded self-contained SPICE subcircuit",
    })
    const { contract_path, plan_path, evidence_dir } = dependency_outputs.create_comparison_graphs
    const [contract_value, plan_value] = await Promise.all([readJson(contract_path), readJson(plan_path)])
    const contract = parseFreshModelContract(contract_value)
    const strategy = services.strategy_registry.require(
      contract.characterization.strategy,
      contract.characterization.family,
    )
    await materializeCandidateRuntime({ job_dir: context.job_dir, model_dir: context.model_dir })
    const current_run = services.model_run_store.getModelRun(context.model_run_id)
    signal.throwIfAborted()
    const retained = await retainedCandidateForRetry({
      model_dir: context.model_dir,
      revision:
        current_run?.validation?.artifact_state === "candidate"
          ? current_run.validation.model_revision
          : undefined,
      contract,
    })
    signal.throwIfAborted()
    const attempt = retained
      ? {
          value: { ...retained.generated, artifact_dir: retained.artifact_dir },
          attempts: 0,
        }
      : await generateModelCandidate({
          model_dir: context.model_dir,
          contract,
          validation_plan: plan_value as ValidationPlan,
          evidence_dir,
          strategy_guidance: strategy.guidance,
          stage_id: "infer_spice_model",
          phase_label: "SPICE model generation",
          signal,
          use_openai: context.use_openai,
          agent_client: services.agent_client,
          ngspice: services.ngspice_executor,
          ngspice_path: services.ngspice_bin,
          tsci_path: services.tsci_bin,
          max_artifact_attempts: 3,
          debug_dir,
          on_output: (stream, message) =>
            appendModelLog(services.model_run_store, context.model_run_id, stream, message),
        })
    if (retained) {
      await appendModelLog(
        services.model_run_store,
        context.model_run_id,
        "system",
        `Reusing immutable candidate ${retained.generated.manifest.revision} for authoritative validation after an infrastructure retry.\n`,
      )
    }
    const model_path = join(attempt.value.artifact_dir, "model.lib")
    const model_card_path = join(attempt.value.artifact_dir, "model-card.md")
    const manifest_path = join(attempt.value.artifact_dir, "model-manifest.json")
    services.model_run_store.projectDevelopmentModel(context.model_run_id, {
      model_source: attempt.value.source,
      model_card: attempt.value.card,
      manifest: attempt.value.manifest,
    })
    return {
      status: "completed",
      output: {
        model_path,
        model_card_path,
        manifest_path,
        contract_path,
        plan_path,
        evidence_dir,
        revision: attempt.value.manifest.revision,
      },
      artifacts: [
        await modelArtifact({
          id: "spice_model",
          path: model_path,
          media_type: "text/plain",
          role: "generated_model",
        }),
        await modelArtifact({
          id: "model_manifest",
          path: manifest_path,
          media_type: "application/json",
          role: "model_manifest",
        }),
        await modelArtifact({
          id: "model_card",
          path: model_card_path,
          media_type: "text/markdown",
          role: "model_documentation",
        }),
      ],
      metrics: { agent_attempts: attempt.attempts },
    }
  },
})
