import { join } from "node:path"
import { runAgentArtifactStage } from "../../infrastructure/agent"
import { createStageWorkspace, readBoundedJsonArtifact } from "../../infrastructure/artifacts"
import { type ApplicationFixtureContract, type ModelInterface } from "../../modeling"
import { PipelineError } from "../../pipeline"
import type { JobLogStream } from "../../../shared/job-types"
import type { ModelPipelineContext, ModelPipelineServices } from "../types"
import { appendModelLog, writeJson } from "../stage-helpers"
import {
  applyReferenceGraphSourceEligibility,
  buildReferenceGraphSourceProof,
  type ReferenceGraphSourceProof,
} from "../reference-graph-axis-proof"
import {
  buildReferenceGraphObserverPrompt,
  eligibleObservedGraphs,
  parseReferenceGraphObservation,
  type ReferenceGraphObservation,
  verifyReferenceGraphObservationPixels,
} from "../reference-graph-observation"
import { discoverTimeGraphHints } from "../time-graph-hints"
import { assertObserverFoundEligibleTimeDomainGraph } from "./eligibility"

export interface ReferenceGraphInventory {
  readonly time_graph_hints_path: string
  readonly observation: ReferenceGraphObservation
  readonly source_proof: ReferenceGraphSourceProof
  readonly observer_attempts: number
}

export function sourceProofRejectionDiagnostics(
  observation: ReferenceGraphObservation,
  proof: ReferenceGraphSourceProof,
): string[] {
  const proof_by_graph = new Map(proof.results.map((result) => [result.graph_id, result]))
  return eligibleObservedGraphs(observation).flatMap((graph) => {
    const result = proof_by_graph.get(graph.graph_id)
    if (result?.status === "verified") return []
    if (result?.status === "ineligible") {
      const missing = result.diagnostic.missing_proofs.join(", ")
      return [`${graph.graph_id}: ${result.reason}${missing ? ` Missing source proofs: ${missing}` : ""}`]
    }
    return [`${graph.graph_id}: no canonical PDF axis-calibration result was produced`]
  })
}

async function buildSourceProof(input: {
  observation: ReferenceGraphObservation
  datasheet_path: string
  services: ModelPipelineServices
  signal: AbortSignal
}): Promise<ReferenceGraphSourceProof> {
  try {
    return await buildReferenceGraphSourceProof({
      observation: input.observation,
      datasheet_path: input.datasheet_path,
      process_runner: input.services.process_runner,
      signal: input.signal,
    })
  } catch (error) {
    input.signal.throwIfAborted()
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
}

export async function inventoryReferenceGraphs(input: {
  context: ModelPipelineContext
  services: ModelPipelineServices
  attempt_dir: string
  debug_dir: string
  signal: AbortSignal
  model_interface: ModelInterface
  application_fixture: ApplicationFixtureContract
}): Promise<ReferenceGraphInventory> {
  const { context, services, attempt_dir, debug_dir, signal, model_interface, application_fixture } = input
  const datasheet_path = join(context.model_dir, "datasheet.pdf")
  const extension = join(import.meta.dir, "../../infrastructure/agent/image-read-extension.ts")
  const logOutput = (stream: JobLogStream, message: string) =>
    appendModelLog(services.model_run_store, context.model_run_id, stream, message)

  const time_graph_discovery = await discoverTimeGraphHints({
    datasheet_path,
    process_runner: services.process_runner,
    signal,
    on_output: logOutput,
  })
  const time_graph_hints_path = join(attempt_dir, "time-graph-hints.json")
  await writeJson(time_graph_hints_path, time_graph_discovery)

  const observer = await runAgentArtifactStage<{
    observation: ReferenceGraphObservation
    source_proof: ReferenceGraphSourceProof
  }>({
    stage_id: "verify_model_reference_graphs",
    phase_label: "Independent datasheet graph inventory",
    max_artifact_attempts: 4,
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
    build_prompt: (feedback) => buildReferenceGraphObserverPrompt(feedback),
    heartbeat_paths: (workspace) => [join(workspace, "model-reference-observation.json")],
    on_output: logOutput,
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
        on_output: logOutput,
      })
      const source_proof = await buildSourceProof({
        observation,
        datasheet_path,
        services,
        signal,
      })
      const source_rejections = sourceProofRejectionDiagnostics(observation, source_proof)
      if (source_rejections.length > 0) {
        throw new Error(
          `Canonical PDF source verification rejected agent-claimed eligible graphs:\n${source_rejections.join("\n")}`,
        )
      }
      return {
        observation: applyReferenceGraphSourceEligibility({ observation, proof: source_proof }),
        source_proof,
      }
    },
    promote: async (_workspace, value) => {
      await writeJson(join(attempt_dir, "model-reference-observation.json"), value.observation)
      await writeJson(join(attempt_dir, "model-reference-source-proof.json"), value.source_proof)
    },
  })
  assertObserverFoundEligibleTimeDomainGraph(observer.value.observation)
  return {
    time_graph_hints_path,
    observation: observer.value.observation,
    source_proof: observer.value.source_proof,
    observer_attempts: observer.attempts,
  }
}
