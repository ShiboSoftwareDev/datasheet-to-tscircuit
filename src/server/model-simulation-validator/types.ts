import type { AnyCircuitElement } from "circuit-json"

export type SimulationExtractionDefinition = {
  kind: "transient_voltage"
  x_axis: "time_ms"
  probe_name: string
  dut_spice_node?: string
  sense_resistor?: string
  scale: number
  offset: number
}

export type SimulationSeriesDefinition = SimulationExtractionDefinition & {
  series_id: string
  role: "response" | "stimulus"
  quantity: string
  unit: string
}

export interface SimulationSeriesResultFile {
  series_id: string
  file: string
  sha256: string
}

export interface SimulationGraph {
  name: string
  timestamps_ms: number[]
  voltage_levels: number[]
}

export interface CircuitBuildDiagnostics {
  source_errors: string[]
  simulation_errors: string[]
}

export interface SimulationBenchmarkVerification {
  benchmark_id: string
  passed: boolean
  status?: "building" | "passed" | "failed"
  generated_at: string
  source_file?: string
  source_sha256?: string
  source_signature?: string
  circuit_json_file?: string
  circuit_json_sha256?: string
  error_message?: string
  verified_result_file?: string
  sha256?: string
  verified_result_files?: SimulationSeriesResultFile[]
  partial_result_file?: string
  partial_sha256?: string
  partial_result_files?: SimulationSeriesResultFile[]
}

export interface SimulationValidationReport {
  version: 2
  generated_at: string
  benchmarks: SimulationBenchmarkVerification[]
}

export interface VerifiedSimulationArtifact {
  benchmark_id: string
  passed: boolean
  generated_at: string
  source_file: string
  source_signature?: string
  code: string
  circuit_json: AnyCircuitElement[]
  result_file?: string
  result_text?: string
  result_files?: Record<string, string>
  result_texts?: Record<string, string>
  error_message?: string
  status: "building" | "passed" | "failed"
}
