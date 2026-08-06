/** Stable public facade for model UI projection. */
export { projectModelCircuitPreview } from "./ui-projection/circuit-preview"
export { compactModelPreviewCircuitJson } from "./ui-projection/graph-compaction"
export {
  projectModelPreviewOptions,
  projectModelUi,
} from "./ui-projection/project-model-ui"
export {
  projectReferenceComparisonDraft,
  projectModelReferencePreview,
} from "./ui-projection/reference-preview"
export type { ModelUiProjection, ModelUiProjectionInput } from "./ui-projection/types"
export { projectModelValidationSummary } from "./ui-projection/validation-summary"
export {
  getAnalogProjectionIssue,
  renderValidationCaseTsx,
} from "./ui-projection/validation-tsx"
export {
  createViewerCaseState,
  type ViewerCaseState,
  type ViewerCaseStateByCase,
} from "./ui-projection/viewer-case-state"
