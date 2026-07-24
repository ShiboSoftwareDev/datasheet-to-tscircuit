import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { getLockFile, getLockRoot, getReferenceImageContractFile } from "./benchmark-lock-paths"
import { parseLock, readCurrentLock, writeLockSnapshots, writeTextAtomically } from "./benchmark-lock-storage"
import { BenchmarkLock } from "./types"

export async function hasBenchmarkManifest(model_dir: string): Promise<boolean> {
  return Bun.file(join(model_dir, "benchmarks.json")).exists()
}

export async function hasBenchmarkLock(model_dir: string): Promise<boolean> {
  return Bun.file(getLockFile(model_dir)).exists()
}

export async function enableBenchmarkReferenceImageContract(model_dir: string): Promise<void> {
  await writeTextAtomically(
    getReferenceImageContractFile(model_dir),
    `${JSON.stringify({ version: 2, enabled_at: new Date().toISOString() }, null, 2)}\n`,
  )
}

export async function requiresCompleteTimeGraphInventory(model_dir: string): Promise<boolean> {
  const value = await readFile(getReferenceImageContractFile(model_dir), "utf8")
    .then((text) => JSON.parse(text) as { version?: unknown })
    .catch(() => undefined)
  return value !== undefined
}

export async function hasBenchmarkReferenceImageContract(model_dir: string): Promise<boolean> {
  return Bun.file(getReferenceImageContractFile(model_dir)).exists()
}

export async function validateBenchmarkSuiteForLock(
  model_dir: string,
  options: { require_source_images?: boolean } = {},
): Promise<string[]> {
  return (await readCurrentLock(model_dir, options)).warnings
}

export async function createOrVerifyBenchmarkLock(model_dir: string): Promise<BenchmarkLock> {
  const current = await readCurrentLock(model_dir)
  const lock_path = getLockFile(model_dir)
  const existing_value = await readFile(lock_path, "utf8")
    .then((text) => JSON.parse(text))
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
    generation: 1,
    locked_at,
    benchmark_ids: current.benchmark_ids,
    files: current.files.map(({ file, sha256 }) => ({ file, sha256 })),
  }
  await writeLockSnapshots({ model_dir, files: current.files, generation: lock.generation })
  await writeTextAtomically(lock_path, `${JSON.stringify(lock, null, 2)}\n`)
  return lock
}

export async function replaceBenchmarkLockAfterCircuitRepair(
  model_dir: string,
  expected_lock: BenchmarkLock,
): Promise<BenchmarkLock> {
  const lock_path = getLockFile(model_dir)
  const persisted = parseLock(JSON.parse(await readFile(lock_path, "utf8")))
  if (
    persisted.locked_at !== expected_lock.locked_at ||
    persisted.generation !== expected_lock.generation ||
    JSON.stringify(persisted.benchmark_ids) !== JSON.stringify(expected_lock.benchmark_ids) ||
    JSON.stringify(persisted.files) !== JSON.stringify(expected_lock.files)
  ) {
    throw new Error("The server-owned benchmark lock changed before circuit repair could be committed")
  }

  const current = await readCurrentLock(model_dir)
  const repairable = (file: string) => file.startsWith("benchmarks/") && file.endsWith(".circuit.tsx")
  const preserved = expected_lock.files.filter(({ file }) => !repairable(file))
  const current_preserved = current.files
    .filter(({ file }) => !repairable(file))
    .map(({ file, sha256 }) => ({ file, sha256 }))
  if (JSON.stringify(preserved) !== JSON.stringify(current_preserved)) {
    throw new Error(
      "Benchmark circuit recovery may change only benchmarks/*.circuit.tsx; the manifest, evidence, tolerances, and transient waveform definitions must remain locked",
    )
  }
  if (JSON.stringify(current.benchmark_ids) !== JSON.stringify(expected_lock.benchmark_ids)) {
    throw new Error("Benchmark circuit recovery may not add, remove, or rename benchmarks")
  }
  const previous_circuits = expected_lock.files.filter(({ file }) => repairable(file))
  const current_circuits = current.files
    .filter(({ file }) => repairable(file))
    .map(({ file, sha256 }) => ({ file, sha256 }))
  if (JSON.stringify(previous_circuits) === JSON.stringify(current_circuits)) {
    throw new Error("Benchmark circuit recovery must repair at least one benchmarks/*.circuit.tsx file")
  }

  const generation = expected_lock.generation + 1
  const replacement: BenchmarkLock = {
    version: 1,
    generation,
    locked_at: new Date().toISOString(),
    benchmark_ids: current.benchmark_ids,
    files: current.files.map(({ file, sha256 }) => ({ file, sha256 })),
  }
  await writeTextAtomically(
    join(
      getLockRoot(model_dir),
      "history",
      `generation-${String(expected_lock.generation).padStart(4, "0")}.json`,
    ),
    `${JSON.stringify(expected_lock, null, 2)}\n`,
  )
  await writeLockSnapshots({ model_dir, files: current.files, generation })
  await writeTextAtomically(lock_path, `${JSON.stringify(replacement, null, 2)}\n`)
  return replacement
}

export async function verifyBenchmarkLock(
  model_dir: string,
  expected_lock?: BenchmarkLock,
): Promise<BenchmarkLock> {
  const value: unknown = JSON.parse(await readFile(getLockFile(model_dir), "utf8"))
  const lock = parseLock(value)
  if (
    expected_lock &&
    (expected_lock.locked_at !== lock.locked_at ||
      expected_lock.generation !== lock.generation ||
      JSON.stringify(expected_lock.benchmark_ids) !== JSON.stringify(lock.benchmark_ids) ||
      JSON.stringify(expected_lock.files) !== JSON.stringify(lock.files))
  ) {
    throw new Error("The server-owned benchmark lock changed while the model workflow was running")
  }
  const current = await readCurrentLock(model_dir)
  const trusted_lock = expected_lock ?? lock
  if (
    JSON.stringify(trusted_lock.benchmark_ids) !== JSON.stringify(current.benchmark_ids) ||
    JSON.stringify(trusted_lock.files.map(({ file, sha256 }) => ({ file, sha256 }))) !==
      JSON.stringify(current.files.map(({ file, sha256 }) => ({ file, sha256 })))
  ) {
    throw new Error("The server-owned benchmark lock no longer matches the model workspace")
  }
  return trusted_lock
}
