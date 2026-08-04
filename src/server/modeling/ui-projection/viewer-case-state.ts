import type { AnyCircuitElement } from "circuit-json"
import type { ModelManifest } from "@/shared/job-types"
import { isCircuitJson } from "../../component-circuit-json"
import type { ValidationCase, ValidationPlan } from "../../spice-validation"
import { assertValidationCircuitEmbedsModel } from "../component-integration"
import { type ViewerSimulationValidation, validateViewerSimulation } from "../viewer-simulation"
import { errorMessage } from "./shared"

/**
 * The one authoritative viewer outcome consumed by every UI projection for a
 * validation case. A complete waveform is exposed only by the matched and
 * mismatched variants; missing or partial builder output cannot be mistaken for
 * a successful tscircuit simulation.
 */
export type ViewerCaseState =
  | { kind: "not_required" }
  | { kind: "missing"; message: string }
  | { kind: "failed"; message: string; validation?: ViewerSimulationValidation }
  | { kind: "mismatched"; validation: ViewerSimulationValidation; message?: string }
  | { kind: "matched"; validation: ViewerSimulationValidation }

export type ViewerCaseStateByCase = Readonly<Record<string, ViewerCaseState | undefined>>

export function requiresViewerWaveform(validation_case: ValidationCase): boolean {
  return (
    validation_case.analysis.type === "transient" &&
    validation_case.observations.some(({ reference }) => reference.type === "curve")
  )
}

export const missingViewerWaveformMessage = (case_id: string): string =>
  `tscircuit did not produce the required transient waveform for case ${case_id}.`

function viewerValidationCompletenessIssue(
  validation_case: ValidationCase,
  validation: ViewerSimulationValidation,
): string | undefined {
  if (!validation.simulation_valid) {
    return (
      errorMessage(validation.errors) ??
      `tscircuit did not produce a complete transient waveform for case ${validation_case.id}`
    )
  }
  if (validation.errors.some(({ kind }) => kind !== "comparison")) {
    return `tscircuit viewer validation for case ${validation_case.id} contains non-comparison errors despite claiming a complete simulation`
  }
  const expected_ids = validation_case.observations.map(({ id }) => id)
  const series_ids = validation.series.map(({ observation_id }) => observation_id)
  if (
    series_ids.length !== expected_ids.length ||
    new Set(series_ids).size !== series_ids.length ||
    expected_ids.some((observation_id) => !series_ids.includes(observation_id))
  ) {
    return `tscircuit viewer validation for case ${validation_case.id} does not contain exactly one series for every planned observation`
  }
  if (validation.series.some(({ points }) => points.length < 2)) {
    return `tscircuit viewer validation for case ${validation_case.id} contains an incomplete waveform series`
  }
  const every_series_passed = validation.series.every(({ passed }) => passed)
  if (validation.passed !== every_series_passed) {
    return `tscircuit viewer validation for case ${validation_case.id} has inconsistent case and series pass states`
  }
  return undefined
}

/** Classifies raw builder output into the only viewer states the UI accepts. */
export function createViewerCaseState(input: {
  validation_case: ValidationCase
  validation?: ViewerSimulationValidation
  error?: string
  missing_message?: string
}): ViewerCaseState {
  if (!requiresViewerWaveform(input.validation_case)) return { kind: "not_required" }
  const retained_error = input.error?.trim()
  if (!input.validation) {
    return retained_error
      ? { kind: "failed", message: retained_error }
      : {
          kind: "missing",
          message: input.missing_message?.trim() || missingViewerWaveformMessage(input.validation_case.id),
        }
  }
  const completeness_issue = viewerValidationCompletenessIssue(input.validation_case, input.validation)
  if (completeness_issue) {
    return {
      kind: "failed",
      message: retained_error ? `${retained_error}; ${completeness_issue}` : completeness_issue,
      validation: input.validation,
    }
  }
  if (input.validation.passed) {
    return retained_error
      ? { kind: "failed", message: retained_error, validation: input.validation }
      : { kind: "matched", validation: input.validation }
  }
  return {
    kind: "mismatched",
    validation: input.validation,
    ...(retained_error ? { message: retained_error } : {}),
  }
}

export function normalizeViewerCaseState(
  validation_case: ValidationCase,
  state: ViewerCaseState | undefined,
): ViewerCaseState {
  if (!requiresViewerWaveform(validation_case)) return { kind: "not_required" }
  if (!state) return createViewerCaseState({ validation_case })
  if (state.kind === "not_required") {
    return {
      kind: "failed",
      message: `tscircuit viewer state for case ${validation_case.id} was incorrectly marked not_required`,
    }
  }
  if (state.kind === "missing") {
    return {
      kind: "missing",
      message: state.message.trim() || missingViewerWaveformMessage(validation_case.id),
    }
  }
  if (state.kind === "failed") {
    return {
      kind: "failed",
      message: state.message.trim() || `tscircuit viewer validation failed for case ${validation_case.id}`,
      ...(state.validation ? { validation: state.validation } : {}),
    }
  }
  const classified = createViewerCaseState({
    validation_case,
    validation: state.validation,
    ...(state.kind === "mismatched" && state.message ? { error: state.message } : {}),
  })
  if (classified.kind === state.kind) return classified
  return {
    kind: "failed",
    message: `tscircuit viewer state for case ${validation_case.id} claimed ${state.kind} but its validation payload is ${classified.kind}`,
    validation: state.validation,
  }
}

export function completeViewerValidation(state: ViewerCaseState): ViewerSimulationValidation | undefined {
  return state.kind === "matched" || state.kind === "mismatched" ? state.validation : undefined
}

export function viewerStateMessage(state: ViewerCaseState): string | undefined {
  if (state.kind === "missing" || state.kind === "failed") return state.message
  if (state.kind === "mismatched") {
    return (
      state.message ??
      errorMessage(state.validation.errors) ??
      "The completed tscircuit waveform did not match its datasheet reference."
    )
  }
  return undefined
}

export function resolveViewerCaseState(input: {
  validation_case: ValidationCase
  manifest: ModelManifest
  model_source: string
  circuit_json?: AnyCircuitElement[]
  circuit_build_error?: string
  authoritative: boolean
  provided_state?: ViewerCaseState
}): ViewerCaseState {
  if (!requiresViewerWaveform(input.validation_case)) return { kind: "not_required" }
  const build_error = input.circuit_build_error?.trim()
  if (build_error) {
    return {
      kind: "failed",
      message: `Circuit preview build failed: ${build_error}`,
    }
  }
  if (input.circuit_json) {
    try {
      assertValidationCircuitEmbedsModel(input.circuit_json, input.model_source, input.manifest)
    } catch (error) {
      return {
        kind: "failed",
        message: `viewer_model_provenance_failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  const circuit_json = isCircuitJson(input.circuit_json) ? input.circuit_json : undefined
  if (input.authoritative) {
    const state = normalizeViewerCaseState(
      input.validation_case,
      input.provided_state ??
        createViewerCaseState({
          validation_case: input.validation_case,
          missing_message: circuit_json
            ? "tscircuit viewer validation status was not retained for this Circuit JSON"
            : undefined,
        }),
    )
    const complete_validation = completeViewerValidation(state)
    if (complete_validation && !circuit_json) {
      return {
        kind: "failed",
        message: `tscircuit viewer validation for case ${input.validation_case.id} has no retained Circuit JSON`,
        validation: complete_validation,
      }
    }
    return state
  }
  if (!circuit_json) return createViewerCaseState({ validation_case: input.validation_case })
  return createViewerCaseState({
    validation_case: input.validation_case,
    validation: validateViewerSimulation({ validation_case: input.validation_case, circuit_json }),
  })
}

export function buildViewerCaseStates(input: {
  plan: ValidationPlan
  manifest: ModelManifest
  model_source: string
  circuit_json_by_case?: Readonly<Record<string, AnyCircuitElement[] | undefined>>
  circuit_build_errors_by_case?: Readonly<Record<string, string | undefined>>
  viewer_state_by_case?: ViewerCaseStateByCase
  viewer_validation_by_case?: Readonly<Record<string, ViewerSimulationValidation | undefined>>
  viewer_errors_by_case?: Readonly<Record<string, string | undefined>>
}): ViewerCaseStateByCase {
  const has_preclassified_state = input.viewer_state_by_case !== undefined
  const has_legacy_state =
    input.viewer_validation_by_case !== undefined || input.viewer_errors_by_case !== undefined
  if (has_preclassified_state && has_legacy_state) {
    throw new Error(
      "Model UI projection cannot combine viewer_state_by_case with legacy viewer validation maps",
    )
  }
  const authoritative = has_preclassified_state || has_legacy_state
  return Object.fromEntries(
    input.plan.cases.map((validation_case) => {
      const circuit_json = input.circuit_json_by_case?.[validation_case.id]
      const provided_state = has_preclassified_state
        ? input.viewer_state_by_case?.[validation_case.id]
        : has_legacy_state
          ? createViewerCaseState({
              validation_case,
              validation: input.viewer_validation_by_case?.[validation_case.id],
              error: input.viewer_errors_by_case?.[validation_case.id],
              missing_message: circuit_json
                ? "tscircuit viewer validation status was not retained for this Circuit JSON"
                : undefined,
            })
          : undefined
      return [
        validation_case.id,
        resolveViewerCaseState({
          validation_case,
          manifest: input.manifest,
          model_source: input.model_source,
          circuit_json,
          circuit_build_error: input.circuit_build_errors_by_case?.[validation_case.id],
          authoritative,
          provided_state,
        }),
      ]
    }),
  )
}
