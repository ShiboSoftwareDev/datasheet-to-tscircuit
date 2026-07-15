import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import type { AnyCircuitElement } from "circuit-json"

type ProbeReducer = "last" | "tail_mean" | "peak_to_peak" | "frequency_hz"

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

interface ParameterSweepPoint {
  x: number
  props: Record<string, JsonValue>
}

type SimulationExtractionDefinition =
  | { kind: "transient_voltage"; probe_name: string; scale: number; offset: number }
  | {
      kind: "parameter_sweep"
      probe_name: string
      reducer: ProbeReducer
      scale: number
      offset: number
      points: ParameterSweepPoint[]
    }

interface SimulationGraph {
  name: string
  timestamps_ms: number[]
  voltage_levels: number[]
}

export interface SimulationBenchmarkVerification {
  benchmark_id: string
  passed: boolean
  generated_at: string
  source_file?: string
  source_sha256?: string
  source_signature?: string
  circuit_json_file?: string
  circuit_json_sha256?: string
  error_message?: string
  verified_result_file?: string
  sha256?: string
}

interface SimulationValidationReport {
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
  error_message?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCircuitJson(value: unknown): value is AnyCircuitElement[] {
  return (
    Array.isArray(value) &&
    value.every(
      (element) => typeof element === "object" && element !== null && typeof element.type === "string",
    )
  )
}

function assertSafeBenchmarkId(benchmark_id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(benchmark_id)) {
    throw new Error(`Invalid benchmark id ${benchmark_id}`)
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function optionalFiniteNumber(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`)
  return value
}

function parseReducer(value: unknown, fallback: ProbeReducer): ProbeReducer {
  if (value === undefined) return fallback
  if (value === "last" || value === "tail_mean" || value === "peak_to_peak" || value === "frequency_hz") {
    return value
  }
  throw new Error("simulation reducer must be last, tail_mean, peak_to_peak, or frequency_hz")
}

function parseSimulationDefinition(value: unknown): SimulationExtractionDefinition {
  if (!isRecord(value)) {
    throw new Error(
      "benchmark has no server-verifiable simulation extraction; add simulation.kind and probe mapping",
    )
  }
  if (value.kind === "transient_voltage") {
    return {
      kind: "transient_voltage",
      probe_name: requiredString(value.probe_name, "simulation.probe_name"),
      scale: optionalFiniteNumber(value.scale, 1, "simulation.scale"),
      offset: optionalFiniteNumber(value.offset, 0, "simulation.offset"),
    }
  }
  if (value.kind === "probe_sweep") {
    throw new Error(
      "simulation.kind probe_sweep is obsolete: use parameter_sweep with one DUT and injected props; do not duplicate the circuit for sweep points",
    )
  }
  if (value.kind === "parameter_sweep") {
    if (!Array.isArray(value.points) || value.points.length < 2) {
      throw new Error("simulation.points must contain at least two parameter-sweep points")
    }
    return {
      kind: "parameter_sweep",
      points: value.points.map((point, index) => {
        if (!isRecord(point)) throw new Error(`simulation point ${index + 1} must be an object`)
        if (typeof point.x !== "number" || !Number.isFinite(point.x)) {
          throw new Error(`simulation point ${index + 1} has an invalid x value`)
        }
        return {
          x: point.x,
          props: (() => {
            if (!isRecord(point.props))
              throw new Error(`simulation point ${index + 1} props must be an object`)
            return point.props as Record<string, JsonValue>
          })(),
        }
      }),
      probe_name: requiredString(value.probe_name, "simulation.probe_name"),
      reducer: parseReducer(value.reducer, "tail_mean"),
      scale: optionalFiniteNumber(value.scale, 1, "simulation.scale"),
      offset: optionalFiniteNumber(value.offset, 0, "simulation.offset"),
    }
  }
  throw new Error("simulation.kind must be transient_voltage or parameter_sweep")
}

export async function getSimulationBuildPlan(
  model_dir: string,
  benchmark_id: string,
): Promise<Array<{ run_id: string; x?: number; props?: Record<string, JsonValue> }>> {
  const definition = await readSimulationDefinition(model_dir, benchmark_id)
  if (definition.kind !== "parameter_sweep") return [{ run_id: "default" }]
  return definition.points.map((point, index) => ({
    run_id: `point-${String(index).padStart(3, "0")}`,
    x: point.x,
    props: point.props,
  }))
}

async function readSimulationDefinition(
  model_dir: string,
  benchmark_id: string,
): Promise<SimulationExtractionDefinition> {
  const manifest: unknown = JSON.parse(await readFile(join(model_dir, "benchmarks.json"), "utf8"))
  if (!isRecord(manifest) || !Array.isArray(manifest.benchmarks)) {
    throw new Error("benchmarks.json has no benchmark list")
  }
  const benchmark = manifest.benchmarks.find(
    (candidate) => isRecord(candidate) && candidate.id === benchmark_id,
  )
  if (!isRecord(benchmark)) throw new Error(`benchmarks.json has no ${benchmark_id} benchmark`)
  return parseSimulationDefinition(benchmark.simulation)
}

function parseSimulationOutput(value: unknown): { graphs: SimulationGraph[]; errors: string[] } {
  if (!isCircuitJson(value)) throw new Error("simulation did not produce Circuit JSON")
  const errors: string[] = []
  const graphs: SimulationGraph[] = []
  for (const element of value) {
    if (!isRecord(element) || typeof element.type !== "string") continue
    const blocks_simulation = element.type.startsWith("simulation_") || element.type.startsWith("source_")
    if (blocks_simulation && element.type.endsWith("_error")) {
      errors.push(
        "message" in element && typeof element.message === "string" ? element.message : element.type,
      )
    }
    if (element.type !== "simulation_transient_voltage_graph") continue
    if (
      typeof element.name !== "string" ||
      !Array.isArray(element.timestamps_ms) ||
      !Array.isArray(element.voltage_levels)
    ) {
      continue
    }
    if (
      element.timestamps_ms.length !== element.voltage_levels.length ||
      element.timestamps_ms.length < 2 ||
      !element.timestamps_ms.every((entry) => typeof entry === "number" && Number.isFinite(entry)) ||
      !element.voltage_levels.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ) {
      continue
    }
    graphs.push({
      name: element.name,
      timestamps_ms: element.timestamps_ms as number[],
      voltage_levels: element.voltage_levels as number[],
    })
  }
  return { graphs, errors }
}

function requireGraph(graphs: SimulationGraph[], probe_name: string): SimulationGraph {
  const matches = graphs.filter((candidate) => candidate.name === probe_name)
  if (matches.length === 0) throw new Error(`simulation produced no voltage graph named ${probe_name}`)
  if (matches.length > 1)
    throw new Error(
      `simulation produced multiple voltage graphs named ${probe_name}; parameter sweeps require one DUT and one common probe`,
    )
  return matches[0]!
}

function reduceGraph(graph: SimulationGraph, reducer: ProbeReducer): number {
  if (reducer === "last") return graph.voltage_levels.at(-1)!
  const tail_start = Math.floor(graph.voltage_levels.length * 0.8)
  const tail = graph.voltage_levels.slice(tail_start)
  if (reducer === "tail_mean") return tail.reduce((sum, value) => sum + value, 0) / tail.length
  if (reducer === "peak_to_peak") return Math.max(...tail) - Math.min(...tail)

  const search_start = Math.floor(graph.voltage_levels.length * 0.25)
  const levels = graph.voltage_levels.slice(search_start)
  const timestamps = graph.timestamps_ms.slice(search_start)
  const minimum = Math.min(...levels)
  const maximum = Math.max(...levels)
  if (maximum - minimum <= 1e-12) throw new Error(`${graph.name} has no measurable oscillation`)
  const threshold = (minimum + maximum) / 2
  const crossings: number[] = []
  for (let index = 1; index < levels.length; index += 1) {
    const left = levels[index - 1]!
    const right = levels[index]!
    if (left >= threshold || right < threshold || right === left) continue
    const ratio = (threshold - left) / (right - left)
    crossings.push(timestamps[index - 1]! + ratio * (timestamps[index]! - timestamps[index - 1]!))
  }
  if (crossings.length < 2) throw new Error(`${graph.name} has too few rising edges for frequency`)
  const periods = crossings.slice(1).map((crossing, index) => crossing - crossings[index]!)
  const average_period_ms = periods.reduce((sum, value) => sum + value, 0) / periods.length
  if (!(average_period_ms > 0)) throw new Error(`${graph.name} has an invalid oscillation period`)
  return 1_000 / average_period_ms
}

function toCsv(points: Array<{ x: number; y: number }>): string {
  return `x,y\n${points.map((point) => `${point.x},${point.y}`).join("\n")}\n`
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

async function writeTextAtomically(file_path: string, text: string): Promise<void> {
  await mkdir(dirname(file_path), { recursive: true })
  const temporary_path = `${file_path}.${crypto.randomUUID()}.tmp`
  await Bun.write(temporary_path, text)
  await rename(temporary_path, file_path)
}

export async function getModelSimulationSourceSignature(
  model_dir: string,
  benchmark_id: string,
): Promise<string> {
  assertSafeBenchmarkId(benchmark_id)
  const files = [
    join("benchmarks", `${benchmark_id}.circuit.tsx`),
    "model.lib",
    "component-with-model.circuit.tsx",
    "component.circuit.tsx",
    "benchmarks.json",
  ]
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(file)
    hash.update("\0")
    hash.update(await readFile(join(model_dir, file), "utf8").catch(() => ""))
    hash.update("\0")
  }
  return hash.digest("hex")
}

function getValidationRoot(model_dir: string): string {
  return join(dirname(model_dir), ".model-validation")
}

export function getVerifiedResultsDirectory(model_dir: string): string {
  return join(getValidationRoot(model_dir), "results")
}

function resolveInside(root: string, file: string): string | undefined {
  const resolved_root = resolve(root)
  const resolved_file = resolve(resolved_root, file)
  return resolved_file.startsWith(`${resolved_root}${sep}`) ? resolved_file : undefined
}

async function readTrustedReport(model_dir: string): Promise<SimulationValidationReport | undefined> {
  const value: unknown = await readFile(
    join(getValidationRoot(model_dir), "simulation-validation.json"),
    "utf8",
  )
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined)
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !Array.isArray(value.benchmarks) ||
    value.benchmarks.some(
      (benchmark) =>
        !isRecord(benchmark) ||
        typeof benchmark.benchmark_id !== "string" ||
        typeof benchmark.passed !== "boolean" ||
        typeof benchmark.generated_at !== "string",
    )
  ) {
    return undefined
  }
  return value as unknown as SimulationValidationReport
}

async function writeArtifactCopies(input: {
  model_dir: string
  benchmark_id: string
  circuit_text: string
  source_text: string
}): Promise<
  Pick<
    SimulationBenchmarkVerification,
    "source_file" | "source_sha256" | "circuit_json_file" | "circuit_json_sha256"
  >
> {
  const trusted_root = getValidationRoot(input.model_dir)
  const trusted_benchmark_dir = join(trusted_root, "benchmarks", input.benchmark_id)
  const diagnostic_dir = join(input.model_dir, "validation-artifacts", input.benchmark_id)
  await Promise.all([
    mkdir(trusted_benchmark_dir, { recursive: true }),
    mkdir(diagnostic_dir, { recursive: true }),
  ])
  await Promise.all([
    writeTextAtomically(join(trusted_benchmark_dir, "circuit.json"), input.circuit_text),
    writeTextAtomically(join(trusted_benchmark_dir, "source.circuit.tsx"), input.source_text),
    writeTextAtomically(join(diagnostic_dir, "circuit.json"), input.circuit_text),
    writeTextAtomically(join(diagnostic_dir, "source.circuit.tsx"), input.source_text),
  ])
  return {
    source_file: relative(
      input.model_dir,
      join(input.model_dir, "benchmarks", `${input.benchmark_id}.circuit.tsx`),
    ),
    source_sha256: hashText(input.source_text),
    circuit_json_file: relative(trusted_root, join(trusted_benchmark_dir, "circuit.json")),
    circuit_json_sha256: hashText(input.circuit_text),
  }
}

export async function clearVerifiedSimulationResults(model_dir: string): Promise<void> {
  await Promise.all([
    rm(getValidationRoot(model_dir), { recursive: true, force: true }),
    rm(join(model_dir, "results", "verified"), { recursive: true, force: true }),
    rm(join(model_dir, "validation-artifacts"), { recursive: true, force: true }),
    rm(join(model_dir, "simulation-validation.json"), { force: true }),
  ])
}

export async function verifySimulationBenchmark(input: {
  model_dir: string
  benchmark_id: string
  source_signature?: string
  circuit_json_paths?: Array<{ path: string; x: number }>
}): Promise<SimulationBenchmarkVerification> {
  const generated_at = new Date().toISOString()
  let artifact: Partial<SimulationBenchmarkVerification> = {}
  try {
    assertSafeBenchmarkId(input.benchmark_id)
    const job_dir = dirname(input.model_dir)
    const source_path = join(input.model_dir, "benchmarks", `${input.benchmark_id}.circuit.tsx`)
    const circuit_json_path = join(job_dir, "dist", "spice", "benchmarks", input.benchmark_id, "circuit.json")
    const paths = input.circuit_json_paths?.length ? input.circuit_json_paths : [{ path: circuit_json_path }]
    const [source_text, ...circuit_texts] = await Promise.all([
      readFile(source_path, "utf8"),
      ...paths.map(({ path }) => readFile(path, "utf8")),
    ])
    const circuit_jsons = circuit_texts.map((text) => JSON.parse(text) as unknown)
    if (circuit_jsons.some((json) => !isCircuitJson(json)))
      throw new Error("simulation did not produce valid Circuit JSON")
    const circuit_text = circuit_texts[0]!
    const circuit_json = circuit_jsons[0] as AnyCircuitElement[]
    artifact = {
      ...(await writeArtifactCopies({
        model_dir: input.model_dir,
        benchmark_id: input.benchmark_id,
        circuit_text,
        source_text,
      })),
      source_signature:
        input.source_signature ??
        (await getModelSimulationSourceSignature(input.model_dir, input.benchmark_id)),
    }

    const definition = await readSimulationDefinition(input.model_dir, input.benchmark_id)
    const parsed = circuit_jsons.map((json) => parseSimulationOutput(json))
    const errors = parsed.flatMap(({ errors }) => errors)
    if (errors.length > 0) throw new Error(errors.join("; "))

    const points =
      definition.kind === "transient_voltage"
        ? (() => {
            const graph = requireGraph(parsed[0]!.graphs, definition.probe_name)
            return graph.timestamps_ms.map((x, index) => ({
              x,
              y: graph.voltage_levels[index]! * definition.scale + definition.offset,
            }))
          })()
        : definition.points.map((point, index) => ({
            x: point.x,
            y:
              reduceGraph(requireGraph(parsed[index]!.graphs, definition.probe_name), definition.reducer) *
                definition.scale +
              definition.offset,
          }))
    const text = toCsv(points)
    const trusted_result_file = join(
      getVerifiedResultsDirectory(input.model_dir),
      `${input.benchmark_id}.csv`,
    )
    const diagnostic_result_file = join(input.model_dir, "results", "verified", `${input.benchmark_id}.csv`)
    const diagnostic_artifact_file = join(
      input.model_dir,
      "validation-artifacts",
      input.benchmark_id,
      "result.csv",
    )
    await Promise.all([
      mkdir(dirname(trusted_result_file), { recursive: true }),
      mkdir(dirname(diagnostic_result_file), { recursive: true }),
    ])
    await Promise.all([
      writeTextAtomically(trusted_result_file, text),
      writeTextAtomically(diagnostic_result_file, text),
      writeTextAtomically(diagnostic_artifact_file, text),
    ])
    return {
      benchmark_id: input.benchmark_id,
      passed: true,
      generated_at,
      ...artifact,
      verified_result_file: relative(getValidationRoot(input.model_dir), trusted_result_file),
      sha256: hashText(text),
    }
  } catch (error) {
    return {
      benchmark_id: input.benchmark_id,
      passed: false,
      generated_at,
      ...artifact,
      error_message: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function writeSimulationValidationReport(
  model_dir: string,
  benchmarks: SimulationBenchmarkVerification[],
): Promise<void> {
  const report: SimulationValidationReport = {
    version: 2,
    generated_at: new Date().toISOString(),
    benchmarks,
  }
  const text = `${JSON.stringify(report, null, 2)}\n`
  await Promise.all([
    writeTextAtomically(join(getValidationRoot(model_dir), "simulation-validation.json"), text),
    writeTextAtomically(join(model_dir, "simulation-validation.json"), text),
  ])
}

export async function getVerifiedSimulationArtifact(
  model_dir: string,
  benchmark_id: string,
): Promise<VerifiedSimulationArtifact | undefined> {
  assertSafeBenchmarkId(benchmark_id)
  const report = await readTrustedReport(model_dir)
  const result = report?.benchmarks.find((candidate) => candidate.benchmark_id === benchmark_id)
  if (
    !result ||
    typeof result.passed !== "boolean" ||
    typeof result.generated_at !== "string" ||
    typeof result.source_file !== "string" ||
    typeof result.source_sha256 !== "string" ||
    typeof result.circuit_json_file !== "string" ||
    typeof result.circuit_json_sha256 !== "string"
  ) {
    return undefined
  }
  const trusted_root = getValidationRoot(model_dir)
  const circuit_path = resolveInside(trusted_root, result.circuit_json_file)
  const source_path = resolveInside(trusted_root, join("benchmarks", benchmark_id, "source.circuit.tsx"))
  if (!circuit_path || !source_path) return undefined
  const [circuit_text, code] = await Promise.all([
    readFile(circuit_path, "utf8"),
    readFile(source_path, "utf8"),
  ])
  if (hashText(circuit_text) !== result.circuit_json_sha256 || hashText(code) !== result.source_sha256) {
    return undefined
  }
  const circuit_json: unknown = JSON.parse(circuit_text)
  if (!isCircuitJson(circuit_json)) return undefined

  let result_text: string | undefined
  if (result.passed) {
    if (typeof result.verified_result_file !== "string" || typeof result.sha256 !== "string") {
      return undefined
    }
    const result_path = resolveInside(trusted_root, result.verified_result_file)
    if (!result_path) return undefined
    result_text = await readFile(result_path, "utf8")
    if (hashText(result_text) !== result.sha256) return undefined
  }
  return {
    benchmark_id,
    passed: result.passed,
    generated_at: result.generated_at,
    source_file: result.source_file,
    source_signature: result.source_signature,
    code,
    circuit_json,
    result_file: result.passed ? `results/verified/${benchmark_id}.csv` : undefined,
    result_text,
    error_message: result.error_message,
  }
}

export async function getVerifiedResultFile(
  model_dir: string,
  benchmark_id: string,
): Promise<string | undefined> {
  const artifact = await getVerifiedSimulationArtifact(model_dir, benchmark_id)
  return artifact?.passed ? artifact.result_file : undefined
}

export async function hasCompleteVerifiedSimulationReport(model_dir: string): Promise<boolean> {
  const report = await readTrustedReport(model_dir)
  if (!report || report.benchmarks.length === 0) return false
  if (report.benchmarks.some((benchmark) => !benchmark.passed)) return false
  const artifacts = await Promise.all(
    report.benchmarks.map((benchmark) =>
      getVerifiedSimulationArtifact(model_dir, benchmark.benchmark_id).catch(() => undefined),
    ),
  )
  return artifacts.every((artifact) => artifact?.passed === true && Boolean(artifact.result_text))
}
