import type { ModelPreviewOption } from "@/shared/job-types"
import type { ValidationPlan, ValidationRunResult } from "../../spice-validation"
import { projectModelCircuitPreview } from "./circuit-preview"
import { projectModelReferencePreview } from "./reference-preview"
import { titleFromIdentifier } from "./shared"
import type { ModelUiProjection, ModelUiProjectionInput } from "./types"
import { projectModelValidationSummary } from "./validation-summary"
import { buildViewerCaseStates, normalizeViewerCaseState } from "./viewer-case-state"

export function projectModelPreviewOptions(
  plan: ValidationPlan,
  result?: ValidationRunResult,
): ModelPreviewOption[] {
  const completed_cases = new Set(result?.cases.map(({ case_id }) => case_id) ?? [])
  return plan.cases.map((validation_case) => ({
    benchmark_id: validation_case.id,
    title: validation_case.title ?? titleFromIdentifier(validation_case.id),
    circuit_file: `validation/cases/${validation_case.id}.circuit.tsx`,
    reference_file:
      validation_case.observations.find(({ evidence }) => evidence?.image)?.evidence?.image ??
      "validation-plan.json",
    result_file: completed_cases.has(validation_case.id) ? "validation-results.json" : undefined,
  }))
}

export function projectModelUi(input: ModelUiProjectionInput): ModelUiProjection {
  const viewer_state_by_case = buildViewerCaseStates(input)
  const selected_previews = Object.fromEntries(
    input.plan.cases.map((validation_case) => {
      const circuit_json = input.circuit_json_by_case?.[validation_case.id]
      const viewer_state = normalizeViewerCaseState(validation_case, viewer_state_by_case[validation_case.id])
      return [
        validation_case.id,
        {
          ...(input.preview_generation
            ? {
                artifact_identity: {
                  preview_generation: input.preview_generation,
                  model_revision: input.manifest.revision,
                },
              }
            : {}),
          circuit_preview: projectModelCircuitPreview({
            validation_case,
            manifest: input.manifest,
            model_source: input.model_source,
            model_card: input.model_card,
            updated_at: input.updated_at,
            circuit_json,
            circuit_build_error: input.circuit_build_errors_by_case?.[validation_case.id],
            viewer_state,
          }),
          reference_preview: projectModelReferencePreview({
            validation_case,
            result: input.result,
            updated_at: input.updated_at,
            viewer_state,
          }),
        },
      ]
    }),
  )
  return {
    validation: {
      ...projectModelValidationSummary(input.plan, input.result, input.contract, viewer_state_by_case),
      artifact_state: input.validation_artifact_state ?? "candidate",
      model_revision: input.manifest.revision,
      ...(input.preview_generation ? { preview_generation: input.preview_generation } : {}),
    },
    preview_options: projectModelPreviewOptions(input.plan, input.result),
    selected_previews,
  }
}
