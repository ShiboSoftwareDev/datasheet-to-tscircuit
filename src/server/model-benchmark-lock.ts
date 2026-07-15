import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rename } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"

interface LockedFile {
  file: string
  sha256: string
}

interface BenchmarkLock {
  version: 1
  locked_at: string
  benchmark_ids: string[]
  files: LockedFile[]
}

interface BenchmarkRecord {
  id: string
  reference_file: string
  simulation?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function getLockRoot(model_dir: string): string {
  return join(dirname(model_dir), ".model-benchmark-lock")
}

function getLockFile(model_dir: string): string {
  return join(getLockRoot(model_dir), "lock.json")
}

function resolveWorkspaceFile(model_dir: string, file: string): string {
  if (isAbsolute(file)) throw new Error(`Locked benchmark file must be relative: ${file}`)
  const resolved_root = resolve(model_dir)
  const resolved_file = resolve(resolved_root, file)
  if (!resolved_file.startsWith(`${resolved_root}${sep}`)) {
    throw new Error(`Locked benchmark file escapes the model workspace: ${file}`)
  }
  return resolved_file
}

function assertEvidenceFile(model_dir: string, file: string): void {
  const evidence_root = resolve(model_dir, "evidence")
  const resolved_file = resolve(model_dir, file)
  if (!resolved_file.startsWith(`${evidence_root}${sep}`)) {
    throw new Error(`Locked benchmark evidence must stay under evidence/: ${file}`)
  }
}

function parseBenchmarkRecords(value: unknown): BenchmarkRecord[] {
  if (!isRecord(value) || value.version !== 1 || typeof value.locked_at !== "string") {
    throw new Error("benchmarks.json must contain a version 1 locked benchmark manifest")
  }
  if (!Array.isArray(value.benchmarks) || value.benchmarks.length === 0) {
    throw new Error("benchmarks.json must contain at least one benchmark")
  }
  const records = value.benchmarks.map((entry, index): BenchmarkRecord => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.id) ||
      typeof entry.reference_file !== "string" ||
      !entry.reference_file.startsWith("evidence/")
    ) {
      throw new Error(`Benchmark ${index + 1} has an invalid id or evidence reference`)
    }
    return { id: entry.id, reference_file: entry.reference_file, simulation: entry.simulation }
  })
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    throw new Error("Benchmark ids must be unique")
  }
  return records
}

function assertSourceUsesSweepProps(source: string, benchmark: BenchmarkRecord): void {
  if (!isRecord(benchmark.simulation) || benchmark.simulation.kind !== "parameter_sweep") return
  if (!Array.isArray(benchmark.simulation.points) || benchmark.simulation.points.length < 2) return
  const prop_keys = new Set<string>()
  for (const [index, point] of benchmark.simulation.points.entries()) {
    if (!isRecord(point) || !isRecord(point.props) || Object.keys(point.props).length === 0) {
      throw new Error(`Benchmark ${benchmark.id} sweep point ${index + 1} has no injected props`)
    }
    for (const key of Object.keys(point.props)) prop_keys.add(key)
  }
  for (const key of prop_keys) {
    if (!new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(source)) {
      throw new Error(
        `Benchmark ${benchmark.id} does not consume injected prop ${key}; every sweep prop must affect the DUT harness`,
      )
    }
  }
}

function assertBenchmarkSourceContract(source: string, benchmark: BenchmarkRecord): void {
  if (!/component-with-model(?:\.circuit)?["']/.test(source)) {
    throw new Error(`Benchmark ${benchmark.id} must import component-with-model.circuit`)
  }
  if (!/<[A-Z][A-Za-z0-9_$]*\b[^>]*\bname=["']DUT["']/.test(source)) {
    throw new Error(`Benchmark ${benchmark.id} must instantiate exactly one model component named DUT`)
  }
  if ((source.match(/\bname=["']DUT["']/g) ?? []).length !== 1) {
    throw new Error(`Benchmark ${benchmark.id} must instantiate exactly one component named DUT`)
  }
  if (!/<analogsimulation\b[^>]*\bspiceEngine=["']ngspice["']/.test(source)) {
    throw new Error(`Benchmark ${benchmark.id} must run an ngspice analogsimulation`)
  }
  const probe_name = isRecord(benchmark.simulation) ? benchmark.simulation.probe_name : undefined
  if (typeof probe_name === "string") {
    const escaped_probe = probe_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (!new RegExp(`<voltageprobe\\b[^>]*\\bname=["']${escaped_probe}["']`).test(source)) {
      throw new Error(`Benchmark ${benchmark.id} must define voltage probe ${probe_name}`)
    }
  }
  if (/\b(selector|telemetry|benchmark[_ -]?code|metric[_ -]?channel)\b/i.test(source)) {
    throw new Error(`Benchmark ${benchmark.id} contains a synthetic benchmark backchannel`)
  }
  assertSourceUsesSweepProps(source, benchmark)
}

async function readCurrentLock(model_dir: string): Promise<{
  benchmark_ids: string[]
  files: Array<LockedFile & { text: string }>
}> {
  const manifest_text = await readFile(join(model_dir, "benchmarks.json"), "utf8")
  const records = parseBenchmarkRecords(JSON.parse(manifest_text) as unknown)
  for (const record of records) assertEvidenceFile(model_dir, record.reference_file)
  const benchmark_entries = await readdir(join(model_dir, "benchmarks")).catch(() => [])
  const benchmark_files = benchmark_entries.filter((entry) => entry.endsWith(".circuit.tsx")).sort()
  const expected_files = records.map((record) => `${record.id}.circuit.tsx`).sort()
  if (JSON.stringify(benchmark_files) !== JSON.stringify(expected_files)) {
    throw new Error("benchmarks.json and benchmarks/*.circuit.tsx must contain the same locked benchmark ids")
  }

  const paths = [
    "benchmarks.json",
    ...records.map((record) => join("benchmarks", `${record.id}.circuit.tsx`)),
    ...records.map((record) => record.reference_file),
  ]
  const unique_paths = [...new Set(paths)]
  const files = await Promise.all(
    unique_paths.map(async (file) => {
      const text = await readFile(resolveWorkspaceFile(model_dir, file), "utf8")
      return { file, text, sha256: hashText(text) }
    }),
  )
  for (const record of records) {
    const source = files.find((file) => file.file === join("benchmarks", `${record.id}.circuit.tsx`))?.text
    if (!source) throw new Error(`Benchmark ${record.id} source is missing`)
    assertBenchmarkSourceContract(source, record)
  }
  return { benchmark_ids: records.map((record) => record.id).sort(), files }
}

async function writeTextAtomically(file_path: string, text: string): Promise<void> {
  await mkdir(dirname(file_path), { recursive: true })
  const temporary_path = `${file_path}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporary_path, text)
  await rename(temporary_path, file_path)
}

function parseLock(value: unknown): BenchmarkLock {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.locked_at !== "string" ||
    !Array.isArray(value.benchmark_ids) ||
    !value.benchmark_ids.every((id) => typeof id === "string") ||
    !Array.isArray(value.files) ||
    !value.files.every(
      (file) => isRecord(file) && typeof file.file === "string" && typeof file.sha256 === "string",
    )
  ) {
    throw new Error("The server-owned benchmark lock is invalid")
  }
  return value as unknown as BenchmarkLock
}

export async function hasBenchmarkManifest(model_dir: string): Promise<boolean> {
  return Bun.file(join(model_dir, "benchmarks.json")).exists()
}

export async function createOrVerifyBenchmarkLock(model_dir: string): Promise<BenchmarkLock> {
  const current = await readCurrentLock(model_dir)
  const lock_path = getLockFile(model_dir)
  const existing_value = await readFile(lock_path, "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined)
  if (existing_value !== undefined) {
    const existing = parseLock(existing_value)
    const expected = existing.files.map(({ file, sha256 }) => ({ file, sha256 }))
    const actual = current.files.map(({ file, sha256 }) => ({ file, sha256 }))
    if (
      JSON.stringify(existing.benchmark_ids) !== JSON.stringify(current.benchmark_ids) ||
      JSON.stringify(expected) !== JSON.stringify(actual)
    ) {
      throw new Error(
        "The locked benchmark suite or evidence changed after refinement began; restore the original files instead of weakening validation",
      )
    }
    return existing
  }

  const locked_at = new Date().toISOString()
  const lock: BenchmarkLock = {
    version: 1,
    locked_at,
    benchmark_ids: current.benchmark_ids,
    files: current.files.map(({ file, sha256 }) => ({ file, sha256 })),
  }
  const snapshot_root = join(getLockRoot(model_dir), "snapshot")
  await Promise.all(
    current.files.map(({ file, text }) => writeTextAtomically(join(snapshot_root, file), text)),
  )
  await writeTextAtomically(lock_path, `${JSON.stringify(lock, null, 2)}\n`)
  return lock
}

export async function verifyBenchmarkLock(model_dir: string): Promise<BenchmarkLock> {
  const value: unknown = JSON.parse(await readFile(getLockFile(model_dir), "utf8"))
  const lock = parseLock(value)
  const current = await readCurrentLock(model_dir)
  if (
    JSON.stringify(lock.benchmark_ids) !== JSON.stringify(current.benchmark_ids) ||
    JSON.stringify(lock.files.map(({ file, sha256 }) => ({ file, sha256 }))) !==
      JSON.stringify(current.files.map(({ file, sha256 }) => ({ file, sha256 })))
  ) {
    throw new Error("The server-owned benchmark lock no longer matches the model workspace")
  }
  return lock
}
