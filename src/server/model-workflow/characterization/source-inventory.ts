import { mkdir, readdir, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { runAgentArtifactStage } from "../../infrastructure/agent"
import { createStageWorkspace, readBoundedJsonArtifact } from "../../infrastructure/artifacts"
import { type ApplicationFixtureContract, type ModelInterface } from "../../modeling"
import { PipelineError } from "../../pipeline"
import type { JobLogStream } from "../../../shared/job-types"
import type { ModelPipelineContext, ModelPipelineServices } from "../types"
import { appendModelLog, writeJson } from "../stage-helpers"
import {
  analyzeReferenceGraphPreflight,
  buildReferenceGraphSourceProof,
  printedNominalSourcesByGraphId,
  type ReferenceGraphImmutableSourceAnalysis,
  type ReferenceGraphPreflight,
  type ReferenceGraphSourceProof,
} from "../reference-graph-axis-proof"
import { extractPdfTextBBox, figureIdentityFromPdfText } from "../reference-graph-axis-proof/pdf-extraction"
import {
  buildFoundReferenceGraphObserverPrompt,
  buildSingleComparisonReferenceGraphObserverPrompt,
  eligibleObservedChannels,
  eligibleObservedGraphs,
  foundObservedGraphs,
  parseFoundReferenceGraphObservation,
  parseCanonicalFoundReferenceGraphObservation,
  parseCanonicalReferenceGraphObservation,
  ReferenceGraphPixelVerificationError,
  type ReferenceGraphObservation,
  verifyReferenceGraphObservationPixels,
} from "../reference-graph-observation"
import {
  canonicalizeObservedGraphSource,
  sourceCalibrationIneligibilityReason,
} from "../reference-graph-observation/source-canonicalization"
import { isRecord, parseGraph } from "../reference-graph-observation/schema"
import { discoverTimeGraphHints } from "../time-graph-hints"
import { assertObserverFoundEligibleTimeDomainGraph } from "./eligibility"
import {
  MAX_CONCURRENT_REFERENCE_GRAPH_DIGITIZATIONS,
  runReferenceGraphWorkerPool,
} from "./reference-graph-worker-pool"

export interface ReferenceGraphInventory {
  readonly time_graph_hints_path: string
  readonly observation: ReferenceGraphObservation
  readonly source_proof: ReferenceGraphSourceProof
  readonly observer_attempts: number
  readonly reference_graph_count: number
  readonly reference_graph_concurrency: number
  readonly reference_graph_first_attempt_successes: number
  readonly reference_graph_retry_count: number
  readonly reference_graph_agent_duration_ms: number
  readonly reference_graph_preflight_duration_ms: number
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

function discoveryOnlyObservation(observation: ReferenceGraphObservation): ReferenceGraphObservation {
  return {
    ...observation,
    reviewed_hints: observation.reviewed_hints.map((entry) => ({ ...entry })),
    graphs: observation.graphs.map(({ electrical_binding: _binding, channels: _channels, ...graph }) => ({
      ...graph,
      crop: { ...graph.crop },
    })),
  }
}

export function assertComparisonGraphPreservesDiscovery(input: {
  source_pdf_sha256: string
  found_graph: ReferenceGraphObservation["graphs"][number]
  candidate_graph: ReferenceGraphObservation["graphs"][number]
}): void {
  const found_state = discoveryOnlyObservation({
    version: 1,
    source_pdf_sha256: input.source_pdf_sha256,
    reviewed_hints: [],
    graphs: [input.found_graph],
  })
  const candidate_state = discoveryOnlyObservation({
    version: 1,
    source_pdf_sha256: input.source_pdf_sha256,
    reviewed_hints: [],
    graphs: [input.candidate_graph],
  })
  if (JSON.stringify(found_state) !== JSON.stringify(candidate_state)) {
    throw new Error(
      `Create Comparison Graphs must preserve every discovery field of ${input.found_graph.graph_id}; only electrical_binding and channels may be added`,
    )
  }
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
        const observation_path = join(attempts_dir, entry.name, "found-reference-observation.json")
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
      "The exact immutable Find Reference Graphs crop does not yield one unambiguous printed scope scale. " +
      "Do not tune axis values, edit the crop, or change any other discovery field in Create Comparison Graphs. " +
      (pixel_trace_rejected
        ? "Fix only the independently reported trace-point failures inside the retained crop. "
        : "Preserve the traced channels. ") +
      "If the complete scale controls are genuinely absent, this comparison input cannot be completed and Find Reference Graphs must produce a new crop in a separate run. " +
      "Scale-match errors listed with a missing printed scale are downstream consequences and must not be edited."
    )
  }
  if (missing_proofs.some((proof) => proof.includes("adjacent_figure_identity"))) {
    return (
      "The exact immutable Find Reference Graphs crop does not include or immediately adjoin its own printed figure number/caption. " +
      "Do not edit the crop or any other discovery field in Create Comparison Graphs. " +
      "This comparison input cannot be completed; Find Reference Graphs must produce a complete crop in a separate run."
    )
  }
  const instructions: string[] = []
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
      "Change the x-axis anchor values and x_range min/max together so they describe the printed time scale; do not change x-axis pixels. When server-required-x-anchor-value-span is reported, use that exact span instead of estimating it from rounded grid coordinates. After changing the time calibration, recompute the electrical_binding stimulus PULSE delay, width, and period against the new nonnegative window: keep the printed first edge inside, place the second edge fully inside or hold it beyond the window, and keep the next period beyond the window.",
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
  const source_graph_id_by_channel_graph_id = new Map(
    eligibleObservedChannels(input.observation).map((channel) => [channel.graph_id, channel.source_graph_id]),
  )
  const pixel_rejected_graph_ids =
    input.pixel_rejection instanceof ReferenceGraphPixelVerificationError
      ? new Set(
          input.pixel_rejection.failures.map(
            ({ graph_id }) => source_graph_id_by_channel_graph_id.get(graph_id) ?? graph_id,
          ),
        )
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
  printed_nominal_sources_by_graph_id: Parameters<
    typeof buildReferenceGraphSourceProof
  >[0]["printed_nominal_sources_by_graph_id"]
  immutable_source_analysis_by_graph_id?: Readonly<Record<string, ReferenceGraphImmutableSourceAnalysis>>
}): Promise<ReferenceGraphSourceProof> {
  try {
    return await buildReferenceGraphSourceProof({
      observation: input.observation,
      datasheet_path: input.datasheet_path,
      process_runner: input.services.process_runner,
      signal: input.signal,
      printed_nominal_sources_by_graph_id: input.printed_nominal_sources_by_graph_id,
      immutable_source_analysis_by_graph_id: input.immutable_source_analysis_by_graph_id,
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

async function buildPreflight(input: {
  graph: Parameters<typeof analyzeReferenceGraphPreflight>[0]["graph"]
  source_pdf_sha256: string
  datasheet_path: string
  services: ModelPipelineServices
  signal: AbortSignal
  stage_id: "find_reference_graphs" | "create_comparison_graphs"
}) {
  try {
    return await analyzeReferenceGraphPreflight({
      graph: input.graph,
      source_pdf_sha256: input.source_pdf_sha256,
      datasheet_path: input.datasheet_path,
      process_runner: input.services.process_runner,
      signal: input.signal,
    })
  } catch (error) {
    input.signal.throwIfAborted()
    throw new PipelineError(
      {
        code: "reference_axis_infrastructure_failed",
        message: `Reference graph preflight could not run: ${error instanceof Error ? error.message : String(error)}`,
        stage_id: input.stage_id,
        operation: "preflight_reference_axis",
        hint: "Install and verify pdftoppm, pdftotext, and tesseract with English OCR data in the server runtime. Preflight failures are infrastructure failures, not agent artifact rejections.",
        retryable: false,
      },
      { cause: error },
    )
  }
}

export function referenceGraphDiscoveryPreflightErrors(preflight: ReferenceGraphPreflight): string[] {
  const errors: string[] = []
  if (!preflight.figure_identity) {
    errors.push("the immutable crop does not include or immediately adjoin its own printed figure identity")
  }
  if (
    preflight.x_axis.source_seconds_per_pixel_candidates.length === 0 &&
    preflight.x_axis.division_scale_candidates.length === 0 &&
    preflight.x_axis.explicit_tick_calibration === undefined
  ) {
    errors.push("the immutable crop has no unambiguous printed elapsed-time calibration")
  }
  if (
    preflight.y_axis.source_volts_per_pixel_candidates.length === 0 &&
    preflight.y_axis.division_scale_candidates.length === 0 &&
    preflight.y_axis.explicit_tick_calibration === undefined
  ) {
    errors.push("the immutable crop has no unambiguous printed voltage calibration")
  }
  return errors
}

interface FoundReferenceGraphPreflightFailure {
  graph_id: string
  errors: string[]
}

async function foundReferenceGraphPreflightFailures(input: {
  observation: ReferenceGraphObservation
  datasheet_path: string
  debug_dir: string
  services: ModelPipelineServices
  signal: AbortSignal
}): Promise<FoundReferenceGraphPreflightFailure[]> {
  const results = await runReferenceGraphWorkerPool({
    graphs: foundObservedGraphs(input.observation),
    signal: input.signal,
    digitize: async (graph, _graph_index, graph_signal) => {
      const preflight = await buildPreflight({
        graph,
        source_pdf_sha256: input.observation.source_pdf_sha256,
        datasheet_path: input.datasheet_path,
        services: input.services,
        signal: graph_signal,
        stage_id: "find_reference_graphs",
      })
      const errors = referenceGraphDiscoveryPreflightErrors(preflight.preflight)
      await mkdir(join(input.debug_dir, "reference-finder", "preflight"), { recursive: true })
      await writeJson(
        join(input.debug_dir, "reference-finder", "preflight", `${graph.graph_id}.json`),
        preflight.preflight,
      )
      return { graph_id: graph.graph_id, errors }
    },
  })
  return results.flatMap(({ graph_id, errors }) => (errors.length === 0 ? [] : [{ graph_id, errors }]))
}

function foundReferenceGraphPreflightError(failures: readonly FoundReferenceGraphPreflightFailure[]): Error {
  const diagnostics = failures.map(({ graph_id, errors }) => `${graph_id}: ${errors.join("; ")}`)
  throw new Error(
    "Find Reference Graphs marked crop(s) usable before their immutable source calibration was complete:\n" +
      `${diagnostics.join("\n")}\n` +
      "Adjust each named crop to include the complete plot, time and voltage scales, scope controls, and its own caption. If the source figure itself lacks either numeric calibration, mark it fixture_reproducible:false. Create Comparison Graphs cannot repair a Find-stage crop.",
  )
}

function retainCalibrationFailuresAsReferences(input: {
  observation: ReferenceGraphObservation
  failures: readonly FoundReferenceGraphPreflightFailure[]
}): ReferenceGraphObservation {
  return {
    ...input.observation,
    graphs: input.observation.graphs.map((graph) => {
      const failure = input.failures.find(({ graph_id }) => graph_id === graph.graph_id)
      if (!failure) return graph
      const { electrical_binding: _binding, channels: _channels, ...found } = graph
      return {
        ...found,
        fixture_reproducible: false,
        reason: sourceCalibrationIneligibilityReason(failure.errors),
      }
    }),
  }
}

export async function findReferenceGraphs(input: {
  context: ModelPipelineContext
  services: ModelPipelineServices
  attempt_dir: string
  debug_dir: string
  signal: AbortSignal
}): Promise<FoundReferenceGraphInventory> {
  const { context, services, attempt_dir, debug_dir, signal } = input
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
    validate: async (workspace, attempt) => {
      const observation = parseFoundReferenceGraphObservation(
        await readBoundedJsonArtifact({
          path: join(workspace, "model-reference-observation.json"),
          max_bytes: 2 * 1024 * 1024,
          max_depth: 32,
          max_nodes: 20_000,
        }),
        time_graph_discovery,
      )
      await assertFoundReferenceGraphCaptions({
        observation,
        workspace,
        process_runner: services.process_runner,
        signal,
      })
      const preflight_failures = await foundReferenceGraphPreflightFailures({
        observation,
        datasheet_path: join(workspace, "datasheet.pdf"),
        debug_dir,
        services,
        signal,
      })
      if (preflight_failures.length === 0) return observation
      if (attempt < 4) throw foundReferenceGraphPreflightError(preflight_failures)
      return retainCalibrationFailuresAsReferences({ observation, failures: preflight_failures })
    },
    promote: async (_workspace, observation) => {
      await writeJson(join(attempt_dir, "found-reference-observation.json"), observation)
    },
  })
  assertObserverFoundEligibleTimeDomainGraph(observer.value)
  return {
    time_graph_hints_path,
    observation: observer.value,
    observer_attempts: observer.attempts,
  }
}

export async function assertFoundReferenceGraphCaptions(input: {
  observation: ReferenceGraphObservation
  workspace: string
  process_runner: ModelPipelineServices["process_runner"]
  signal: AbortSignal
}): Promise<void> {
  const bbox_by_page = new Map<number, string>()
  const incomplete_graph_ids: string[] = []
  for (const graph of foundObservedGraphs(input.observation)) {
    input.signal.throwIfAborted()
    let bbox_html = bbox_by_page.get(graph.page)
    if (!bbox_html) {
      bbox_html = await extractPdfTextBBox({
        graph,
        workspace: input.workspace,
        process_runner: input.process_runner,
        signal: input.signal,
      })
      bbox_by_page.set(graph.page, bbox_html)
    }
    if (!figureIdentityFromPdfText({ graph, bbox_html })) incomplete_graph_ids.push(graph.graph_id)
  }
  if (incomplete_graph_ids.length === 0) return
  throw new Error(
    `Find Reference Graphs produced ${incomplete_graph_ids.length} crop(s) without their own adjacent printed figure number/caption: ${incomplete_graph_ids.join(
      ", ",
    )}. Adjust only those named crop rectangles so each contains the complete plot, axes, scope controls, and its own caption without a neighboring figure.`,
  )
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
  const immutable_found_observation = parseCanonicalFoundReferenceGraphObservation(
    await readBoundedJsonArtifact({
      path: input.found_observation_path,
      max_bytes: 2 * 1024 * 1024,
      max_depth: 32,
      max_nodes: 20_000,
    }),
    time_graph_discovery,
    model_interface,
    application_fixture,
  )

  const graph_hints = new Map<string, typeof time_graph_discovery.hints>()
  for (const review of immutable_found_observation.reviewed_hints) {
    if (review.disposition !== "graph" || !review.graph_id) continue
    const hint = time_graph_discovery.hints.find(({ hint_id }) => hint_id === review.hint_id)
    if (!hint) continue
    const hints = graph_hints.get(review.graph_id) ?? []
    hints.push(hint)
    graph_hints.set(review.graph_id, hints)
  }

  const printed_nominal_sources_by_graph_id = printedNominalSourcesByGraphId({
    observation: immutable_found_observation,
    discovery: time_graph_discovery,
  })
  const found_graphs = foundObservedGraphs(immutable_found_observation)
  const graph_results = await runReferenceGraphWorkerPool({
    graphs: found_graphs,
    signal,
    digitize: async (found_graph, graph_index, graph_signal) => {
      graph_signal.throwIfAborted()
      const seed_path = join(attempt_dir, `comparison-seed-${found_graph.graph_id}.json`)
      const reference_image_path = join(attempt_dir, "evidence", "figures", `${found_graph.graph_id}.png`)
      const graphLogOutput = (stream: JobLogStream, message: string) =>
        logOutput(stream, `[reference graph ${found_graph.graph_id}] ${message}`)
      const graph_debug_dir = join(debug_dir, "reference-observer", found_graph.graph_id)
      const preflight_path = join(graph_debug_dir, "preflight.json")
      const preflight_started_at = Date.now()
      await graphLogOutput("system", "Running deterministic source calibration preflight.\n")
      const preflight = await buildPreflight({
        graph: found_graph,
        source_pdf_sha256: immutable_found_observation.source_pdf_sha256,
        datasheet_path,
        services,
        signal: graph_signal,
        stage_id: "create_comparison_graphs",
      })
      const preflight_duration_ms = Date.now() - preflight_started_at
      graph_signal.throwIfAborted()
      await mkdir(graph_debug_dir, { recursive: true })
      await Promise.all([writeJson(seed_path, found_graph), writeJson(preflight_path, preflight.preflight)])
      const graph_observer = await runAgentArtifactStage<{
        graph: ReferenceGraphObservation["graphs"][number]
        source_proof: ReferenceGraphSourceProof
      }>({
        stage_id: `verify_model_reference_graph_${found_graph.graph_id}`,
        phase_label: `Digitize reference graph ${found_graph.graph_id}`,
        max_artifact_attempts: 8,
        signal: graph_signal,
        use_openai: context.use_openai,
        agent_client: services.agent_client,
        extensions: [extension],
        create_workspace: () =>
          createStageWorkspace({
            prefix: `model-reference-${found_graph.graph_id}`,
            files: [
              { source: join(context.model_dir, "AGENTS.md") },
              { source: datasheet_path, destination: "datasheet.pdf" },
              { source: join(context.model_dir, "model-interface.json") },
              {
                source: join(context.model_dir, "application-fixture-contract.json"),
              },
              { source: time_graph_hints_path },
              { source: seed_path, destination: "model-reference-graph.json" },
              {
                source: reference_image_path,
                destination: "reference-graph.png",
              },
              {
                source: preflight_path,
                destination: "reference-graph-preflight.json",
              },
            ],
          }),
        build_prompt: (feedback) =>
          buildSingleComparisonReferenceGraphObserverPrompt(found_graph.graph_id, feedback),
        heartbeat_paths: (workspace) => [join(workspace, "model-reference-graph.json")],
        on_output: graphLogOutput,
        rejection_debug: {
          debug_dir: graph_debug_dir,
          files: ["model-reference-graph.json"],
        },
        validate: async (workspace) => {
          const raw_graph = await readBoundedJsonArtifact({
            path: join(workspace, "model-reference-graph.json"),
            max_bytes: 512 * 1024,
            max_depth: 32,
            max_nodes: 12_000,
          })
          if (!isRecord(raw_graph) || raw_graph.graph_id !== found_graph.graph_id) {
            throw new Error(
              `model-reference-graph.json must remain the one graph object ${found_graph.graph_id}`,
            )
          }
          const parsed_graph = parseGraph(
            raw_graph,
            graph_index,
            model_interface,
            "pixels_only",
            "comparison",
          )
          const graph = canonicalizeObservedGraphSource({
            graph: parsed_graph,
            source_hints: graph_hints.get(found_graph.graph_id) ?? [],
            model_interface,
            application_fixture,
            phase: "comparison",
          })
          assertComparisonGraphPreservesDiscovery({
            source_pdf_sha256: immutable_found_observation.source_pdf_sha256,
            found_graph,
            candidate_graph: graph,
          })
          const observation: ReferenceGraphObservation = {
            version: 1,
            source_pdf_sha256: immutable_found_observation.source_pdf_sha256,
            reviewed_hints: [],
            graphs: [graph],
          }
          let pixel_rejection: Error | undefined
          try {
            await verifyReferenceGraphObservationPixels({
              observation,
              datasheet_path,
              process_runner: services.process_runner,
              signal: graph_signal,
              on_output: graphLogOutput,
            })
          } catch (error) {
            graph_signal.throwIfAborted()
            pixel_rejection = error instanceof Error ? error : new Error(String(error))
          }
          const source_proof = await buildSourceProof({
            observation,
            datasheet_path,
            services,
            signal: graph_signal,
            printed_nominal_sources_by_graph_id,
            immutable_source_analysis_by_graph_id: {
              [found_graph.graph_id]: preflight.source_analysis,
            },
          })
          assertReferenceGraphObservationVerified({
            observation,
            source_proof,
            pixel_rejection,
          })
          return { graph, source_proof }
        },
        promote: async () => undefined,
      })
      return {
        graph_id: found_graph.graph_id,
        graph: graph_observer.value.graph,
        source_proof: graph_observer.value.source_proof,
        attempts: graph_observer.attempts,
        agent_duration_ms: graph_observer.agent_duration_ms,
        preflight_duration_ms,
      }
    },
  })

  const completed_graphs = new Map(graph_results.map((result) => [result.graph_id, result.graph]))
  const proof_results = graph_results.flatMap((result) => result.source_proof.results)
  const observer_attempts = graph_results.reduce((sum, result) => sum + result.attempts, 0)
  const reference_graph_first_attempt_successes = graph_results.filter(
    ({ attempts }) => attempts === 1,
  ).length
  const reference_graph_retry_count = observer_attempts - graph_results.length
  const reference_graph_agent_duration_ms = graph_results.reduce(
    (sum, result) => sum + result.agent_duration_ms,
    0,
  )
  const reference_graph_preflight_duration_ms = graph_results.reduce(
    (sum, result) => sum + result.preflight_duration_ms,
    0,
  )

  const combined_observation = parseCanonicalReferenceGraphObservation(
    {
      ...immutable_found_observation,
      graphs: immutable_found_observation.graphs.map(
        (graph) => completed_graphs.get(graph.graph_id) ?? graph,
      ),
    },
    time_graph_discovery,
    model_interface,
    application_fixture,
  )
  const source_proof: ReferenceGraphSourceProof = {
    version: 1,
    source_pdf_sha256: combined_observation.source_pdf_sha256,
    results: proof_results,
  }
  signal.throwIfAborted()
  await Promise.all([
    writeJson(join(attempt_dir, "model-reference-observation.json"), combined_observation),
    writeJson(join(attempt_dir, "model-reference-source-proof.json"), source_proof),
  ])
  assertObserverFoundEligibleTimeDomainGraph(combined_observation)
  return {
    time_graph_hints_path,
    observation: combined_observation,
    source_proof,
    observer_attempts,
    reference_graph_count: found_graphs.length,
    reference_graph_concurrency: Math.min(found_graphs.length, MAX_CONCURRENT_REFERENCE_GRAPH_DIGITIZATIONS),
    reference_graph_first_attempt_successes,
    reference_graph_retry_count,
    reference_graph_agent_duration_ms,
    reference_graph_preflight_duration_ms,
  }
}
