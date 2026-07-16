import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import type { AnyCircuitElement } from "circuit-json"

type SimulationExtractionDefinition = {
  kind: "transient_voltage"
  x_axis: "time_ms"
  probe_name: string
  dut_spice_node: string
  scale: number
  offset: number
}

interface SimulationGraph {
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
  partial_result_file?: string
  partial_sha256?: string
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
  status: "building" | "passed" | "failed"
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

export function parseSimulationDefinition(value: unknown): SimulationExtractionDefinition {
  if (!isRecord(value)) {
    throw new Error(
      "benchmark has no server-verifiable simulation extraction; add simulation.kind and probe mapping",
    )
  }
  if (value.kind === "transient_voltage") {
    if (value.x_axis !== "time_ms") {
      throw new Error('simulation.x_axis must be "time_ms" for transient waveform benchmarks')
    }
    return {
      kind: "transient_voltage",
      x_axis: "time_ms",
      probe_name: requiredString(value.probe_name, "simulation.probe_name"),
      dut_spice_node: requiredString(value.dut_spice_node, "simulation.dut_spice_node"),
      scale: optionalFiniteNumber(value.scale, 1, "simulation.scale"),
      offset: optionalFiniteNumber(value.offset, 0, "simulation.offset"),
    }
  }
  throw new Error(
    'simulation.kind must be "transient_voltage"; only datasheet graphs whose x-axis is elapsed time are supported',
  )
}

export async function getSimulationRunCount(model_dir: string): Promise<number> {
  const manifest: unknown = JSON.parse(await readFile(join(model_dir, "benchmarks.json"), "utf8"))
  if (!isRecord(manifest) || !Array.isArray(manifest.benchmarks) || manifest.benchmarks.length === 0) {
    throw new Error("benchmarks.json has no benchmark list")
  }
  for (const benchmark of manifest.benchmarks) {
    if (!isRecord(benchmark) || typeof benchmark.id !== "string") {
      throw new Error("benchmarks.json contains an invalid benchmark")
    }
    await readSimulationDefinition(model_dir, benchmark.id)
  }
  return manifest.benchmarks.length
}

export async function readSimulationDefinition(
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

export async function validateSimulationDefinitions(
  model_dir: string,
  benchmark_ids: string[],
): Promise<void> {
  await Promise.all(benchmark_ids.map((benchmark_id) => readSimulationDefinition(model_dir, benchmark_id)))
}

function normalizeCircuitErrorMessage(element: Record<string, unknown>): string {
  const raw = typeof element.message === "string" ? element.message : String(element.type)
  return raw.split(/\s+Details:\s+Props:/i)[0]!.trim()
}

export function getCircuitBuildDiagnostics(value: unknown): CircuitBuildDiagnostics {
  if (!isCircuitJson(value)) throw new Error("simulation did not produce Circuit JSON")
  const source_errors = new Set<string>()
  const simulation_errors = new Set<string>()
  for (const element of value) {
    if (!isRecord(element) || typeof element.type !== "string" || !element.type.endsWith("_error")) continue
    const message = normalizeCircuitErrorMessage(element)
    if (element.type.startsWith("source_")) source_errors.add(message)
    if (element.type.startsWith("simulation_")) simulation_errors.add(message)
  }
  return { source_errors: [...source_errors], simulation_errors: [...simulation_errors] }
}

function parseSimulationOutput(value: unknown): { graphs: SimulationGraph[]; errors: string[] } {
  if (!isCircuitJson(value)) throw new Error("simulation did not produce Circuit JSON")
  const diagnostics = getCircuitBuildDiagnostics(value)
  const graphs: SimulationGraph[] = []
  for (const element of value) {
    if (!isRecord(element) || typeof element.type !== "string") continue
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
  return { graphs, errors: [...diagnostics.source_errors, ...diagnostics.simulation_errors] }
}

function normalizeModelSource(source: string): string {
  return source.replace(/\r\n?/g, "\n").trim()
}

function parseSubcircuits(model_source: string): Array<{ name: string; pins: string[] }> {
  const lines = model_source.replace(/\r\n?/g, "\n").split("\n")
  const subcircuits: Array<{ name: string; pins: string[] }> = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.match(/^\s*\.\s*subckt\s+(\S+)(?:\s+(.*))?$/i)
    if (!match) continue
    const tokens = (match[2] ?? "").trim().split(/\s+/).filter(Boolean)
    while (index + 1 < lines.length) {
      const continuation = lines[index + 1]!.match(/^\s*\+\s*(.*)$/)
      if (!continuation) break
      index += 1
      tokens.push(...continuation[1]!.trim().split(/\s+/).filter(Boolean))
    }
    const parameter_index = tokens.findIndex(
      (token) => /^params?:/i.test(token) || token.includes("=") || /^[;$]/.test(token),
    )
    subcircuits.push({
      name: match[1]!,
      pins: parameter_index < 0 ? tokens : tokens.slice(0, parameter_index),
    })
  }
  return subcircuits
}

function assertNoSyntheticBenchmarkChannel(model_source: string): void {
  const comments = model_source
    .split(/\r?\n/)
    .filter((line) => /^\s*[*;$]/.test(line))
    .join("\n")
  if (/\b(selector|telemetry|benchmark[_ -]?code|metric[_ -]?channel|selected metric)\b/i.test(comments)) {
    throw new Error("model.lib declares a synthetic benchmark selector or telemetry channel")
  }
}

class Connectivity {
  private parent = new Map<string, string>()

  private root(value: string): string {
    const parent = this.parent.get(value)
    if (!parent) {
      this.parent.set(value, value)
      return value
    }
    if (parent === value) return value
    const root = this.root(parent)
    this.parent.set(value, root)
    return root
  }

  connect(values: string[]): void {
    const [first, ...rest] = values
    if (!first) return
    const first_root = this.root(first)
    for (const value of rest) this.parent.set(this.root(value), first_root)
  }

  connected(first: string, second: string): boolean {
    return this.root(first) === this.root(second)
  }
}

function portKey(port_id: string): string {
  return `port:${port_id}`
}

function netKey(net_id: string): string {
  return `net:${net_id}`
}

function assertCanonicalDutSimulation(
  circuit_json: AnyCircuitElement[],
  model_source: string,
  probe_name: string,
  dut_spice_node: string,
): void {
  const records = circuit_json.map((element) => element as unknown).filter(isRecord)
  const dut_components = records.filter(
    (element) => element.type === "source_component" && element.name === "DUT",
  )
  if (dut_components.length !== 1 || typeof dut_components[0]?.source_component_id !== "string") {
    throw new Error("simulation must contain exactly one source component named DUT")
  }
  const dut_id = dut_components[0].source_component_id
  const dut_ports = records.filter(
    (element) =>
      element.type === "source_port" &&
      element.source_component_id === dut_id &&
      typeof element.source_port_id === "string",
  )
  if (dut_ports.length === 0) throw new Error("DUT has no source ports in simulation output")

  const spice_models = records.filter(
    (element) => element.type === "simulation_spice_subcircuit" && element.source_component_id === dut_id,
  )
  if (spice_models.length !== 1 || !isRecord(spice_models[0])) {
    throw new Error("DUT must have exactly one canonical simulation_spice_subcircuit")
  }
  const spice_model = spice_models[0]
  if (
    typeof spice_model.subcircuit_source !== "string" ||
    normalizeModelSource(spice_model.subcircuit_source) !== normalizeModelSource(model_source)
  ) {
    throw new Error("DUT simulation does not use the canonical model.lib source")
  }
  if (!isRecord(spice_model.spice_pin_to_source_port_map)) {
    throw new Error("DUT SPICE pin mapping is missing")
  }
  const dut_port_ids = new Set(dut_ports.map((port) => port.source_port_id as string))
  const mapped_spice_pins = Object.keys(spice_model.spice_pin_to_source_port_map)
  const mapped_port_ids = Object.values(spice_model.spice_pin_to_source_port_map)
  if (
    mapped_port_ids.length === 0 ||
    new Set(mapped_port_ids).size !== mapped_port_ids.length ||
    mapped_port_ids.some((port_id) => typeof port_id !== "string" || !dut_port_ids.has(port_id))
  ) {
    throw new Error("DUT SPICE pin mapping does not resolve exclusively to DUT ports")
  }
  const first_subcircuit = parseSubcircuits(model_source)[0]
  const sorted_mapping = [...mapped_spice_pins].sort()
  if (
    !first_subcircuit ||
    first_subcircuit.pins.length === 0 ||
    JSON.stringify([...first_subcircuit.pins].sort()) !== JSON.stringify(sorted_mapping)
  ) {
    throw new Error(
      "DUT SPICE pin mapping must cover every .SUBCKT pin in the first declaration exactly once with matching case",
    )
  }

  const probes = records.filter(
    (element) => element.type === "simulation_voltage_probe" && element.name === probe_name,
  )
  if (probes.length !== 1 || !isRecord(probes[0])) {
    throw new Error(`simulation must contain exactly one voltage probe named ${probe_name}`)
  }
  const probe = probes[0]
  const signal_key =
    typeof probe.signal_input_source_port_id === "string"
      ? portKey(probe.signal_input_source_port_id)
      : typeof probe.signal_input_source_net_id === "string"
        ? netKey(probe.signal_input_source_net_id)
        : undefined
  if (!signal_key) throw new Error(`${probe_name} has no signal input connectivity`)

  const connectivity = new Connectivity()
  for (const trace of records) {
    if (trace.type !== "source_trace") continue
    const connected = [
      ...(Array.isArray(trace.connected_source_port_ids)
        ? trace.connected_source_port_ids.filter((id): id is string => typeof id === "string").map(portKey)
        : []),
      ...(Array.isArray(trace.connected_source_net_ids)
        ? trace.connected_source_net_ids.filter((id): id is string => typeof id === "string").map(netKey)
        : []),
    ]
    connectivity.connect(connected)
  }
  const expected_mapping = Object.entries(spice_model.spice_pin_to_source_port_map).find(
    ([spice_pin]) => spice_pin.toLowerCase() === dut_spice_node.toLowerCase(),
  )
  const expected_port_id = expected_mapping?.[1]
  if (typeof expected_port_id !== "string") {
    throw new Error(`simulation.dut_spice_node ${dut_spice_node} is not mapped by the canonical DUT`)
  }
  if (!connectivity.connected(signal_key, portKey(expected_port_id))) {
    throw new Error(
      `${probe_name} must measure canonical DUT SPICE node ${dut_spice_node}, not another DUT pin`,
    )
  }

  const voltage_source_endpoint_keys = records
    .filter((element) => element.type === "simulation_voltage_source")
    .flatMap((source) => {
      const keys: string[] = []
      for (const field of [
        "positive_source_port_id",
        "negative_source_port_id",
        "terminal1_source_port_id",
        "terminal2_source_port_id",
      ] as const) {
        if (typeof source[field] === "string") keys.push(portKey(source[field]))
      }
      for (const field of [
        "positive_source_net_id",
        "negative_source_net_id",
        "terminal1_source_net_id",
        "terminal2_source_net_id",
      ] as const) {
        if (typeof source[field] === "string") keys.push(netKey(source[field]))
      }
      return keys
    })
  if (voltage_source_endpoint_keys.some((endpoint) => connectivity.connected(signal_key, endpoint))) {
    throw new Error(`${probe_name} is tied directly to an independent voltage source`)
  }
}

function requireGraph(graphs: SimulationGraph[], probe_name: string): SimulationGraph {
  const matches = graphs.filter((candidate) => candidate.name === probe_name)
  if (matches.length === 0) throw new Error(`simulation produced no voltage graph named ${probe_name}`)
  if (matches.length > 1) throw new Error(`simulation produced multiple voltage graphs named ${probe_name}`)
  return matches[0]!
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
        (benchmark.status !== undefined &&
          benchmark.status !== "building" &&
          benchmark.status !== "passed" &&
          benchmark.status !== "failed") ||
        typeof benchmark.generated_at !== "string",
    )
  ) {
    return undefined
  }
  return value as unknown as SimulationValidationReport
}

export async function getSimulationBenchmarkVerification(
  model_dir: string,
  benchmark_id: string,
): Promise<SimulationBenchmarkVerification | undefined> {
  assertSafeBenchmarkId(benchmark_id)
  const report = await readTrustedReport(model_dir)
  return report?.benchmarks.find((benchmark) => benchmark.benchmark_id === benchmark_id)
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

export async function verifyPartialSimulationBenchmark(input: {
  model_dir: string
  benchmark_id: string
  source_signature?: string
  circuit_json_paths: Array<{ path: string }>
}): Promise<SimulationBenchmarkVerification> {
  const generated_at = new Date().toISOString()
  assertSafeBenchmarkId(input.benchmark_id)
  const definition = await readSimulationDefinition(input.model_dir, input.benchmark_id)
  const source_path = join(input.model_dir, "benchmarks", `${input.benchmark_id}.circuit.tsx`)
  const supplied_paths = [...input.circuit_json_paths]
  if (supplied_paths.length === 0) throw new Error("partial validation has no simulator output")

  if (supplied_paths.length !== 1) {
    throw new Error("transient waveform validation requires exactly one simulator output")
  }
  const paths = supplied_paths
  const [source_text, model_source, ...circuit_texts] = await Promise.all([
    readFile(source_path, "utf8"),
    readFile(join(input.model_dir, "model.lib"), "utf8"),
    ...paths.map(({ path }) => readFile(path, "utf8")),
  ])
  const circuit_jsons = circuit_texts.map((text) => JSON.parse(text) as unknown)
  if (circuit_jsons.some((json) => !isCircuitJson(json))) {
    throw new Error("partial simulation did not produce valid Circuit JSON")
  }
  const parsed = circuit_jsons.map((json) => parseSimulationOutput(json))
  const errors = [...new Set(parsed.flatMap(({ errors }) => errors))]
  if (errors.length > 0) throw new Error(errors.join("; "))
  assertNoSyntheticBenchmarkChannel(model_source)
  for (const circuit of circuit_jsons) {
    assertCanonicalDutSimulation(
      circuit as AnyCircuitElement[],
      model_source,
      definition.probe_name,
      definition.dut_spice_node,
    )
  }

  const graph = requireGraph(parsed[0]!.graphs, definition.probe_name)
  const points = graph.timestamps_ms.map((x, index) => ({
    x,
    y: graph.voltage_levels[index]! * definition.scale + definition.offset,
  }))
  const text = toCsv(points)
  const trusted_result_file = join(
    getValidationRoot(input.model_dir),
    "partial-results",
    `${input.benchmark_id}.csv`,
  )
  const diagnostic_result_file = join(input.model_dir, "results", "partial", `${input.benchmark_id}.csv`)
  await Promise.all([
    writeTextAtomically(trusted_result_file, text),
    writeTextAtomically(diagnostic_result_file, text),
  ])
  const artifact = await writeArtifactCopies({
    model_dir: input.model_dir,
    benchmark_id: input.benchmark_id,
    circuit_text: circuit_texts[0]!,
    source_text,
  })
  return {
    benchmark_id: input.benchmark_id,
    passed: false,
    status: "building",
    generated_at,
    ...artifact,
    source_signature:
      input.source_signature ??
      (await getModelSimulationSourceSignature(input.model_dir, input.benchmark_id)),
    partial_result_file: relative(getValidationRoot(input.model_dir), trusted_result_file),
    partial_sha256: hashText(text),
  }
}

export async function verifySimulationBenchmark(input: {
  model_dir: string
  benchmark_id: string
  source_signature?: string
  circuit_json_paths?: Array<{ path: string }>
}): Promise<SimulationBenchmarkVerification> {
  const generated_at = new Date().toISOString()
  let artifact: Partial<SimulationBenchmarkVerification> = {}
  try {
    assertSafeBenchmarkId(input.benchmark_id)
    const job_dir = dirname(input.model_dir)
    const source_path = join(input.model_dir, "benchmarks", `${input.benchmark_id}.circuit.tsx`)
    const circuit_json_path = join(job_dir, "dist", "spice", "benchmarks", input.benchmark_id, "circuit.json")
    const definition = await readSimulationDefinition(input.model_dir, input.benchmark_id)
    const supplied_paths: Array<{ path: string }> = input.circuit_json_paths?.length
      ? input.circuit_json_paths
      : [{ path: circuit_json_path }]
    if (supplied_paths.length !== 1) {
      throw new Error("transient waveform validation requires exactly one simulator output")
    }
    const paths = supplied_paths
    const [source_text, model_source, ...circuit_texts] = await Promise.all([
      readFile(source_path, "utf8"),
      readFile(join(input.model_dir, "model.lib"), "utf8"),
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

    const parsed = circuit_jsons.map((json) => parseSimulationOutput(json))
    const errors = [...new Set(parsed.flatMap(({ errors }) => errors))]
    if (errors.length > 0) throw new Error(errors.join("; "))
    assertNoSyntheticBenchmarkChannel(model_source)
    for (const circuit of circuit_jsons) {
      assertCanonicalDutSimulation(
        circuit as AnyCircuitElement[],
        model_source,
        definition.probe_name,
        definition.dut_spice_node,
      )
    }

    const graph = requireGraph(parsed[0]!.graphs, definition.probe_name)
    const points = graph.timestamps_ms.map((x, index) => ({
      x,
      y: graph.voltage_levels[index]! * definition.scale + definition.offset,
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
      status: "passed",
      generated_at,
      ...artifact,
      verified_result_file: relative(getValidationRoot(input.model_dir), trusted_result_file),
      sha256: hashText(text),
    }
  } catch (error) {
    return {
      benchmark_id: input.benchmark_id,
      passed: false,
      status: "failed",
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
  let result_file: string | undefined
  if (result.passed) {
    if (typeof result.verified_result_file !== "string" || typeof result.sha256 !== "string") {
      return undefined
    }
    const result_path = resolveInside(trusted_root, result.verified_result_file)
    if (!result_path) return undefined
    result_text = await readFile(result_path, "utf8")
    if (hashText(result_text) !== result.sha256) return undefined
    result_file = `results/verified/${benchmark_id}.csv`
  } else if (
    result.status === "building" &&
    typeof result.partial_result_file === "string" &&
    typeof result.partial_sha256 === "string"
  ) {
    const result_path = resolveInside(trusted_root, result.partial_result_file)
    if (!result_path) return undefined
    result_text = await readFile(result_path, "utf8")
    if (hashText(result_text) !== result.partial_sha256) return undefined
    result_file = `results/partial/${benchmark_id}.csv`
  }
  return {
    benchmark_id,
    passed: result.passed,
    generated_at: result.generated_at,
    source_file: result.source_file,
    source_signature: result.source_signature,
    code,
    circuit_json,
    result_file,
    result_text,
    error_message: result.error_message,
    status: result.status ?? (result.passed ? "passed" : "failed"),
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
  const manifest: unknown = await readFile(join(model_dir, "benchmarks.json"), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined)
  if (!isRecord(manifest) || !Array.isArray(manifest.benchmarks)) return false
  const benchmark_ids = manifest.benchmarks.flatMap((benchmark) =>
    isRecord(benchmark) && typeof benchmark.id === "string" ? [benchmark.id] : [],
  )
  if (
    benchmark_ids.length !== manifest.benchmarks.length ||
    JSON.stringify([...benchmark_ids].sort()) !==
      JSON.stringify(report.benchmarks.map((benchmark) => benchmark.benchmark_id).sort())
  ) {
    return false
  }
  const definitions_are_current = await Promise.all(
    benchmark_ids.map((benchmark_id) =>
      readSimulationDefinition(model_dir, benchmark_id)
        .then(() => true)
        .catch(() => false),
    ),
  )
  if (definitions_are_current.some((is_current) => !is_current)) return false
  const artifacts = await Promise.all(
    report.benchmarks.map(async (benchmark) => {
      const [artifact, current_signature] = await Promise.all([
        getVerifiedSimulationArtifact(model_dir, benchmark.benchmark_id).catch(() => undefined),
        getModelSimulationSourceSignature(model_dir, benchmark.benchmark_id).catch(() => undefined),
      ])
      return artifact?.source_signature && artifact.source_signature === current_signature
        ? artifact
        : undefined
    }),
  )
  return artifacts.every((artifact) => artifact?.passed === true && Boolean(artifact.result_text))
}
