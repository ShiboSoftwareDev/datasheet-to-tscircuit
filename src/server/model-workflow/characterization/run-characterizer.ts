import { join } from "node:path"
import {
  type ApplicationFixtureContract,
  type ModelCharacterization,
  type ModelInterface,
  writeModelContract,
} from "../../modeling"
import type { ModelPipelineContext, ModelPipelineServices } from "../types"
import { writeJson } from "../stage-helpers"
import { materializeModelEvidencePages } from "../model-evidence-pages"
import type { ReferenceGraphSourceProof } from "../reference-graph-axis-proof"
import {
  eligibleObservedGraphs,
  type ReferenceGraphObservation,
  verifyCharacterizationGraphEvidence,
  verifyReferenceGraphTracePixels,
} from "../reference-graph-observation"
import { characterizeReferenceGraphs } from "./from-reference-graphs"

/**
 * Converts the independently observed graphs into the canonical model contract.
 * This is intentionally deterministic: the graph observer already established
 * the crop, curve, and electrical experiment, so another model call cannot add
 * useful information and used to be a frequent source of drift and omission.
 */
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
}): Promise<{
  characterization: ModelCharacterization
  attempts: number
}> {
  const { context, services, attempt_dir, signal, model_interface, application_fixture } = input
  signal.throwIfAborted()
  const characterization = characterizeReferenceGraphs({
    model_interface,
    observation: input.source_observation,
  })
  services.strategy_registry.require(characterization.strategy, characterization.family)
  const verified_source_graph_ids = new Set(
    input.source_proof.results.flatMap((result) => (result.status === "verified" ? [result.graph_id] : [])),
  )
  const unverified_source_graph_ids = eligibleObservedGraphs(input.source_observation)
    .map(({ graph_id }) => graph_id)
    .filter((graph_id) => !verified_source_graph_ids.has(graph_id))
  const source_diagnostic =
    unverified_source_graph_ids.length > 0
      ? `Canonical PDF axis calibration remains incomplete for: ${unverified_source_graph_ids.join(", ")}`
      : undefined
  const numeric_verification = verifyCharacterizationGraphEvidence({
    characterization,
    observation: input.source_observation,
    ...(source_diagnostic ? {} : { source_proof: input.source_proof }),
  })
  const with_evidence = await materializeModelEvidencePages({
    workspace: attempt_dir,
    datasheet_path: join(context.model_dir, "datasheet.pdf"),
    characterization,
    process_runner: services.process_runner,
    signal,
    on_output: (stream, message) =>
      services.model_run_store.appendLog(context.model_run_id, { stream, message }).then(() => undefined),
  })
  let pixel_verification: unknown
  let pixel_diagnostic: string | undefined
  try {
    pixel_verification = await verifyReferenceGraphTracePixels({
      characterization: with_evidence,
      observation: input.source_observation,
      numeric_verification,
      evidence_dir: join(attempt_dir, "evidence"),
    })
  } catch (error) {
    signal.throwIfAborted()
    pixel_diagnostic = error instanceof Error ? error.message : String(error)
    await services.model_run_store.appendLog(context.model_run_id, {
      stream: "system",
      message: `Reference pixel trace remains a draft; model generation and visible comparison will continue. ${pixel_diagnostic}\n`,
    })
  }
  if (source_diagnostic) {
    await services.model_run_store.appendLog(context.model_run_id, {
      stream: "system",
      message: `Reference axis proof remains a draft; model generation and visible comparison will continue. ${source_diagnostic}\n`,
    })
  }
  const diagnostics = [source_diagnostic, pixel_diagnostic].filter(
    (diagnostic): diagnostic is string => diagnostic !== undefined,
  )
  const verification =
    diagnostics.length > 0
      ? {
          version: 1,
          status: "draft",
          diagnostics,
        }
      : pixel_verification
  await Promise.all([
    writeJson(join(attempt_dir, "model-characterization.json"), with_evidence),
    writeJson(join(attempt_dir, "model-reference-verification.json"), verification),
    writeModelContract(attempt_dir, {
      version: 1,
      interface: model_interface,
      characterization: with_evidence,
      application_fixture,
    }),
  ])
  return { characterization: with_evidence, attempts: 0 }
}
