export type { BenchmarkLock } from "./types"
export {
  hasBenchmarkManifest,
  hasBenchmarkLock,
  enableBenchmarkReferenceImageContract,
  hasBenchmarkReferenceImageContract,
  validateBenchmarkSuiteForLock,
  createOrVerifyBenchmarkLock,
  replaceBenchmarkLockAfterCircuitRepair,
  verifyBenchmarkLock,
} from "./benchmark-lock"
