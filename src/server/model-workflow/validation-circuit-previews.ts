import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import { isCircuitJson } from "../component-circuit-json"
import { createStageWorkspace } from "../infrastructure/artifacts"
import type { ProcessRunner } from "../infrastructure/process"
import type { CircuitBuildResult } from "../infrastructure/tscircuit"
import { buildTscircuitSource } from "../infrastructure/tscircuit"
import {
  assertValidationCircuitEmbedsModel,
  type GeneratedModel,
  getAnalogProjectionIssue,
  renderValidationCaseTsx,
} from "../modeling"
import { type ViewerSimulationValidation, validateViewerSimulation } from "../modeling/viewer-simulation"
import type { ValidationPlan } from "../spice-validation"

const MAX_CONCURRENT_PREVIEW_BUILDS = 3

function sanitizePreviewDiagnostic(message: string, workspace: string): string {
  return message
    .replaceAll(workspace, "<preview-workspace>")
    .replaceAll(workspace.replace(/^\/private/, ""), "<preview-workspace>")
    .slice(0, 8_000)
}

export interface ValidationCircuitPreviewBuild {
  circuit_json_by_case: Readonly<Record<string, AnyCircuitElement[] | undefined>>
  /** Only tsci/build failures that make the Circuit JSON unusable as a schematic. */
  circuit_build_errors_by_case: Readonly<Record<string, string | undefined>>
  /** All viewer acceptance failures, including an out-of-tolerance runnable waveform. */
  errors_by_case: Readonly<Record<string, string | undefined>>
  viewer_validation_by_case: Readonly<Record<string, ViewerSimulationValidation | undefined>>
  /** Viewer simulator failures caused by the candidate model, not TSX compilation or provenance. */
  viewer_model_errors_by_case: Readonly<Record<string, string | undefined>>
}

/** Raw tscircuit execution output. It deliberately contains no reference scoring. */
export interface TscircuitSimulationBuild {
  circuit_json_by_case: Readonly<Record<string, AnyCircuitElement[] | undefined>>
  /** TSX compilation or viewer infrastructure failures. */
  circuit_build_errors_by_case: Readonly<Record<string, string | undefined>>
  /** Simulator failures emitted by the candidate model inside otherwise valid Circuit JSON. */
  simulation_errors_by_case: Readonly<Record<string, string | undefined>>
}

export interface ViewerPreviewFailure {
  case_id: string
  message: string
}

export function getViewerPreviewFailures(build: ValidationCircuitPreviewBuild): ViewerPreviewFailure[] {
  return Object.entries(build.errors_by_case).flatMap(([case_id, message]) =>
    message ? [{ case_id, message }] : [],
  )
}

export function getViewerInfrastructureFailures(
  build: ValidationCircuitPreviewBuild,
): ViewerPreviewFailure[] {
  return getViewerPreviewFailures(build).filter(({ case_id }) => {
    if (build.viewer_model_errors_by_case[case_id]) return false
    const validation = build.viewer_validation_by_case[case_id]
    return !validation || validation.errors.some(({ kind }) => kind !== "comparison")
  })
}

export function partitionViewerBuildErrors(build: Pick<CircuitBuildResult, "errors" | "circuit_errors">): {
  infrastructure_errors: string[]
  model_simulation_errors: string[]
} {
  const model_simulation_errors = build.circuit_errors
    .filter(({ type }) => type.startsWith("simulation_") && type.endsWith("_error"))
    .map(({ diagnostic }) => diagnostic)
  const model_error_set = new Set(model_simulation_errors)
  return {
    infrastructure_errors: build.errors.filter((diagnostic) => !model_error_set.has(diagnostic)),
    model_simulation_errors,
  }
}

async function runOneTscircuitSimulation(input: {
  model_dir: string
  validation_case: ValidationPlan["cases"][number]
  generated: GeneratedModel
  source_dir?: string
  tsci_bin: string
  process_runner: ProcessRunner
  signal: AbortSignal
  append: (stream: "system" | "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<{
  case_id: string
  circuit_json?: AnyCircuitElement[]
  circuit_build_error?: string
  simulation_error?: string
}> {
  const case_id = input.validation_case.id
  const workspace = await createStageWorkspace({
    prefix: `model-preview-${case_id}`,
    files: [
      { source: join(input.model_dir, "package.json"), required: false },
      { source: join(input.model_dir, "tsconfig.json"), required: false },
      { source: join(input.model_dir, "tscircuit.config.json"), required: false },
      { source: join(input.model_dir, "tscircuit.config.ts"), required: false },
    ],
  })
  try {
    input.signal.throwIfAborted()
    const source_file = `${case_id}.circuit.tsx`
    const source = input.source_dir
      ? await readFile(join(input.source_dir, source_file), "utf8")
      : renderValidationCaseTsx({
          validation_case: input.validation_case,
          manifest: input.generated.manifest,
          model_source: input.generated.source,
          model_card: input.generated.card,
        })
    await Bun.write(join(workspace.path, source_file), source)
    await input.append("system", `Building validation TSX preview ${case_id}\n`)
    const build = await buildTscircuitSource({
      workspace: workspace.path,
      source_file,
      output_stem: case_id,
      tsci_bin: input.tsci_bin,
      process_runner: input.process_runner,
      signal: input.signal,
      build_args: ["--disable-pcb"],
      ignored_error_types: ["source_pin_must_be_connected_error"],
      on_output: (stream, message) => input.append(stream, message),
    })
    const { infrastructure_errors, model_simulation_errors } = partitionViewerBuildErrors(build)
    const error =
      infrastructure_errors.length > 0
        ? sanitizePreviewDiagnostic(infrastructure_errors.join("; "), workspace.path)
        : undefined
    if (error) await input.append("stderr", `Validation TSX preview ${case_id}: ${error}\n`)
    if (error) return { case_id, circuit_json: build.circuit_json, circuit_build_error: error }
    if (!isCircuitJson(build.circuit_json)) {
      const empty_error = "tsci produced no renderable Circuit JSON"
      await input.append("stderr", `Validation TSX preview ${case_id}: ${empty_error}\n`)
      return { case_id, circuit_build_error: empty_error }
    }
    if (model_simulation_errors.length > 0) {
      const viewer_model_error = sanitizePreviewDiagnostic(model_simulation_errors.join("; "), workspace.path)
      await input.append(
        "stderr",
        `Validation TSX preview ${case_id} model simulation failed: ${viewer_model_error}\n`,
      )
      return {
        case_id,
        circuit_json: build.circuit_json,
        simulation_error: viewer_model_error,
      }
    }
    await input.append("system", `Saved tscircuit simulation output ${case_id}\n`)
    return { case_id, circuit_json: build.circuit_json }
  } catch (error) {
    input.signal.throwIfAborted()
    const message = sanitizePreviewDiagnostic(
      error instanceof Error ? error.message : String(error),
      workspace.path,
    )
    await input.append("stderr", `Validation TSX preview ${case_id} could not be built: ${message}\n`)
    return { case_id, circuit_build_error: message }
  } finally {
    await workspace.dispose().catch(() => undefined)
  }
}

async function compareOneTscircuitSimulation(input: {
  validation_case: ValidationPlan["cases"][number]
  generated: GeneratedModel
  circuit_json?: AnyCircuitElement[]
  circuit_build_error?: string
  simulation_error?: string
  fixture_policy?: "exact" | "repairable"
  append: (stream: "system" | "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<{
  case_id: string
  circuit_json?: AnyCircuitElement[]
  error?: string
  circuit_build_error?: string
  viewer_validation?: ViewerSimulationValidation
  viewer_model_error?: string
}> {
  const case_id = input.validation_case.id
  if (input.circuit_build_error) {
    return {
      case_id,
      circuit_json: input.circuit_json,
      error: input.circuit_build_error,
      circuit_build_error: input.circuit_build_error,
    }
  }
  if (input.simulation_error) {
    return {
      case_id,
      circuit_json: input.circuit_json,
      error: input.simulation_error,
      viewer_model_error: input.simulation_error,
    }
  }
  if (!input.circuit_json) {
    return {
      case_id,
      error: "tsci produced no saved Circuit JSON",
      circuit_build_error: "tsci produced no saved Circuit JSON",
    }
  }
  try {
    assertValidationCircuitEmbedsModel(input.circuit_json, input.generated.source, input.generated.manifest)
  } catch (error) {
    const provenance_error = `viewer_model_provenance_failed: ${error instanceof Error ? error.message : String(error)}`
    await input.append("stderr", `Validation TSX preview ${case_id}: ${provenance_error}\n`)
    return { case_id, circuit_json: input.circuit_json, error: provenance_error }
  }
  const projection_issue = getAnalogProjectionIssue(input.validation_case)
  if (projection_issue) {
    const unsupported_error = `viewer_projection_unsupported: ${projection_issue}`
    await input.append(
      "stderr",
      `Validation TSX preview ${case_id} cannot produce a publishable graph: ${unsupported_error}\n`,
    )
    return { case_id, circuit_json: input.circuit_json, error: unsupported_error }
  }
  const viewer_validation = validateViewerSimulation({
    validation_case: input.validation_case,
    circuit_json: input.circuit_json,
    fixture_policy: input.fixture_policy,
  })
  if (!viewer_validation.passed) {
    const validation_error = viewer_validation.errors
      .map(({ code, message }) => `${code}: ${message}`)
      .join("; ")
    await input.append(
      "stderr",
      `Validation TSX preview ${case_id} does not match its reference: ${validation_error}\n`,
    )
    return { case_id, circuit_json: input.circuit_json, error: validation_error, viewer_validation }
  }
  await input.append(
    "system",
    `Compared tscircuit transient graph ${case_id} (${viewer_validation.series.map(({ points }) => points.length).join(", ")} samples)\n`,
  )
  return { case_id, circuit_json: input.circuit_json, viewer_validation }
}

export async function runValidationCircuitSimulations(input: {
  model_dir: string
  plan: ValidationPlan
  generated: GeneratedModel
  source_dir?: string
  tsci_bin: string
  process_runner: ProcessRunner
  signal: AbortSignal
  append: (stream: "system" | "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<TscircuitSimulationBuild> {
  const results: Array<Awaited<ReturnType<typeof runOneTscircuitSimulation>> | undefined> = new Array(
    input.plan.cases.length,
  )
  let next_index = 0
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_PREVIEW_BUILDS, input.plan.cases.length) },
    async () => {
      while (true) {
        const index = next_index
        next_index += 1
        const validation_case = input.plan.cases[index]
        if (!validation_case) return
        results[index] = await runOneTscircuitSimulation({ ...input, validation_case })
      }
    },
  )
  await Promise.all(workers)
  return {
    circuit_json_by_case: Object.fromEntries(
      results.flatMap((result) => (result ? [[result.case_id, result.circuit_json]] : [])),
    ),
    circuit_build_errors_by_case: Object.fromEntries(
      results.flatMap((result) => (result ? [[result.case_id, result.circuit_build_error]] : [])),
    ),
    simulation_errors_by_case: Object.fromEntries(
      results.flatMap((result) => (result ? [[result.case_id, result.simulation_error]] : [])),
    ),
  }
}

export async function compareValidationCircuitSimulations(input: {
  plan: ValidationPlan
  generated: GeneratedModel
  simulations: TscircuitSimulationBuild
  fixture_policy?: "exact" | "repairable"
  append: (stream: "system" | "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<ValidationCircuitPreviewBuild> {
  const results = await Promise.all(
    input.plan.cases.map((validation_case) =>
      compareOneTscircuitSimulation({
        validation_case,
        generated: input.generated,
        circuit_json: input.simulations.circuit_json_by_case[validation_case.id],
        circuit_build_error: input.simulations.circuit_build_errors_by_case[validation_case.id],
        simulation_error: input.simulations.simulation_errors_by_case[validation_case.id],
        fixture_policy: input.fixture_policy,
        append: input.append,
      }),
    ),
  )
  return {
    circuit_json_by_case: input.simulations.circuit_json_by_case,
    circuit_build_errors_by_case: input.simulations.circuit_build_errors_by_case,
    errors_by_case: Object.fromEntries(results.map((result) => [result.case_id, result.error])),
    viewer_validation_by_case: Object.fromEntries(
      results.map((result) => [result.case_id, result.viewer_validation]),
    ),
    viewer_model_errors_by_case: Object.fromEntries(
      results.map((result) => [result.case_id, result.viewer_model_error]),
    ),
  }
}

/** Builds and compares display Circuit JSON without exposing validation cases to the model agent. */
export async function buildValidationCircuitPreviews(input: {
  model_dir: string
  plan: ValidationPlan
  generated: GeneratedModel
  source_dir?: string
  tsci_bin: string
  process_runner: ProcessRunner
  signal: AbortSignal
  append: (stream: "system" | "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<ValidationCircuitPreviewBuild> {
  const simulations = await runValidationCircuitSimulations(input)
  return compareValidationCircuitSimulations({
    plan: input.plan,
    generated: input.generated,
    simulations,
    append: input.append,
  })
}
