/**
 * Stable public facade for deterministic datasheet time-graph discovery.
 * Implementation lives in cohesive modules under `time-graph/`.
 */
export { parseTimeGraphDiscovery } from "./time-graph/artifact"
export { deriveTimeGraphLocalConditionReceipt } from "./time-graph/condition-receipt"
export {
  discoverTimeGraphHints,
  findLikelyTimeGraphCandidates,
  normalizeFigureLabel,
} from "./time-graph/discovery"
export {
  deriveTimeGraphPrintedExperiment,
  deriveTimeGraphTransientFixtureEvidence,
} from "./time-graph/printed-experiment"
export { TIME_GRAPH_LOCAL_CONDITION_METHOD } from "./time-graph/types"
export type {
  TimeGraphAuxiliaryCondition,
  TimeGraphConditionConflict,
  TimeGraphDiscovery,
  TimeGraphHint,
  TimeGraphLocalCondition,
  TimeGraphLocalConditionReceipt,
  TimeGraphPassiveType,
  TimeGraphTransientFixtureEvidence,
  UnsupportedFixtureCondition,
} from "./time-graph/types"
