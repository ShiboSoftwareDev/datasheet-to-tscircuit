import { readdir, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { runAgentArtifactStage } from "../../infrastructure/agent"
import { createStageWorkspace, readBoundedJsonArtifact } from "../../infrastructure/artifacts"
import { type ApplicationFixtureContract, type ModelInterface } from "../../modeling"
import { PipelineError } from "../../pipeline"
import type { JobLogStream } from "../../../shared/job-types"
import type { ModelPipelineContext, ModelPipelineServices } from "../types"
import { appendModelLog, writeJson } from "../stage-helpers"
import { buildReferenceGraphSourceProof, type ReferenceGraphSourceProof } from "../reference-graph-axis-proof"
import {
  buildComparisonReferenceGraphObserverPrompt,
  buildFoundReferenceGraphObserverPrompt,
  buildReferenceGraphObserverPrompt,
  eligibleObservedGraphs,
  parseFoundReferenceGraphObservation,
  parseCanonicalReferenceGraphObservation,
  parseReferenceGraphObservation,
  ReferenceGraphPixelVerificationError,
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
  readonly reused_from_invocation_id?: string
}

export interface FoundReferenceGraphInventory {
  readonly time_graph_hints_path: string
  readonly observation: ReferenceGraphObservation
  readonly observer_attempts: number
}

interface PriorObservationCandidate {
  invocation_id: string
  observation_path: string
  modified_at_ms: number
}

export async function findPriorReferenceObservationCandidates(input: {
  model_dir: string
  current_invocation_id: string
}): Promise<PriorObservationCandidate[]> {
  const attempts_dir = join(input.model_dir, "attempts")
  let entries
  try {
    entries = await readdir(attempts_dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== input.current_invocation_id)
      .map(async (entry): Promise<PriorObservationCandidate | undefined> => {
        const observation_path = join(attempts_dir, entry.name, "model-reference-observation.json")
        try {
          const metadata = await stat(observation_path)
          return {
            invocation_id: entry.name,
            observation_path,
            modified_at_ms: metadata.mtimeMs,
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
          throw error
        }
      }),
  )
  return candidates
    .filter((candidate): candidate is PriorObservationCandidate => candidate !== undefined)
    .sort((left, right) => right.modified_at_ms - left.modified_at_ms)
}

function sourceProofCorrectionGuidance(
  missing_proofs: readonly string[],
  pixel_trace_rejected: boolean,
): string {
  const missing_scale = missing_proofs.some((proof) =>
    [
      "oscilloscope_panels",
      "unique_printed_time_per_division",
      "unique_printed_voltage_per_division",
    ].includes(proof),
  )
  if (missing_scale) {
    return (
      "The exact crop does not expose one unambiguous printed scope scale. Do not tune axis values " +
      "to repair this. Extend the crop on whichever edge is needed until the complete Horizontal and Channel " +
      "scale controls are visible. Preserve every source-image position when moving the crop origin: for a new " +
      "crop.x_px, set every trace point and x-axis anchor to new pixel_x = old pixel_x + old crop.x_px - new " +
      "crop.x_px; apply the same formula to pixel_y, crop.y_px, and both y-axis anchors. Increase width/height " +
      "so the old crop remains fully contained. " +
      (pixel_trace_rejected
        ? "Because pixel verification also rejected this graph, retrace its response against the exact expanded crop instead of preserving rejected point positions. "
        : "Do not retrace. ") +
      "Do not change axis values, bindings, or already verified " +
      "graphs. Scale-match errors listed with a missing printed scale are downstream consequences and must not " +
      "be edited yet."
    )
  }
  const instructions: string[] = []
  if (missing_proofs.some((proof) => proof.includes("adjacent_figure_identity"))) {
    instructions.push(
      "Keep crop.x_px, crop.y_px, and existing crop-local coordinates fixed; extend only the bottom or right crop edge just far enough to include the graph's immediately adjacent printed figure caption.",
    )
  }
  if (missing_proofs.some((proof) => proof.includes("time_grid_and_anchor_alignment"))) {
    instructions.push(
      pixel_trace_rejected
        ? "After the response points pass pixel-trace verification, change only the x-axis anchor pixel coordinates to server-recognized grid lines; keep the crop origin fixed. The first x-axis anchor must stay at or before the earliest trace point so elapsed time remains nonnegative."
        : "Change only the x-axis anchor pixel coordinates to server-recognized grid lines; keep the crop origin and trace points fixed. The first x-axis anchor must stay at or before the earliest trace point so elapsed time remains nonnegative.",
    )
  }
  if (missing_proofs.some((proof) => proof.includes("voltage_grid_and_anchor_alignment"))) {
    instructions.push(
      pixel_trace_rejected
        ? "After the response points pass pixel-trace verification, change only the y-axis anchor pixel coordinates to server-recognized grid lines; keep the crop origin fixed."
        : "Change only the y-axis anchor pixel coordinates to server-recognized grid lines; keep the crop origin and trace points fixed.",
    )
  }
  if (missing_proofs.some((proof) => proof.includes("declared_time_scale_matches_source"))) {
    instructions.push(
      "Change the x-axis anchor values and x_range min/max together so they describe the printed time scale; do not change x-axis pixels. When server-required-x-anchor-value-span is reported, use that exact span instead of estimating it from rounded grid coordinates.",
    )
  }
  if (missing_proofs.some((proof) => proof.includes("declared_voltage_scale_matches_source"))) {
    instructions.push(
      "Change the y-axis anchor values and y_range min/max together so they describe the printed voltage scale; do not change y-axis pixels. When server-required-y-anchor-value-span is reported, use that exact span instead of estimating it from rounded grid coordinates.",
    )
  }
  if (missing_proofs.some((proof) => proof.includes("nominal_voltage_trace_baseline"))) {
    instructions.push(
      "Retrace the visible response at the graph edges so at least two of the first two and last two trace points lie on the same printed nominal-voltage baseline; do not move an edge point away from the rendered waveform.",
    )
  }
  return instructions.join(" ")
}

export function sourceProofRejectionDiagnostics(
  observation: ReferenceGraphObservation,
  proof: ReferenceGraphSourceProof,
  pixel_rejected_graph_ids: ReadonlySet<string> = new Set(),
): string[] {
  const proof_by_graph = new Map(proof.results.map((result) => [result.graph_id, result]))
  return eligibleObservedGraphs(observation).flatMap((graph) => {
    const result = proof_by_graph.get(graph.graph_id)
    if (result?.status === "verified") return []
    if (result?.status === "ineligible") {
      const missing = result.diagnostic.missing_proofs.join(", ")
      const recognized = result.diagnostic.recognized_measurements.join("; ")
      const guidance = sourceProofCorrectionGuidance(
        result.diagnostic.missing_proofs,
        pixel_rejected_graph_ids.has(graph.graph_id),
      )
      return [
        `${graph.graph_id}: ${result.reason}${missing ? ` Missing source proofs: ${missing}.` : ""}${
          recognized ? ` Server-recognized crop evidence: ${recognized}.` : ""
        }${guidance ? ` ${guidance}` : ""} Do not demote a printed graph merely to bypass source verification.`,
      ]
    }
    return [`${graph.graph_id}: no canonical PDF axis-calibration result was produced`]
  })
}

export function assertReferenceGraphObservationVerified(input: {
  observation: ReferenceGraphObservation
  source_proof: ReferenceGraphSourceProof
  pixel_rejection?: Error
}): void {
  const pixel_rejected_graph_ids =
    input.pixel_rejection instanceof ReferenceGraphPixelVerificationError
      ? new Set(input.pixel_rejection.failures.map(({ graph_id }) => graph_id))
      : new Set<string>()
  const diagnostics = [
    ...(input.pixel_rejection
      ? [
          `Reference curve pixels do not match the canonical datasheet render: ${input.pixel_rejection.message}`,
        ]
      : []),
    ...sourceProofRejectionDiagnostics(input.observation, input.source_proof, pixel_rejected_graph_ids),
  ]
  if (diagnostics.length > 0) {
    throw new Error(`Independent reference graph verification failed:\n${diagnostics.join("\n")}`)
  }
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
        stage_id: "find_reference_graphs",
        operation: "verify_reference_axis",
        hint: "Install and verify pdftoppm, pdftotext, and tesseract with English OCR data in the server runtime. This is an infrastructure failure, not an agent artifact rejection.",
        retryable: false,
      },
      { cause: error },
    )
  }
}

export async function findReferenceGraphs(input: {
  context: ModelPipelineContext
  services: ModelPipelineServices
  attempt_dir: string
  debug_dir: string
  signal: AbortSignal
  model_interface: ModelInterface
  application_fixture: ApplicationFixtureContract
}): Promise<FoundReferenceGraphInventory> {
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
    stage_id: "find_model_reference_graphs",
    phase_label: "Independent datasheet graph discovery",
    max_artifact_attempts: 4,
    signal,
    use_openai: context.use_openai,
    agent_client: services.agent_client,
    extensions: [extension],
    create_workspace: () =>
      createStageWorkspace({
        prefix: "model-reference-finder",
        files: [
          { source: join(context.model_dir, "AGENTS.md") },
          { source: datasheet_path, destination: "datasheet.pdf" },
          { source: join(context.model_dir, "model-interface.json") },
          { source: join(context.model_dir, "application-fixture-contract.json") },
          { source: time_graph_hints_path },
        ],
      }),
    build_prompt: (feedback) => buildFoundReferenceGraphObserverPrompt(feedback),
    heartbeat_paths: (workspace) => [join(workspace, "model-reference-observation.json")],
    on_output: logOutput,
    rejection_debug: {
      debug_dir: join(debug_dir, "reference-finder"),
      files: ["model-reference-observation.json"],
    },
    validate: async (workspace) =>
      parseFoundReferenceGraphObservation(
        await readBoundedJsonArtifact({
          path: join(workspace, "model-reference-observation.json"),
          max_bytes: 2 * 1024 * 1024,
          max_depth: 32,
          max_nodes: 20_000,
        }),
        time_graph_discovery,
        model_interface,
        application_fixture,
      ),
    promote: async (_workspace, observation) => {
      await writeJson(join(attempt_dir, "model-reference-observation.json"), observation)
    },
  })
  assertObserverFoundEligibleTimeDomainGraph(observer.value)
  return {
    time_graph_hints_path,
    observation: observer.value,
    observer_attempts: observer.attempts,
  }
}

export async function digitizeReferenceGraphs(input: {
  context: ModelPipelineContext
  services: ModelPipelineServices
  attempt_dir: string
  debug_dir: string
  signal: AbortSignal
  model_interface: ModelInterface
  application_fixture: ApplicationFixtureContract
  found_observation_path: string
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
    max_artifact_attempts: 8,
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
          { source: input.found_observation_path, destination: "model-reference-observation.json" },
        ],
      }),
    build_prompt: (feedback) => buildComparisonReferenceGraphObserverPrompt(feedback),
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
      let pixel_rejection: Error | undefined
      try {
        await verifyReferenceGraphObservationPixels({
          observation,
          datasheet_path,
          process_runner: services.process_runner,
          signal,
          on_output: logOutput,
        })
      } catch (error) {
        signal.throwIfAborted()
        pixel_rejection = error instanceof Error ? error : new Error(String(error))
      }
      const source_proof = await buildSourceProof({
        observation,
        datasheet_path,
        services,
        signal,
      })
      assertReferenceGraphObservationVerified({ observation, source_proof, pixel_rejection })
      return {
        observation,
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
