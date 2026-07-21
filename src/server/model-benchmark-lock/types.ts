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
  reference_file: string
  source_image?: string
  simulation?: unknown
}
