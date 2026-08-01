import type { AnyCircuitElement } from "circuit-json"
import type { ModelCircuitPreview, ModelManifest } from "@/shared/job-types"
import { isCircuitJson } from "../../component-circuit-json"
import type { ValidationCase } from "../../spice-validation"
import { compactModelPreviewCircuitJson } from "./graph-compaction"
import { getAnalogProjectionIssue, renderValidationCaseTsx } from "./validation-tsx"
import {
  completeViewerValidation,
  resolveViewerCaseState,
  type ViewerCaseState,
  viewerStateMessage,
} from "./viewer-case-state"

export function projectModelCircuitPreview(input: {
  validation_case: ValidationCase
  manifest: ModelManifest
  model_source: string
  model_card: string
  updated_at: string
  circuit_json?: AnyCircuitElement[]
  circuit_build_error?: string
  viewer_state?: ViewerCaseState
}): ModelCircuitPreview {
  const projection_issue = getAnalogProjectionIssue(input.validation_case)
  // Unsupported in-browser analog analysis must not suppress a valid
  // schematic/Code snapshot. Server ngspice results remain authoritative.
  const circuit_json = input.circuit_build_error
    ? undefined
    : isCircuitJson(input.circuit_json)
      ? input.circuit_json
      : undefined
  const build_error = input.circuit_build_error?.trim()
  const viewer_state = resolveViewerCaseState({
    validation_case: input.validation_case,
    manifest: input.manifest,
    model_source: input.model_source,
    circuit_json: input.circuit_json,
    circuit_build_error: input.circuit_build_error,
    authoritative: input.viewer_state !== undefined,
    provided_state: input.viewer_state,
  })
  const viewer_validation = completeViewerValidation(viewer_state)
  const viewer_error = viewerStateMessage(viewer_state)
  const has_transient_output = viewer_validation?.simulation_valid ?? false
  const analog_simulation_status = build_error
    ? "failed"
    : projection_issue
      ? "unsupported"
      : viewer_error && !has_transient_output
        ? "failed"
        : has_transient_output
          ? "available"
          : circuit_json
            ? "failed"
            : undefined
  const preview_circuit_json = circuit_json ? compactModelPreviewCircuitJson(circuit_json) : undefined
  return {
    source_file: `validation/cases/${input.validation_case.id}.circuit.tsx`,
    code: renderValidationCaseTsx(input),
    build_status: build_error ? "failed" : circuit_json ? "ready" : "source_ready",
    updated_at: input.updated_at,
    circuit_json: preview_circuit_json,
    analysis_type: input.validation_case.analysis.type,
    analog_simulation_status,
    snapshot_origin: circuit_json ? "server_validation" : undefined,
    is_stale: false,
    error_message: build_error
      ? `Circuit preview build failed: ${build_error}`
      : projection_issue
        ? `Analog preview is source-only: ${projection_issue}. The server validation result remains authoritative.`
        : viewer_error && !has_transient_output
          ? `Circuit preview viewer validation failed: ${viewer_error}`
          : circuit_json && !has_transient_output
            ? `Circuit preview is not a publishable transient simulation: ${
                viewer_validation?.errors.map(({ code, message }) => `${code}: ${message}`).join("; ") ??
                "no completed waveform was produced"
              }`
            : input.circuit_json && !circuit_json
              ? "Circuit preview build produced no renderable Circuit JSON; benchmark TSX remains available."
              : undefined,
  }
}
