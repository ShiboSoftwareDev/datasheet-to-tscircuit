import { readdir, readFile, stat } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import type {
  ModelCircuitPreview,
  ModelCurvePoint,
  ModelPreviewOption,
  ModelReferencePreview,
  ModelSelectedPreview,
} from "@/shared/job-types"
import type { ModelRunStore } from "./model-run-store"
import {
  getModelSimulationSourceSignature,
  getVerifiedResultFile,
  getVerifiedSimulationArtifact,
} from "./model-simulation-validator"

interface BenchmarkPreviewRecord {
  id?: string
  title?: string
  reference_file?: string
  x_scale?: string
  y_scale?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseBenchmarks(value: unknown): BenchmarkPreviewRecord[] {
  if (!isRecord(value) || !Array.isArray(value.benchmarks)) return []
  return value.benchmarks.flatMap((benchmark) => {
    if (!isRecord(benchmark)) return []
    return [
      {
        id: typeof benchmark.id === "string" ? benchmark.id : undefined,
        title: typeof benchmark.title === "string" ? benchmark.title : undefined,
        reference_file: typeof benchmark.reference_file === "string" ? benchmark.reference_file : undefined,
        x_scale: benchmark.x_scale === "log" ? "log" : "linear",
        y_scale: benchmark.y_scale === "log" ? "log" : "linear",
      },
    ]
  })
}

async function readBenchmarkRecords(model_dir: string): Promise<BenchmarkPreviewRecord[]> {
  for (const file_name of ["benchmarks.json", "benchmark-draft.json"]) {
    const value = await readFile(join(model_dir, file_name), "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => undefined)
    const benchmarks = parseBenchmarks(value)
    if (benchmarks.length > 0) return benchmarks
  }
  return []
}

function parseCurveCsv(text: string): ModelCurvePoint[] {
  const points = text
    .split(/\r?\n/)
    .slice(1)
    .flatMap((line) => {
      const [raw_x, raw_y] = line.split(",")
      const x = Number(raw_x?.trim())
      const y = Number(raw_y?.trim())
      return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : []
    })
  if (points.length <= 600) return points
  const stride = Math.ceil(points.length / 600)
  return points.filter((_, index) => index % stride === 0 || index === points.length - 1)
}

async function listFiles(directory: string, suffix: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entry_path = join(directory, entry.name)
      if (entry.isDirectory()) return listFiles(entry_path, suffix)
      return entry.name.endsWith(suffix) ? [entry_path] : []
    }),
  )
  return nested.flat()
}

async function newestFile(files: string[]): Promise<string | undefined> {
  const dated = await Promise.all(
    files.map(async (file) => ({
      file,
      modified_at: (await stat(file).catch(() => undefined))?.mtimeMs ?? 0,
    })),
  )
  return dated.sort((first, second) => second.modified_at - first.modified_at)[0]?.file
}

async function readReferencePreview(input: {
  model_dir: string
  current_benchmark?: string
  require_exact?: boolean
}): Promise<ModelReferencePreview | undefined> {
  const benchmarks = await readBenchmarkRecords(input.model_dir)
  const normalized_current = input.current_benchmark?.replace(/\.circuit\.tsx$/i, "")
  let selected = benchmarks.find(
    (benchmark) =>
      benchmark.id === normalized_current ||
      benchmark.reference_file?.includes(normalized_current ?? "\u0000"),
  )
  if (input.require_exact && !selected) return undefined
  selected ??= benchmarks.find((benchmark) => Boolean(benchmark.reference_file))

  let reference_file = selected?.reference_file
  if (!reference_file) {
    const newest_curve = await newestFile(
      await listFiles(join(input.model_dir, "evidence", "curves"), ".csv"),
    )
    if (!newest_curve) return undefined
    reference_file = relative(input.model_dir, newest_curve)
    selected = { id: basename(reference_file, ".csv"), title: basename(reference_file, ".csv") }
  }

  const reference_text = await readFile(join(input.model_dir, reference_file), "utf8").catch(() => undefined)
  if (!reference_text) return undefined
  const reference_points = parseCurveCsv(reference_text)
  if (reference_points.length === 0) return undefined

  const verified_artifact = selected?.id
    ? await getVerifiedSimulationArtifact(input.model_dir, selected.id).catch(() => undefined)
    : undefined
  const current_signature = selected?.id
    ? await getModelSimulationSourceSignature(input.model_dir, selected.id).catch(() => undefined)
    : undefined
  const result_points = verified_artifact?.result_text
    ? parseCurveCsv(verified_artifact.result_text)
    : undefined
  return {
    benchmark_id: selected?.id,
    title: selected?.title ?? selected?.id ?? basename(reference_file, ".csv"),
    source_file: reference_file,
    result_file: verified_artifact?.result_file,
    x_scale: selected?.x_scale === "log" ? "log" : "linear",
    y_scale: selected?.y_scale === "log" ? "log" : "linear",
    reference_points,
    result_points: result_points && result_points.length > 0 ? result_points : undefined,
    is_stale: Boolean(
      verified_artifact?.source_signature &&
        current_signature &&
        verified_artifact.source_signature !== current_signature,
    ),
    updated_at: verified_artifact?.generated_at ?? new Date().toISOString(),
  }
}

async function selectCircuitSource(input: {
  model_dir: string
  current_benchmark?: string
  require_exact?: boolean
}): Promise<string | undefined> {
  const benchmark_files = await listFiles(join(input.model_dir, "benchmarks"), ".circuit.tsx")
  const normalized_current = input.current_benchmark?.replace(/\.circuit\.tsx$/i, "")
  const current_file = benchmark_files.find((file) => basename(file, ".circuit.tsx") === normalized_current)
  if (current_file) return current_file
  if (input.require_exact) return undefined
  const newest_benchmark = await newestFile(benchmark_files)
  if (newest_benchmark) return newest_benchmark
  const component_file = join(input.model_dir, "component-with-model.circuit.tsx")
  return Bun.file(component_file).size > 0 ? component_file : undefined
}

function isCircuitJson(value: unknown): value is NonNullable<ModelCircuitPreview["circuit_json"]> {
  return (
    Array.isArray(value) &&
    value.every(
      (element) => typeof element === "object" && element !== null && typeof element.type === "string",
    )
  )
}

async function readWorkspaceCircuitJson(input: {
  model_dir: string
  benchmark_id: string
}): Promise<
  { circuit_json: NonNullable<ModelCircuitPreview["circuit_json"]>; updated_at: string } | undefined
> {
  const output_file = join(
    dirname(input.model_dir),
    "dist",
    "spice",
    "benchmarks",
    input.benchmark_id,
    "circuit.json",
  )
  const [value, file_stat] = await Promise.all([
    readFile(output_file, "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => undefined),
    stat(output_file).catch(() => undefined),
  ])
  if (!file_stat || !isCircuitJson(value)) return undefined
  return { circuit_json: value, updated_at: file_stat.mtime.toISOString() }
}

async function readPersistedCircuitPreview(input: {
  model_dir: string
  source_path: string
  benchmark_id: string
}): Promise<ModelCircuitPreview> {
  const [current_code, source_stat, current_signature, verified, workspace] = await Promise.all([
    readFile(input.source_path, "utf8"),
    stat(input.source_path),
    getModelSimulationSourceSignature(input.model_dir, input.benchmark_id),
    getVerifiedSimulationArtifact(input.model_dir, input.benchmark_id).catch(() => undefined),
    readWorkspaceCircuitJson(input),
  ])
  const source_file = relative(input.model_dir, input.source_path)
  const verified_time = verified ? new Date(verified.generated_at).valueOf() : 0
  const workspace_time = workspace ? new Date(workspace.updated_at).valueOf() : 0

  if (verified && verified_time >= workspace_time) {
    return {
      source_file: verified.source_file,
      code: verified.code,
      build_status: "ready",
      circuit_json: verified.circuit_json,
      snapshot_origin: "server_validation",
      is_stale: verified.source_signature !== current_signature,
      updated_at: verified.generated_at,
    }
  }
  if (workspace) {
    const dependency_files = [
      input.source_path,
      join(input.model_dir, "model.lib"),
      join(input.model_dir, "component-with-model.circuit.tsx"),
      join(input.model_dir, "component.circuit.tsx"),
    ]
    const dependency_stats = await Promise.all(
      dependency_files.map((file) => stat(file).catch(() => undefined)),
    )
    const newest_dependency = Math.max(...dependency_stats.map((value) => value?.mtimeMs ?? 0))
    return {
      source_file,
      code: current_code,
      build_status: "ready",
      circuit_json: workspace.circuit_json,
      snapshot_origin: "workspace",
      is_stale: workspace_time + 1 < newest_dependency,
      updated_at: workspace.updated_at,
    }
  }
  return {
    source_file,
    code: current_code,
    build_status: "source_ready",
    updated_at: source_stat.mtime.toISOString(),
  }
}

export async function listModelPreviewOptions(model_dir: string): Promise<ModelPreviewOption[]> {
  const [benchmarks, benchmark_files] = await Promise.all([
    readBenchmarkRecords(model_dir),
    listFiles(join(model_dir, "benchmarks"), ".circuit.tsx"),
  ])
  return (
    await Promise.all(
      benchmark_files.map(async (file) => {
        const benchmark_id = basename(file, ".circuit.tsx")
        const benchmark = benchmarks.find((candidate) => candidate.id === benchmark_id)
        return {
          benchmark_id,
          title: benchmark?.title ?? benchmark_id,
          circuit_file: relative(model_dir, file),
          reference_file: benchmark?.reference_file,
          result_file: await getVerifiedResultFile(model_dir, benchmark_id).catch(() => undefined),
        }
      }),
    )
  ).sort((first, second) => first.title.localeCompare(second.title))
}

export async function loadModelSelectedPreview(input: {
  model_dir: string
  benchmark_id: string
}): Promise<ModelSelectedPreview | undefined> {
  const source_path = await selectCircuitSource({
    model_dir: input.model_dir,
    current_benchmark: input.benchmark_id,
    require_exact: true,
  })
  if (!source_path) return undefined
  const [circuit_preview, reference_preview] = await Promise.all([
    readPersistedCircuitPreview({
      model_dir: input.model_dir,
      source_path,
      benchmark_id: input.benchmark_id,
    }),
    readReferencePreview({
      model_dir: input.model_dir,
      current_benchmark: input.benchmark_id,
      require_exact: true,
    }),
  ])
  return { circuit_preview, reference_preview }
}

export interface ModelArtifactMonitor {
  sync: () => Promise<void>
  stop: () => void
}

export function startModelArtifactMonitor(input: {
  model_run_id: string
  model_dir: string
  model_run_store: ModelRunStore
  interval_ms?: number
}): ModelArtifactMonitor {
  let is_stopped = false
  let sync_in_flight: Promise<void> | undefined
  let reference_signature: string | undefined
  let circuit_signature: string | undefined

  const sync = async () => {
    if (is_stopped) return
    if (sync_in_flight) return sync_in_flight
    sync_in_flight = (async () => {
      const current_run = input.model_run_store.getModelRun(input.model_run_id)
      const current_benchmark = current_run?.progress?.benchmark?.current
      const preview_options = await listModelPreviewOptions(input.model_dir)
      input.model_run_store.updatePreviewOptions(input.model_run_id, preview_options)
      const normalized_current = current_benchmark?.replace(/\.circuit\.tsx$/i, "")
      const benchmark_id = preview_options.some((option) => option.benchmark_id === normalized_current)
        ? normalized_current
        : preview_options[0]?.benchmark_id
      if (!benchmark_id) return
      const selected = await loadModelSelectedPreview({ model_dir: input.model_dir, benchmark_id })
      if (!selected) return

      if (selected.reference_preview) {
        const signature = JSON.stringify({ ...selected.reference_preview, updated_at: undefined })
        if (signature !== reference_signature) {
          reference_signature = signature
          input.model_run_store.updateReferencePreview(input.model_run_id, selected.reference_preview)
        }
      }
      if (selected.circuit_preview) {
        const signature = JSON.stringify(selected.circuit_preview)
        if (signature !== circuit_signature) {
          circuit_signature = signature
          input.model_run_store.updateCircuitPreview(input.model_run_id, selected.circuit_preview)
        }
      }
    })()
    try {
      await sync_in_flight
    } finally {
      sync_in_flight = undefined
    }
  }

  const timer = setInterval(() => void sync(), input.interval_ms ?? 750)
  void sync()
  return {
    sync,
    stop: () => {
      is_stopped = true
      clearInterval(timer)
    },
  }
}
