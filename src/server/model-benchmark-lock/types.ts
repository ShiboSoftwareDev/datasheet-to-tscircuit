export interface LockedFile {
  file: string
  sha256: string
}

export interface BenchmarkLock {
  version: 1
  generation: number
  locked_at: string
  benchmark_ids: string[]
  files: LockedFile[]
}

export interface BenchmarkRecord {
  id: string
  source_image?: string
  subplot_count?: number
  series: Array<{
    id: string
    role: "response" | "stimulus"
    subplot_index?: number
    quantity: string
    unit: string
    reference_file: string
    source_image?: string
    trace_file?: string
    simulation?: unknown
  }>
}
