/**
 * Stable public facade for independent datasheet reference-graph observation.
 * Parsing, fixture reconciliation, eligibility, verification, and prompting
 * live in cohesive modules under `reference-graph-observation/`.
 */
export {
  parseCanonicalFoundReferenceGraphObservation,
  parseCanonicalReferenceGraphObservation,
  parseFoundReferenceGraphObservation,
  parseReferenceGraphObservation,
} from "./reference-graph-observation/artifact"
export {
  eligibleObservedGraphs,
  foundObservedGraphs,
  projectReferenceGraphObservationForCharacterizer,
} from "./reference-graph-observation/eligibility"
export { verifyCharacterizationGraphEvidence } from "./reference-graph-observation/numeric-verification"
export {
  ReferenceGraphPixelVerificationError,
  verifyReferenceGraphObservationPixels,
  verifyReferenceGraphTracePixels,
} from "./reference-graph-observation/pixel-verification"
export type { ReferenceGraphPixelFailure } from "./reference-graph-observation/pixel-verification"
export {
  buildComparisonReferenceGraphObserverPrompt,
  buildFoundReferenceGraphObserverPrompt,
  buildReferenceGraphObserverPrompt,
} from "./reference-graph-observation/prompt"
export type {
  CharacterizerReferenceGraphObservation,
  ModelReferenceNumericVerification,
  ModelReferenceVerification,
  ObservedReferenceGraph,
  ObservedReferencePoint,
  ObservedVoltageTimeCurve,
  ReferenceGraphAxisAnchor,
  ReferenceGraphAxisCalibration,
  ReferenceGraphAxisRange,
  ReferenceGraphClassification,
  ReferenceGraphObservation,
  ReferenceGraphTraceColor,
} from "./reference-graph-observation/types"
