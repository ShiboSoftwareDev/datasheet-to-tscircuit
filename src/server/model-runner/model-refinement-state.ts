import type { BenchmarkLock } from "../model-benchmark-lock"
import type { scoreModelBenchmarks } from "../model-scorer"
import type { validateChampion } from "./validate-champion"

export type ValidatedChampion = Awaited<ReturnType<typeof validateChampion>>
export type ModelValidation = Awaited<ReturnType<typeof scoreModelBenchmarks>>

export class ModelRefinementState {
  benchmark_lock: BenchmarkLock
  final_champion?: ValidatedChampion
  final_validation?: ModelValidation
  final_error_message?: string
  causal_shift_error?: string
  model_integrity_error?: string
  agent_attempt = 0
  benchmark_recovery_count = 0
  last_validated_checkpoint_signature?: string

  constructor(benchmark_lock: BenchmarkLock) {
    this.benchmark_lock = benchmark_lock
  }

  get isValidationComplete(): boolean {
    return (
      this.final_validation?.all_passed === true &&
      !this.final_champion?.integration_error &&
      !this.model_integrity_error &&
      !this.causal_shift_error
    )
  }

  resetValidation(): void {
    this.final_champion = undefined
    this.final_validation = undefined
    this.final_error_message = undefined
    this.causal_shift_error = undefined
    this.model_integrity_error = undefined
  }
}
