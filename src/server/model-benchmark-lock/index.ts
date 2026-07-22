export type { BenchmarkLock } from "./types"
export {
  hasBenchmarkManifest,
  hasBenchmarkLock,
  enableBenchmarkReferenceImageContract,
  hasBenchmarkReferenceImageContract,
  requiresCompleteTimeGraphInventory,
  validateBenchmarkSuiteForLock,
  createOrVerifyBenchmarkLock,
  replaceBenchmarkLockAfterCircuitRepair,
  verifyBenchmarkLock,
} from "./benchmark-lock"
