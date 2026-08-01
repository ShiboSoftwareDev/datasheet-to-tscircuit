export {
  assertCircuitEmbedsModel,
  createIntegratedComponentSource,
  writeIntegratedComponent,
} from "./component-integration"
export { createModelManifest, readGeneratedModel, validateModelSource } from "./model-artifacts"
export {
  requireModelCompletionIntegrity,
  validateModelCompletionIntegrity,
  type ModelCompletionIntegrity,
  type ModelCompletionIntegrityInput,
} from "./model-completion-integrity"
export { modelCheckpointRequiresPublicationPointer } from "./model-publication-checkpoint"
export { createModelInterface } from "./model-interface"
export {
  createModelTrainingContract,
  MIN_FRESH_REFERENCE_CURVE_POINTS,
  partitionReferenceCurvePoints,
  type ReferenceCurvePartition,
} from "./model-training-contract"
export {
  commitModelPublication,
  MODEL_PUBLICATION_FILE,
  readModelPublication,
  readVerifiedPublicationArtifact,
  resolveAcceptedModelPublication,
  validateResolvedModelPublication,
  writePublicationBundleManifest,
  type ModelPublicationCommit,
  type ModelPublicationBundle,
  type ModelPublicationRecord,
  type PublicationBundleManifest,
  type ResolvedModelPublication,
} from "./model-publication"
export { parseModelCharacterization } from "./parse-model-characterization"
export { parseModelContract, parseModelInterface } from "./parse-model-contract"
export {
  buildCharacterizationPrompt,
  buildModelGenerationPrompt,
  buildValidationPlanPrompt,
} from "./prompts"
export { type ModelStrategy, ModelStrategyRegistry } from "./strategy-registry"
export type * from "./types"
export {
  type ModelUiProjection,
  type ModelUiProjectionInput,
  projectModelCircuitPreview,
  projectModelPreviewOptions,
  projectModelReferencePreview,
  projectModelUi,
  projectModelValidationSummary,
  renderValidationCaseTsx,
} from "./ui-projection"
export { loadStoredModelPreview } from "./ui-projection-storage"
export { buildValidationPlanGuide } from "./validation-plan-guide"
export {
  prepareModelWorkspace,
  readModelContract,
  writeModelContract,
} from "./workspace"
