/**
 * Stable public facade for canonical-PDF reference graph axis proof.
 * Source extraction, calibration strategies, parsing, and eligibility live in
 * cohesive modules under `reference-graph-axis-proof/`.
 */
export { buildReferenceGraphSourceProof } from "./reference-graph-axis-proof/builder"
export {
  applyReferenceGraphSourceEligibility,
  axisReceiptForGraph,
  verifiedReferenceGraphIds,
} from "./reference-graph-axis-proof/eligibility"
export { parseReferenceGraphSourceProof } from "./reference-graph-axis-proof/parser"
export type {
  ExplicitReferenceGraphAxisCalibrationReceipt,
  OcrBoundingBox,
  ReferenceAxisSourceTick,
  ReferenceDivisionScaleSource,
  ReferenceGraphAxisCalibrationReceipt,
  ReferenceGraphAxisProofResult,
  ReferenceGraphFigureIdentityReceipt,
  ReferenceGraphSourceProof,
  ReferenceGridCalibrationSource,
  ScopeDivisionReferenceGraphAxisCalibrationReceipt,
} from "./reference-graph-axis-proof/types"
