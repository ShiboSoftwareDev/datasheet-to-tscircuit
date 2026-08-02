import type { AnyCircuitElement } from "circuit-json"
import { join } from "node:path"
import { isCircuitJson } from "../component-circuit-json"
import { createStageWorkspace } from "../infrastructure/artifacts"
import type { ProcessRunner } from "../infrastructure/process"
import { buildTscircuitSource } from "../infrastructure/tscircuit"
import {
  assertValidationCircuitEmbedsModel,
  getAnalogProjectionIssue,
  renderValidationCaseTsx,
  type GeneratedModel,
} from "../modeling"
import { validateViewerSimulation, type ViewerSimulationValidation } from "../modeling/viewer-simulation"
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
    const validation = build.viewer_validation_by_case[case_id]
    return !validation || validation.errors.some(({ kind }) => kind !== "comparison")
  })
}

async function buildOnePreview(input: {
  model_dir: string
  validation_case: ValidationPlan["cases"][number]
  generated: GeneratedModel
  tsci_bin: string
  process_runner: ProcessRunner
  signal: AbortSignal
  append: (stream: "system" | "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<{
  case_id: string
  circuit_json?: AnyCircuitElement[]
  error?: string
  circuit_build_error?: string
  viewer_validation?: ViewerSimulationValidation
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
    await Bun.write(
      join(workspace.path, source_file),
      renderValidationCaseTsx({
        validation_case: input.validation_case,
        manifest: input.generated.manifest,
        model_source: input.generated.source,
        model_card: input.generated.card,
      }),
    )
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
    const error =
      build.errors.length > 0 ? sanitizePreviewDiagnostic(build.errors.join("; "), workspace.path) : undefined
    if (error) await input.append("stderr", `Validation TSX preview ${case_id}: ${error}\n`)
    if (error) return { case_id, error, circuit_build_error: error }
    if (!isCircuitJson(build.circuit_json)) {
      const empty_error = "tsci produced no renderable Circuit JSON"
      await input.append("stderr", `Validation TSX preview ${case_id}: ${empty_error}\n`)
      return { case_id, error: empty_error, circuit_build_error: empty_error }
    }
    try {
      assertValidationCircuitEmbedsModel(build.circuit_json, input.generated.source, input.generated.manifest)
    } catch (error) {
      const provenance_error = `viewer_model_provenance_failed: ${error instanceof Error ? error.message : String(error)}`
      await input.append("stderr", `Validation TSX preview ${case_id}: ${provenance_error}\n`)
      return { case_id, circuit_json: build.circuit_json, error: provenance_error }
    }
    const projection_issue = getAnalogProjectionIssue(input.validation_case)
    if (projection_issue) {
      const unsupported_error = `viewer_projection_unsupported: ${projection_issue}`
      await input.append(
        "stderr",
        `Validation TSX preview ${case_id} cannot produce a publishable graph: ${unsupported_error}\n`,
      )
      return { case_id, circuit_json: build.circuit_json, error: unsupported_error }
    }
    const viewer_validation = validateViewerSimulation({
      validation_case: input.validation_case,
      circuit_json: build.circuit_json,
    })
    if (!viewer_validation.passed) {
      const validation_error = viewer_validation.errors
        .map(({ code, message }) => `${code}: ${message}`)
        .join("; ")
      await input.append(
        "stderr",
        `Validation TSX preview ${case_id} is not a publishable time-domain simulation: ${validation_error}\n`,
      )
      return { case_id, circuit_json: build.circuit_json, error: validation_error, viewer_validation }
    }
    await input.append(
      "system",
      `Validated tscircuit transient graph ${case_id} (${viewer_validation.series.map(({ points }) => points.length).join(", ")} samples)\n`,
    )
    return { case_id, circuit_json: build.circuit_json, viewer_validation }
  } catch (error) {
    input.signal.throwIfAborted()
    const message = sanitizePreviewDiagnostic(
      error instanceof Error ? error.message : String(error),
      workspace.path,
    )
    await input.append("stderr", `Validation TSX preview ${case_id} could not be built: ${message}\n`)
    return { case_id, error: message, circuit_build_error: message }
  } finally {
    await workspace.dispose().catch(() => undefined)
  }
}

/** Builds display-only schematic Circuit JSON without exposing validation cases to the model agent. */
export async function buildValidationCircuitPreviews(input: {
  model_dir: string
  plan: ValidationPlan
  generated: GeneratedModel
  tsci_bin: string
  process_runner: ProcessRunner
  signal: AbortSignal
  append: (stream: "system" | "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<ValidationCircuitPreviewBuild> {
  const results: Array<Awaited<ReturnType<typeof buildOnePreview>> | undefined> = new Array(
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
        results[index] = await buildOnePreview({ ...input, validation_case })
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
    errors_by_case: Object.fromEntries(
      results.flatMap((result) => (result ? [[result.case_id, result.error]] : [])),
    ),
    viewer_validation_by_case: Object.fromEntries(
      results.flatMap((result) => (result ? [[result.case_id, result.viewer_validation]] : [])),
    ),
  }
}
