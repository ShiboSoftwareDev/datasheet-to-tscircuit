export {
  createOrVerifyBenchmarkLock,
  enableBenchmarkReferenceImageContract,
  hasBenchmarkLock,
  hasBenchmarkManifest,
  hasBenchmarkReferenceImageContract,
  replaceBenchmarkLockAfterCircuitRepair,
  requiresCompleteTimeGraphInventory,
  requiresTraceProvenance,
  validateBenchmarkSuiteForLock,
  verifyBenchmarkLock,
} from "./benchmark-lock"
export {
  clearSetupEvidenceLockForCorrection,
  createOrVerifySetupEvidenceLock,
  restoreSetupEvidenceFromSnapshot,
  verifySetupEvidenceLock,
} from "./setup-evidence-lock"
export type { BenchmarkLock } from "./types"
