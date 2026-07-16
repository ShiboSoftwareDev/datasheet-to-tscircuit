import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import ts from "typescript"
import { parseBenchmarkManifest, validateBenchmarkReferenceFiles } from "./model-scorer"
import { validateSimulationDefinitions } from "./model-simulation-validator"

interface LockedFile {
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
  return parseBenchmarkManifest(value).benchmarks.map((entry) => ({
    id: entry.id,
    reference_file: entry.reference_file,
    simulation: entry.simulation,
  }))
}

function parseBenchmarkSource(source: string, benchmark_id: string): ts.SourceFile {
  const source_file = ts.createSourceFile(
    `${benchmark_id}.circuit.tsx`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  ) as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  const diagnostic = source_file.parseDiagnostics?.[0]
  if (diagnostic) {
    throw new Error(
      `Benchmark ${benchmark_id} has invalid TSX: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
    )
  }
  return source_file
}

function readLiteralJsxAttribute(
  element: ts.JsxOpeningLikeElement,
  attribute_name: string,
): string | undefined {
  const attribute = element.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === attribute_name,
  )
  return attribute?.initializer && ts.isStringLiteral(attribute.initializer)
    ? attribute.initializer.text.trim()
    : undefined
}

function findVoltageProbe(
  source_file: ts.SourceFile,
  probe_name: string,
): { found: boolean; target?: string } {
  let result: { found: boolean; target?: string } = { found: false }
  const visit = (node: ts.Node): void => {
    if (result.found) return
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText() === "voltageprobe" &&
      readLiteralJsxAttribute(node, "name") === probe_name
    ) {
      result = { found: true, target: readLiteralJsxAttribute(node, "connectsTo") }
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source_file)
  return result
}

function assertAnalogSimulationProps(source_file: ts.SourceFile, benchmark_id: string): void {
  let count = 0
  const visit = (node: ts.Node): void => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText() === "analogsimulation"
    ) {
      count += 1
      const attribute = node.attributes.properties.find(
        (property): property is ts.JsxAttribute =>
          ts.isJsxAttribute(property) && property.name.getText() === "simulationType",
      )
      if (attribute) {
        const value =
          attribute.initializer && ts.isStringLiteral(attribute.initializer)
            ? attribute.initializer.text.trim()
            : undefined
        if (value !== "spice_transient_analysis") {
          throw new Error(
            `Benchmark ${benchmark_id} analogsimulation simulationType must be omitted or exactly "spice_transient_analysis"`,
          )
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source_file)
  if (count !== 1) {
    throw new Error(`Benchmark ${benchmark_id} must define exactly one analogsimulation`)
  }
}

function assertBenchmarkSourceContract(source: string, benchmark: BenchmarkRecord): void {
  const source_file = parseBenchmarkSource(source, benchmark.id)
  if (
    !isRecord(benchmark.simulation) ||
    typeof benchmark.simulation.probe_name !== "string" ||
    !benchmark.simulation.probe_name.trim() ||
    typeof benchmark.simulation.dut_spice_node !== "string" ||
    !benchmark.simulation.dut_spice_node.trim()
  ) {
    throw new Error(
      `Benchmark ${benchmark.id} must declare simulation.probe_name and simulation.dut_spice_node`,
    )
  }
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
  assertAnalogSimulationProps(source_file, benchmark.id)
  const probe_name = isRecord(benchmark.simulation) ? benchmark.simulation.probe_name : undefined
  if (typeof probe_name === "string") {
    const probe = findVoltageProbe(source_file, probe_name)
    if (!probe.found) {
      throw new Error(`Benchmark ${benchmark.id} must define voltage probe ${probe_name}`)
    }
    const probe_target = probe.target
    if (!probe_target || !/^(?:DUT\.[A-Za-z_$][\w$-]*|\.DUT\s*>\s*\.[A-Za-z_$][\w$-]*)$/.test(probe_target)) {
      throw new Error(
        `Benchmark ${benchmark.id} voltage probe ${probe_name} must connect directly to a DUT port, for example .DUT > .VOUT; net-only targets cannot be resolved by tscircuit simulation`,
      )
    }
  }
  if (/\b(selector|telemetry|benchmark[_ -]?code|metric[_ -]?channel)\b/i.test(source)) {
    throw new Error(`Benchmark ${benchmark.id} contains a synthetic benchmark backchannel`)
  }
}

async function readCurrentLock(model_dir: string): Promise<{
  benchmark_ids: string[]
  files: Array<LockedFile & { text: string }>
}> {
  const manifest_text = await readFile(join(model_dir, "benchmarks.json"), "utf8")
  const manifest_value = JSON.parse(manifest_text) as unknown
  const manifest = parseBenchmarkManifest(manifest_value)
  const records = parseBenchmarkRecords(manifest_value)
  for (const record of records) assertEvidenceFile(model_dir, record.reference_file)
  await validateBenchmarkReferenceFiles(model_dir, manifest)
  await validateSimulationDefinitions(
    model_dir,
    records.map((record) => record.id),
  )
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
  const generation = "generation" in value ? value.generation : 1
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) {
    throw new Error("The server-owned benchmark lock has an invalid generation")
  }
  return { ...(value as Omit<BenchmarkLock, "generation">), generation }
}

async function writeLockSnapshots(
  model_dir: string,
  files: Array<LockedFile & { text: string }>,
  generation: number,
): Promise<void> {
  const lock_root = getLockRoot(model_dir)
  const generation_root = join(lock_root, "snapshots", `generation-${String(generation).padStart(4, "0")}`)
  const current_root = join(lock_root, "snapshot")
  await rm(current_root, { recursive: true, force: true })
  await Promise.all(
    files.flatMap(({ file, text }) => [
      writeTextAtomically(join(generation_root, file), text),
      writeTextAtomically(join(current_root, file), text),
    ]),
  )
}

export async function hasBenchmarkManifest(model_dir: string): Promise<boolean> {
  return Bun.file(join(model_dir, "benchmarks.json")).exists()
}

export async function hasBenchmarkLock(model_dir: string): Promise<boolean> {
  return Bun.file(getLockFile(model_dir)).exists()
}

export async function validateBenchmarkSuiteForLock(model_dir: string): Promise<void> {
  await readCurrentLock(model_dir)
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
    generation: 1,
    locked_at,
    benchmark_ids: current.benchmark_ids,
    files: current.files.map(({ file, sha256 }) => ({ file, sha256 })),
  }
  await writeLockSnapshots(model_dir, current.files, lock.generation)
  await writeTextAtomically(lock_path, `${JSON.stringify(lock, null, 2)}\n`)
  return lock
}

export async function replaceBenchmarkLockAfterCircuitRepair(
  model_dir: string,
  expected_lock: BenchmarkLock,
): Promise<BenchmarkLock> {
  const lock_path = getLockFile(model_dir)
  const persisted = parseLock(JSON.parse(await readFile(lock_path, "utf8")) as unknown)
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
  await writeLockSnapshots(model_dir, current.files, generation)
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
