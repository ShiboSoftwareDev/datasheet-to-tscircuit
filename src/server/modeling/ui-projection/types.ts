import type { AnyCircuitElement } from "circuit-json"
import type {
  ModelManifest,
  ModelPreviewOption,
  ModelSelectedPreview,
  ModelValidationSummary,
} from "@/shared/job-types"
import type { ValidationPlan, ValidationRunResult } from "../../spice-validation"
import type { ModelContract } from "../types"
import type { ViewerSimulationValidation } from "../viewer-simulation"
import type { ViewerCaseStateByCase } from "./viewer-case-state"

export interface ModelUiProjectionInput {
  plan: ValidationPlan
  result: ValidationRunResult
  manifest: ModelManifest
  model_source: string
  model_card: string
  updated_at: string
  circuit_json_by_case?: Readonly<Record<string, AnyCircuitElement[] | undefined>>
  circuit_build_errors_by_case?: Readonly<Record<string, string | undefined>>
  /** Preferred builder-owned state. An empty map is authoritative and fails closed. */
  viewer_state_by_case?: ViewerCaseStateByCase
  /** @deprecated Compatibility input normalized once into viewer_state_by_case. */
  viewer_validation_by_case?: Readonly<Record<string, ViewerSimulationValidation | undefined>>
  /** @deprecated Compatibility input normalized once into viewer_state_by_case. */
  viewer_errors_by_case?: Readonly<Record<string, string | undefined>>
  contract?: ModelContract
  validation_artifact_state?: "candidate" | "accepted"
  preview_generation?: string
}

export interface ModelUiProjection {
  validation: ModelValidationSummary
  preview_options: ModelPreviewOption[]
  selected_previews: Readonly<Record<string, ModelSelectedPreview>>
}
