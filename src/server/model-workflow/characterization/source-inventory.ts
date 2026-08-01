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

  const observer = await runAgentArtifactStage<ReferenceGraphObservation>({
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
      return observation
    },
    promote: async (_workspace, observation) => {
      await writeJson(join(attempt_dir, "model-reference-observation.json"), observation)
    },
  })

  let source_proof: ReferenceGraphSourceProof
  try {
    source_proof = await buildReferenceGraphSourceProof({
      observation: observer.value,
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
  await writeJson(join(attempt_dir, "model-reference-source-proof.json"), source_proof)
  const observation = applyReferenceGraphSourceEligibility({
    observation: observer.value,
    proof: source_proof,
  })
  assertObserverFoundEligibleTimeDomainGraph(observation)
  return {
    time_graph_hints_path,
    observation,
    source_proof,
    observer_attempts: observer.attempts,
  }
}
