export { canonicalizeComponentEvidenceInput } from "./canonicalize-component-evidence"
export {
  createSingleFootprintCatalog,
  getDefaultFootprint,
  parseComponentFootprintCatalog,
  physicalFootprintSignature,
} from "./component-footprint-catalog"
export {
  COMPONENT_EVIDENCE_SCHEMA_ID,
  COMPONENT_EVIDENCE_VERSION,
  DRAWING_ORIENTATIONS,
  EVIDENCE_PAD_KINDS,
  SCHEMATIC_PIN_ROLES,
} from "./contract"
export { createFootprintPlanFromEvidence } from "./create-footprint-plan-from-evidence"
export { getComponentEvidenceBlockingReasons } from "./get-component-evidence-blocking-reasons"
export { getFootprintEvidenceErrors } from "./get-footprint-evidence-errors"
export { getPinoutEvidenceErrors } from "./get-pinout-evidence-errors"
export { parseComponentEvidence } from "./parse-component-evidence"
export {
  createTscircuitPinMappings,
  physicalPinFromHints,
  physicalPinHint,
} from "./tscircuit-pin-mapping"
export type { TscircuitPinMapping } from "./tscircuit-pin-mapping"
export type {
  ComponentEvidence,
  DrawingOrientation,
  EvidenceConfidence,
  EvidenceField,
  EvidenceMethod,
  EvidencePad,
  EvidenceSource,
  PinEvidence,
  SchematicPinRole,
} from "./types"
export type {
  ComponentFootprintCatalog,
  ComponentFootprintVariant,
} from "./component-footprint-catalog"
