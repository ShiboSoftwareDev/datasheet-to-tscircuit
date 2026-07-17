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
  extractSimulationResultPoints,
  getModelSimulationSourceSignature,
  getSimulationBenchmarkVerification,
  getVerifiedResultFile,
  getVerifiedSimulationArtifact,
  parseSimulationDefinition,
} from "./model-simulation-validator"

interface BenchmarkPreviewRecord {
  id?: string
  title?: string
  reference_file?: string
  x_scale?: string
  y_scale?: string
  simulation?: unknown
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
        simulation: benchmark.simulation,
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

function downsampleCurvePoints(points: ModelCurvePoint[]): ModelCurvePoint[] {
  if (points.length <= 600) return points
  const stride = Math.ceil(points.length / 600)
  return points.filter((_, index) => index % stride === 0 || index === points.length - 1)
}

function parseCurveCsv(text: string): ModelCurvePoint[] {
  return downsampleCurvePoints(
    text
      .split(/\r?\n/)
      .slice(1)
      .flatMap((line) => {
        const [raw_x, raw_y] = line.split(",")
        const x = Number(raw_x?.trim())
        const y = Number(raw_y?.trim())
        return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : []
      }),
  )
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
  circuit_preview?: ModelCircuitPreview
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

  const reference_path = join(input.model_dir, reference_file)
  const [reference_text, reference_stat] = await Promise.all([
    readFile(reference_path, "utf8").catch(() => undefined),
    stat(reference_path).catch(() => undefined),
  ])
  if (!reference_text) return undefined
  const reference_points = parseCurveCsv(reference_text)
  if (reference_points.length === 0) return undefined

  const result_points = (() => {
    if (!input.circuit_preview?.circuit_json || !selected?.simulation) return undefined
    try {
      return downsampleCurvePoints(
        extractSimulationResultPoints(
          input.circuit_preview.circuit_json,
          parseSimulationDefinition(selected.simulation),
        ),
      )
    } catch {
      return undefined
    }
  })()
  const is_stale = Boolean(input.circuit_preview?.is_stale)
  const result_origin = result_points?.length ? input.circuit_preview?.snapshot_origin : undefined
  const result_status = result_points?.length
    ? is_stale
      ? "deprecated"
      : result_origin === "workspace"
        ? "unverified"
        : input.circuit_preview?.build_status === "ready"
          ? "verified"
          : input.circuit_preview?.build_status === "building"
            ? "partial"
            : "unverified"
    : undefined
  return {
    benchmark_id: selected?.id,
    title: selected?.title ?? selected?.id ?? basename(reference_file, ".csv"),
    source_file: reference_file,
    result_file:
      result_status === "verified" && selected?.id ? `results/verified/${selected.id}.csv` : undefined,
    x_scale: selected?.x_scale === "log" ? "log" : "linear",
    y_scale: selected?.y_scale === "log" ? "log" : "linear",
    reference_points,
    result_points: result_points && result_points.length > 0 ? result_points : undefined,
    result_status,
    result_origin,
    is_stale,
    updated_at:
      (result_points?.length ? input.circuit_preview?.updated_at : undefined) ??
      reference_stat?.mtime.toISOString() ??
      new Date().toISOString(),
  }
}

async function selectCircuitSource(input: {
  model_dir: string
  current_benchmark?: string
  require_exact?: boolean
}): Promise<string | undefined> {
  const benchmarks = await readBenchmarkRecords(input.model_dir)
  const declared_ids = benchmarks.flatMap((benchmark) =>
    typeof benchmark.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(benchmark.id)
      ? [benchmark.id]
      : [],
  )
  const normalized_current = input.current_benchmark?.replace(/\.circuit\.tsx$/i, "")
  if (normalized_current && declared_ids.includes(normalized_current)) {
    const current_file = join(input.model_dir, "benchmarks", `${normalized_current}.circuit.tsx`)
    if ((await stat(current_file).catch(() => undefined))?.isFile()) return current_file
  }
  if (input.require_exact) return undefined
  const benchmark_files = declared_ids.map((id) => join(input.model_dir, "benchmarks", `${id}.circuit.tsx`))
  const existing_files = (
    await Promise.all(
      benchmark_files.map(async (file) =>
        (await stat(file).catch(() => undefined))?.isFile() ? file : undefined,
      ),
    )
  ).filter((file): file is string => Boolean(file))
  const newest_benchmark = await newestFile(existing_files)
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
  const dist_root = join(dirname(input.model_dir), "dist", "spice")
  const canonical_file = join(dist_root, "benchmarks", input.benchmark_id, "circuit.json")
  const isolated_files = (
    await Promise.all([
      listFiles(join(input.model_dir, "validation-artifacts", input.benchmark_id, "runs"), "circuit.json"),
    ])
  ).flat()
  const candidates = [canonical_file, ...isolated_files]
  const dated = await Promise.all(
    candidates.map(async (file) => ({ file, file_stat: await stat(file).catch(() => undefined) })),
  )
  for (const candidate of dated.sort(
    (first, second) => (second.file_stat?.mtimeMs ?? 0) - (first.file_stat?.mtimeMs ?? 0),
  )) {
    if (!candidate.file_stat?.isFile()) continue
    const value = await readFile(candidate.file, "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => undefined)
    if (isCircuitJson(value)) {
      return { circuit_json: value, updated_at: candidate.file_stat.mtime.toISOString() }
    }
  }
  return undefined
}

async function readPersistedCircuitPreview(input: {
  model_dir: string
  source_path: string
  benchmark_id: string
}): Promise<ModelCircuitPreview> {
  const [current_code, source_stat, current_signature, verified, workspace, verification] = await Promise.all(
    [
      readFile(input.source_path, "utf8"),
      stat(input.source_path),
      getModelSimulationSourceSignature(input.model_dir, input.benchmark_id),
      getVerifiedSimulationArtifact(input.model_dir, input.benchmark_id).catch(() => undefined),
      readWorkspaceCircuitJson(input),
      getSimulationBenchmarkVerification(input.model_dir, input.benchmark_id).catch(() => undefined),
    ],
  )
  const source_file = relative(input.model_dir, input.source_path)
  const verified_time = verified ? new Date(verified.generated_at).valueOf() : 0
  const workspace_time = workspace ? new Date(workspace.updated_at).valueOf() : 0
  const verification_time = verification ? new Date(verification.generated_at).valueOf() : 0
  const verification_status = verification?.status ?? (verification?.passed ? "passed" : "failed")
  const verification_is_current = Boolean(
    verification &&
      Number.isFinite(verification_time) &&
      verification_time >= source_stat.mtimeMs &&
      (!verification.source_signature || verification.source_signature === current_signature),
  )

  if (
    verification_is_current &&
    (verification_status === "building" ||
      (verification_status === "failed" && verification_time >= Math.max(verified_time, workspace_time)))
  ) {
    const state_circuit_json = verified?.circuit_json ?? workspace?.circuit_json
    return {
      source_file: verified?.source_file ?? source_file,
      code: verified?.code ?? current_code,
      build_status: verification_status,
      ...(state_circuit_json ? { circuit_json: state_circuit_json } : {}),
      ...(verified
        ? { snapshot_origin: "server_validation" as const }
        : workspace
          ? { snapshot_origin: "workspace" as const }
          : {}),
      error_message: verification_status === "failed" ? verification?.error_message : undefined,
      updated_at: workspace_time > verification_time ? workspace!.updated_at : verification!.generated_at,
    }
  }

  if (verified?.passed && verified_time >= workspace_time) {
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
  const benchmarks = await readBenchmarkRecords(model_dir)
  return (
    await Promise.all(
      benchmarks.map(async (benchmark): Promise<ModelPreviewOption | undefined> => {
        const benchmark_id = benchmark.id
        if (!benchmark_id || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(benchmark_id)) return undefined
        const file = join(model_dir, "benchmarks", `${benchmark_id}.circuit.tsx`)
        if (!(await stat(file).catch(() => undefined))?.isFile()) return undefined
        return {
          benchmark_id,
          title: benchmark?.title ?? benchmark_id,
          circuit_file: relative(model_dir, file),
          reference_file: benchmark?.reference_file,
          result_file: await getVerifiedResultFile(model_dir, benchmark_id).catch(() => undefined),
        }
      }),
    )
  )
    .filter((option): option is ModelPreviewOption => Boolean(option))
    .sort((first, second) => first.title.localeCompare(second.title))
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
  try {
    const circuit_preview = await readPersistedCircuitPreview({
      model_dir: input.model_dir,
      source_path,
      benchmark_id: input.benchmark_id,
    })
    const reference_preview = await readReferencePreview({
      model_dir: input.model_dir,
      current_benchmark: input.benchmark_id,
      require_exact: true,
      circuit_preview,
    })
    return { circuit_preview, reference_preview }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
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
  let preview_signature: string | undefined

  const performSync = async () => {
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

    const signature = JSON.stringify(selected)
    if (signature !== preview_signature) {
      preview_signature = signature
      input.model_run_store.updatePreviews(input.model_run_id, selected)
    }
  }

  const startSync = (): Promise<void> => {
    const running = (async () => {
      try {
        await performSync()
      } finally {
        sync_in_flight = undefined
      }
    })()
    sync_in_flight = running
    return running
  }

  const sync = async () => {
    if (is_stopped) return
    const active_sync = sync_in_flight
    if (active_sync) await active_sync
    if (is_stopped) return
    await (sync_in_flight ?? startSync())
  }

  const poll = () => {
    if (is_stopped || sync_in_flight) return
    void startSync()
  }

  const timer = setInterval(poll, input.interval_ms ?? 750)
  poll()
  return {
    sync,
    stop: () => {
      is_stopped = true
      clearInterval(timer)
    },
  }
}
