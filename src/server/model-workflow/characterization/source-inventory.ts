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
  buildReferenceGraphObserverPrompt,
  eligibleObservedGraphs,
  parseCanonicalReferenceGraphObservation,
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
  readonly reused_from_invocation_id?: string
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

function sourceProofCorrectionGuidance(missing_proofs: readonly string[]): string {
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
      "to repair this. Keep crop.x_px and crop.y_px unchanged so every crop-local pixel remains valid; " +
      "extend only crop.width_px toward the page right edge, and crop.height_px downward only if needed, " +
      "until the complete Horizontal and Channel scale controls are visible. Preserve all trace points, " +
      "axis pixels, bindings, and already verified graphs. Scale-match errors listed with a missing printed " +
      "scale are downstream consequences and must not be edited yet."
    )
  }
  const instructions: string[] = []
  if (missing_proofs.some((proof) => proof.includes("grid_and_anchor_alignment"))) {
    instructions.push(
      "Change only the named axis anchor pixel coordinates to server-recognized grid lines; keep the crop origin and trace points fixed.",
    )
  }
  if (missing_proofs.some((proof) => proof.includes("declared_time_scale_matches_source"))) {
    instructions.push(
      "Change the x-axis anchor values and x_range min/max together so they describe the printed time scale; do not change x-axis pixels.",
    )
  }
  if (missing_proofs.some((proof) => proof.includes("declared_voltage_scale_matches_source"))) {
    instructions.push(
      "Change the y-axis anchor values and y_range min/max together so they describe the printed voltage scale; do not change y-axis pixels.",
    )
  }
  return instructions.join(" ")
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
      const recognized = result.diagnostic.recognized_measurements.join("; ")
      const guidance = sourceProofCorrectionGuidance(result.diagnostic.missing_proofs)
      return [
        `${graph.graph_id}: ${result.reason}${missing ? ` Missing source proofs: ${missing}.` : ""}${
          recognized ? ` Server-recognized crop evidence: ${recognized}.` : ""
        }${guidance ? ` ${guidance}` : ""} Do not demote a printed graph merely to bypass source verification.`,
      ]
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

  for (const candidate of await findPriorReferenceObservationCandidates({
    model_dir: context.model_dir,
    current_invocation_id: basename(attempt_dir),
  })) {
    signal.throwIfAborted()
    try {
      const observation = parseCanonicalReferenceGraphObservation(
        await readBoundedJsonArtifact({
          path: candidate.observation_path,
          max_bytes: 2 * 1024 * 1024,
          max_depth: 32,
          max_nodes: 20_000,
        }),
        time_graph_discovery,
        model_interface,
        application_fixture,
      )
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
        await logOutput(
          "system",
          `Reused graph curves are still an inspectable draft: ${error instanceof Error ? error.message : String(error)}\n`,
        )
      }
      const source_proof = await buildSourceProof({
        observation,
        datasheet_path,
        services,
        signal,
      })
      const source_rejections = sourceProofRejectionDiagnostics(observation, source_proof)
      if (source_rejections.length > 0) {
        await logOutput(
          "system",
          `Reused graph axes remain an inspectable draft:\n${source_rejections.join("\n")}\n`,
        )
      }
      assertObserverFoundEligibleTimeDomainGraph(observation)
      await writeJson(join(attempt_dir, "model-reference-observation.json"), observation)
      await writeJson(join(attempt_dir, "model-reference-source-proof.json"), source_proof)
      await logOutput(
        "system",
        `Reused graph inventory from invocation ${candidate.invocation_id} after rebuilding its current pixel and canonical-PDF diagnostics.\n`,
      )
      return {
        time_graph_hints_path,
        observation,
        source_proof,
        observer_attempts: 0,
        reused_from_invocation_id: candidate.invocation_id,
      }
    } catch (error) {
      signal.throwIfAborted()
      await logOutput(
        "system",
        `Skipped prior graph inventory ${candidate.invocation_id}: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
  }

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
      const source_rejections = sourceProofRejectionDiagnostics(observation, source_proof)
      if (pixel_rejection) {
        await logOutput(
          "system",
          `Reference curves are published as an inspectable draft while pixel alignment remains imperfect: ${pixel_rejection.message}\n`,
        )
      }
      if (source_rejections.length > 0) {
        await logOutput(
          "system",
          `Reference axes are published as an inspectable draft while OCR calibration remains imperfect:\n${source_rejections.join("\n")}\n`,
        )
      }
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
