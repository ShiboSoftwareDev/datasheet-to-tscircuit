import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises"
import { delimiter, dirname, join, relative } from "node:path"
import type { JobLogStream, ModelManifest, ModelProgress, ModelProgressPhase } from "@/shared/job-types"
import ts from "typescript"
import type { JobStore } from "./job-store"
import { ensureJobTscircuitRuntimeConfig } from "./job-scaffold"
import { startModelArtifactMonitor, type ModelArtifactMonitor } from "./model-artifact-monitor"
import {
  type BenchmarkLock,
  createOrVerifyBenchmarkLock,
  hasBenchmarkLock,
  hasBenchmarkManifest,
  replaceBenchmarkLockAfterCircuitRepair,
  validateBenchmarkSuiteForLock,
  verifyBenchmarkLock,
} from "./model-benchmark-lock"
import { startModelProgressMonitor, type ModelProgressMonitor } from "./model-progress"
import {
  buildModelAgentPrompt,
  buildModelBenchmarkPrompt,
  buildModelSetupPrompt,
  copyComponentIntoModelWorkspace,
  writeModelScaffold,
} from "./model-scaffold"
import type { ModelRunStore } from "./model-run-store"
import { parseBenchmarkManifest, scoreModelBenchmarks } from "./model-scorer"
import {
  clearVerifiedSimulationResults,
  getCircuitBuildDiagnostics,
  getModelSimulationSourceSignature,
  getSimulationRunCount,
  getVerifiedResultsDirectory,
  hasCompleteVerifiedSimulationReport,
  type SimulationBenchmarkVerification,
  verifyPartialSimulationBenchmark,
  verifySimulationBenchmark,
  writeSimulationValidationReport,
} from "./model-simulation-validator"

export interface ModelRunnerContext {
  job_store: JobStore
  model_run_store: ModelRunStore
  agent_bin: string
  tsci_bin: string
}

interface StreamModelProcessInput {
  command: string[]
  cwd: string
  signal: AbortSignal
  on_chunk: (stream: JobLogStream, message: string) => Promise<void>
}

class ModelProcessStaleError extends Error {
  constructor() {
    super("The model run timed out after producing no output.")
    this.name = "ModelProcessStaleError"
  }
}

class ModelInfrastructureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelInfrastructureError"
  }
}

const DEFAULT_MODEL_STALE_TIMEOUT_MS = 10 * 60_000

function killProcessGroup(child_process: Bun.Subprocess, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") child_process.kill(signal)
    else process.kill(-child_process.pid, signal)
  } catch {
    if (child_process.exitCode === null) child_process.kill(signal)
  }
}

async function readProcessStream(input: {
  readable: ReadableStream<Uint8Array>
  stream: "stdout" | "stderr"
  on_chunk: StreamModelProcessInput["on_chunk"]
}): Promise<void> {
  const reader = input.readable.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const message = decoder.decode(chunk.value, { stream: true })
      if (message) await input.on_chunk(input.stream, message)
    }
    const final_message = decoder.decode()
    if (final_message) await input.on_chunk(input.stream, final_message)
  } finally {
    reader.releaseLock()
  }
}

async function streamModelProcess(input: StreamModelProcessInput): Promise<number> {
  if (input.signal.aborted) return 143
  const inherited_path = process.env.PATH ?? ""
  const command_path = input.command[0]?.includes("/")
    ? `${dirname(input.command[0])}${delimiter}${inherited_path}`
    : inherited_path
  const child_process = Bun.spawn(input.command, {
    cwd: input.cwd,
    detached: true,
    env: { ...process.env, PATH: command_path },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  const configured_stale_timeout = Number(
    process.env.MODEL_STALE_TIMEOUT_MS ?? DEFAULT_MODEL_STALE_TIMEOUT_MS,
  )
  const stale_timeout_ms = Number.isFinite(configured_stale_timeout)
    ? Math.max(1_000, configured_stale_timeout)
    : DEFAULT_MODEL_STALE_TIMEOUT_MS
  let stale = false
  let stale_timer: ReturnType<typeof setTimeout> | undefined
  let force_kill_timer: ReturnType<typeof setTimeout> | undefined
  const stop_process = () => {
    killProcessGroup(child_process, "SIGTERM")
    force_kill_timer = setTimeout(() => killProcessGroup(child_process, "SIGKILL"), 2_000)
  }
  const arm_stale_timer = () => {
    if (stale_timer) clearTimeout(stale_timer)
    stale_timer = setTimeout(() => {
      stale = true
      stop_process()
    }, stale_timeout_ms)
  }
  const on_chunk: StreamModelProcessInput["on_chunk"] = async (stream, message) => {
    arm_stale_timer()
    await input.on_chunk(stream, message)
  }
  arm_stale_timer()
  input.signal.addEventListener("abort", stop_process, { once: true })

  try {
    const [exit_code] = await Promise.all([
      child_process.exited,
      readProcessStream({ readable: child_process.stdout, stream: "stdout", on_chunk }),
      readProcessStream({ readable: child_process.stderr, stream: "stderr", on_chunk }),
    ])
    if (stale) throw new ModelProcessStaleError()
    return exit_code
  } finally {
    input.signal.removeEventListener("abort", stop_process)
    if (force_kill_timer) clearTimeout(force_kill_timer)
    if (stale_timer) clearTimeout(stale_timer)
  }
}

function captureProcessOutput(current: string, message: string): string {
  return `${current}${message}`.slice(-16_000)
}

function summarizeProcessFailure(output: string): string | undefined {
  const lines = output
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const diagnostic_lines = lines.filter((line) =>
    /(?:fatal error|error:|could not create|build completed with errors|build exiting with code|enoent|timed out)/i.test(
      line,
    ),
  )
  const selected = diagnostic_lines.length > 0 ? diagnostic_lines.slice(-4) : lines.slice(-8)
  const unique = selected.filter((line, index) => selected.indexOf(line) === index)
  return unique.length > 0 ? unique.join(" | ").slice(-4_000) : undefined
}

function summarizeValidationFeedback(message: string | undefined, fallback: string): string {
  if (!message) return fallback
  const concise = message
    .split(/\s+Details:\s+Props:/i)[0]!
    .replace(/\s+/g, " ")
    .trim()
  return concise.length > 1_200 ? `${concise.slice(0, 1_197)}…` : concise
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseModelManifest(value: unknown): ModelManifest {
  if (!isRecord(value) || value.version !== 1) throw new Error("model-manifest.json must be version 1")
  const required_strings = [
    "part_number",
    "entry_name",
    "model_file",
    "revision",
    "simulator",
    "generated_at",
  ] as const
  for (const key of required_strings) {
    if (typeof value[key] !== "string" || value[key].trim() === "") {
      throw new Error(`model-manifest.json has no ${key}`)
    }
  }
  if (value.model_file !== "model.lib") throw new Error('model-manifest.json model_file must be "model.lib"')
  if (value.dialect !== "pspice" && value.dialect !== "ngspice" && value.dialect !== "portable") {
    throw new Error("model-manifest.json has an unsupported dialect")
  }
  if (value.simulator !== "ngspice") {
    throw new Error('model-manifest.json simulator must be "ngspice" for this validation workflow')
  }
  if (!Array.isArray(value.pins) || value.pins.length === 0) {
    throw new Error("model-manifest.json must contain an explicit pin mapping")
  }
  const pins = value.pins.map((pin, index) => {
    if (
      !isRecord(pin) ||
      typeof pin.component_pin !== "string" ||
      !pin.component_pin ||
      typeof pin.spice_node !== "string" ||
      !pin.spice_node
    ) {
      throw new Error(`model-manifest.json pin ${index + 1} is invalid`)
    }
    return { component_pin: pin.component_pin, spice_node: pin.spice_node }
  })

  return {
    version: 1,
    part_number: value.part_number as string,
    dialect: value.dialect,
    entry_name: value.entry_name as string,
    model_file: "model.lib",
    revision: value.revision as string,
    simulator: "ngspice",
    generated_at: value.generated_at as string,
    pins,
  }
}

function parseSubcircuitHeaders(model_source: string): Array<{ name: string; pins: string[] }> {
  const lines = model_source.replace(/\r\n?/g, "\n").split("\n")
  const headers: Array<{ name: string; pins: string[] }> = []
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
    const pins = parameter_index < 0 ? tokens : tokens.slice(0, parameter_index)
    headers.push({ name: match[1]!, pins })
  }
  return headers
}

export function validateManifestAgainstModel(manifest: ModelManifest, model_source: string): void {
  const headers = parseSubcircuitHeaders(model_source)
  const subcircuit = headers[0]
  if (!subcircuit || subcircuit.name.toLowerCase() !== manifest.entry_name.toLowerCase()) {
    throw new Error(
      `model-manifest.json entry_name ${manifest.entry_name} must match the first model.lib .SUBCKT`,
    )
  }
  if (subcircuit.pins.length === 0) throw new Error("model.lib .SUBCKT declaration has no pins")
  const manifest_nodes = manifest.pins.map((pin) => pin.spice_node)
  const component_pins = manifest.pins.map((pin) => pin.component_pin)
  if (
    new Set(manifest_nodes).size !== manifest_nodes.length ||
    new Set(component_pins).size !== component_pins.length
  ) {
    throw new Error("model-manifest.json pin mappings must be one-to-one")
  }
  if (JSON.stringify([...subcircuit.pins].sort()) !== JSON.stringify([...manifest_nodes].sort())) {
    throw new Error("model-manifest.json must map every first-.SUBCKT pin exactly once with matching case")
  }
}

async function readIterationCount(model_dir: string): Promise<number> {
  const value: unknown = JSON.parse(await readFile(join(model_dir, "iteration-history.json"), "utf8"))
  if (Array.isArray(value)) return value.length
  if (isRecord(value) && Array.isArray(value.iterations)) return value.iterations.length
  return 0
}

async function listCandidateModelFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entry_path = join(directory, entry.name)
      if (entry.isDirectory()) return listCandidateModelFiles(entry_path)
      return /(?:^|[-_.])model\.lib$/i.test(entry.name) || /\.(?:lib|spice)$/i.test(entry.name)
        ? [entry_path]
        : []
    }),
  )
  return files.flat()
}

function findLastPromotedRevision(value: unknown): string | undefined {
  const iterations = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.iterations)
      ? value.iterations
      : []
  return iterations
    .flatMap((iteration) => {
      if (!isRecord(iteration) || typeof iteration.revision !== "string") return []
      const decision = typeof iteration.decision === "string" ? iteration.decision.toLowerCase() : ""
      return !decision.includes("not") && /promot|accept|champion/.test(decision) ? [iteration.revision] : []
    })
    .at(-1)
}

async function recoverBestModelFile(model_dir: string): Promise<string | undefined> {
  const canonical_file = join(model_dir, "model.lib")
  if (await Bun.file(canonical_file).exists()) return canonical_file

  const candidate_files = await listCandidateModelFiles(model_dir)
  if (candidate_files.length === 0) return undefined
  const history_value = await readFile(join(model_dir, "iteration-history.json"), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => undefined)
  const promoted_revision = findLastPromotedRevision(history_value)
  const promoted_file = promoted_revision
    ? candidate_files.find((file) => file.includes(`/${promoted_revision}/`))
    : undefined
  const selected_file =
    promoted_file ??
    (
      await Promise.all(
        candidate_files.map(async (file) => ({
          file,
          modified_at: (await stat(file).catch(() => undefined))?.mtimeMs ?? 0,
        })),
      )
    ).sort((first, second) => second.modified_at - first.modified_at)[0]?.file
  if (!selected_file) return undefined
  await copyFile(selected_file, canonical_file)
  return canonical_file
}

function markModelCardAsUnverified(model_card: string): string {
  const notice =
    "> **Server validation status:** This is an unverified checkpoint. It did not complete the locked independent benchmark suite.\n\n"
  return model_card.startsWith(notice) ? model_card : `${notice}${model_card}`
}

async function publishAvailableModelCheckpoint(
  model_run_id: string,
  model_dir: string,
  model_run_store: ModelRunStore,
): Promise<boolean> {
  const model_file = await recoverBestModelFile(model_dir)
  if (!model_file) return false
  const model_source = await readFile(model_file, "utf8")
  if (!/^\s*\.\s*subckt\b/im.test(model_source)) return false
  const manifest = await readFile(join(model_dir, "model-manifest.json"), "utf8")
    .then((text) => parseModelManifest(JSON.parse(text) as unknown))
    .catch(() => undefined)
  const model_card = await readFile(join(model_dir, "model-card.md"), "utf8").catch(() => undefined)
  const iteration = await readIterationCount(model_dir).catch(() => 0)
  model_run_store.updateModelRun(model_run_id, {
    model_source,
    ...(manifest ? { manifest } : {}),
    ...(model_card ? { model_card: markModelCardAsUnverified(model_card) } : {}),
    iteration,
  })
  return true
}

async function hasCompletedSetup(model_dir: string): Promise<boolean> {
  return Bun.file(join(model_dir, "setup-complete.json")).exists()
}

async function findPrematureRefinementArtifacts(model_dir: string): Promise<string[]> {
  const canonical_files = [
    "model.lib",
    "model-manifest.json",
    "component-with-model.circuit.tsx",
    "iteration-history.json",
    "model-card.md",
    "validation-report.json",
  ]
  const present = await Promise.all(
    canonical_files.map(async (file) =>
      (await Bun.file(join(model_dir, file)).exists()) ? file : undefined,
    ),
  )
  const candidate_files = await listCandidateModelFiles(join(model_dir, "candidates"))
  return [...present.filter((file): file is string => Boolean(file)), ...candidate_files]
}

async function clearIncompleteBenchmarkFinalization(model_dir: string): Promise<void> {
  await Promise.all([
    rm(join(model_dir, "benchmarks.json"), { force: true }),
    rm(join(model_dir, "benchmarks"), { recursive: true, force: true }),
  ])
  await mkdir(join(model_dir, "benchmarks"), { recursive: true })
}

async function clearRefinementArtifacts(model_dir: string): Promise<void> {
  await clearVerifiedSimulationResults(model_dir)
  await Promise.all([
    ...[
      "model.lib",
      "model-manifest.json",
      "component-with-model.circuit.tsx",
      "iteration-history.json",
      "model-card.md",
      "validation-report.json",
      "validation-feedback.md",
    ].map((file) => rm(join(model_dir, file), { force: true })),
    ...["candidates", "results/champion"].map((directory) =>
      rm(join(model_dir, directory), { recursive: true, force: true }),
    ),
  ])
  await mkdir(join(model_dir, "results", "champion"), { recursive: true })
}

async function validateBenchmarkSources(input: {
  job_dir: string
  model_dir: string
  signal: AbortSignal
  tsci_bin: string
  append: (stream: JobLogStream, message: string) => Promise<void>
}): Promise<void> {
  const temporary_component = join(input.model_dir, "component-with-model.circuit.tsx")
  const output_root = join(input.model_dir, ".benchmark-source-check")
  if (await Bun.file(temporary_component).exists()) {
    throw new Error("A model wrapper exists before provisional benchmark validation")
  }
  await Bun.write(
    temporary_component,
    'import Component from "./component.circuit"\n\nexport default Component\n',
  )
  try {
    const benchmark_files = await listModelBenchFiles(input.model_dir)
    if (input.signal.aborted) throw new Error("Provisional benchmark validation was cancelled")
    await input.append(
      "system",
      `Source-checking ${benchmark_files.length} provisional benchmark circuit(s) before locking; ngspice is not run in this phase…\n`,
    )
    await rm(output_root, { recursive: true, force: true })
    const result = await Bun.build({
      entrypoints: benchmark_files.map((file) => join(input.model_dir, "benchmarks", file)),
      outdir: output_root,
      target: "bun",
      format: "esm",
      packages: "external",
      naming: "[dir]/[name].[ext]",
    })
    if (!result.success) {
      const details = result.logs
        .map((log) => log.message)
        .filter(Boolean)
        .join("; ")
      throw new Error(`Benchmark source compilation failed${details ? `: ${details}` : ""}`)
    }
    if (input.signal.aborted) throw new Error("Provisional benchmark validation was cancelled")

    const originals = await Promise.all(
      benchmark_files.map(async (benchmark_file) => {
        const source_path = join(input.model_dir, "benchmarks", benchmark_file)
        return {
          benchmark_file,
          source_path,
          source: await readFile(source_path, "utf8"),
        }
      }),
    )
    try {
      await Promise.all(
        originals.map(({ benchmark_file, source_path, source }) =>
          Bun.write(source_path, stripAnalogSimulationForStructuralCheck(source, benchmark_file)),
        ),
      )
      await input.append(
        "system",
        `Structurally rendering ${benchmark_files.length} provisional benchmark circuit(s) before locking; analog simulation remains disabled…\n`,
      )
      let next_index = 0
      const failures: string[] = []
      const worker = async () => {
        while (!input.signal.aborted) {
          const benchmark_file = benchmark_files[next_index]
          next_index += 1
          if (!benchmark_file) return
          const benchmark_id = benchmark_file.replace(/\.circuit\.tsx$/i, "")
          const generated_path = join(
            input.job_dir,
            "dist",
            "spice",
            "benchmarks",
            benchmark_id,
            "circuit.json",
          )
          await rm(dirname(generated_path), { recursive: true, force: true })
          let process_output = ""
          const exit_code = await streamModelProcess({
            command: [
              input.tsci_bin,
              "build",
              `benchmarks/${benchmark_file}`,
              "--ignore-warnings",
              "--disable-pcb",
              "--routing-disabled",
              "--disable-parts-engine",
            ],
            cwd: input.model_dir,
            signal: input.signal,
            on_chunk: async (stream, message) => {
              process_output = captureProcessOutput(process_output, message)
              await input.append(stream, message)
            },
          })
          if (exit_code !== 0) {
            failures.push(`${benchmark_file}: ${summarizeProcessFailure(process_output)}`)
            continue
          }
          try {
            const circuit_json: unknown = JSON.parse(await readFile(generated_path, "utf8"))
            const diagnostics = getCircuitBuildDiagnostics(circuit_json)
            const errors = [...diagnostics.source_errors, ...diagnostics.simulation_errors]
            if (errors.length > 0) failures.push(`${benchmark_file}: ${errors.join("; ")}`)
          } catch (error) {
            failures.push(`${benchmark_file}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(getValidationConcurrency(), benchmark_files.length) }, () => worker()),
      )
      if (input.signal.aborted) throw new Error("Provisional benchmark validation was cancelled")
      if (failures.length > 0) {
        throw new Error(`Benchmark structural render failed: ${failures.join(" | ")}`)
      }
    } finally {
      await Promise.all(originals.map(({ source_path, source }) => Bun.write(source_path, source)))
    }
  } finally {
    await Promise.all([
      rm(temporary_component, { force: true }),
      rm(output_root, { recursive: true, force: true }),
    ])
  }
}

function readRequiredLiteralJsxAttribute(
  attributes: ts.JsxAttributes,
  source_file: ts.SourceFile,
  benchmark_file: string,
  attribute_name: string,
  required: boolean,
): string | undefined {
  const matches = attributes.properties.filter(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText(source_file) === attribute_name,
  )
  if (attributes.properties.some(ts.isJsxSpreadAttribute)) {
    throw new Error(
      `Benchmark ${benchmark_file} analogsimulation must use explicit attributes, not JSX spreads`,
    )
  }
  if (matches.length === 0) {
    if (required) {
      throw new Error(`Benchmark ${benchmark_file} analogsimulation must set ${attribute_name}`)
    }
    return undefined
  }
  if (matches.length !== 1) {
    throw new Error(`Benchmark ${benchmark_file} analogsimulation duplicates ${attribute_name}`)
  }
  const initializer = matches[0]!.initializer
  if (initializer && ts.isStringLiteral(initializer)) return initializer.text
  if (
    initializer &&
    ts.isJsxExpression(initializer) &&
    initializer.expression &&
    (ts.isStringLiteral(initializer.expression) || ts.isNoSubstitutionTemplateLiteral(initializer.expression))
  ) {
    return initializer.expression.text
  }
  throw new Error(`Benchmark ${benchmark_file} analogsimulation ${attribute_name} must be a string literal`)
}

function assertAnalogSimulationContract(
  attributes: ts.JsxAttributes,
  source_file: ts.SourceFile,
  benchmark_file: string,
): void {
  const spice_engine = readRequiredLiteralJsxAttribute(
    attributes,
    source_file,
    benchmark_file,
    "spiceEngine",
    true,
  )
  if (spice_engine !== "ngspice") {
    throw new Error(`Benchmark ${benchmark_file} analogsimulation spiceEngine must be "ngspice"`)
  }
  const simulation_type = readRequiredLiteralJsxAttribute(
    attributes,
    source_file,
    benchmark_file,
    "simulationType",
    false,
  )
  if (simulation_type !== undefined && simulation_type !== "spice_transient_analysis") {
    throw new Error(
      `Benchmark ${benchmark_file} analogsimulation simulationType must be "spice_transient_analysis" or omitted`,
    )
  }
}

export function stripAnalogSimulationForStructuralCheck(source: string, benchmark_file: string): string {
  const source_file = ts.createSourceFile(
    benchmark_file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const spans: Array<{ start: number; end: number }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source_file) === "analogsimulation") {
      assertAnalogSimulationContract(node.attributes, source_file, benchmark_file)
      spans.push({ start: node.getFullStart(), end: node.end })
      return
    }
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source_file) === "analogsimulation") {
      assertAnalogSimulationContract(node.openingElement.attributes, source_file, benchmark_file)
      spans.push({ start: node.getFullStart(), end: node.end })
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source_file)
  if (spans.length !== 1) {
    throw new Error(
      `Benchmark ${benchmark_file} must contain exactly one removable analogsimulation for structural validation`,
    )
  }
  const [{ start, end }] = spans
  return `${source.slice(0, start)}${source.slice(end)}`
}

export async function preflightNgspice(input: {
  job_dir: string
  model_dir: string
  signal: AbortSignal
  tsci_bin: string
  append: (stream: JobLogStream, message: string) => Promise<void>
}): Promise<number> {
  const source_file = join(input.model_dir, "server-ngspice-preflight.circuit.tsx")
  const output_directory = join(input.job_dir, "dist", "spice", "server-ngspice-preflight")
  await Bun.write(
    source_file,
    `export default function NgspicePreflight() {
  return (
    <board routingDisabled>
      <voltagesource name="VTEST" voltage="1V" connections={{ pin1: "net.TEST", pin2: "net.GND" }} />
      <resistor name="RTEST" resistance="1kohm" connections={{ pin1: "net.TEST", pin2: "net.GND" }} />
      <voltageprobe name="RESULT" connectsTo=".RTEST > .pin1" />
      <analogsimulation duration="10us" timePerStep="1us" spiceEngine="ngspice" />
    </board>
  )
}
`,
  )
  await rm(output_directory, { recursive: true, force: true })
  const started_at = Date.now()
  let process_output = ""
  try {
    await input.append(
      "system",
      "Preflighting the ngspice engine with PCB, routing, and parts work disabled before starting the refinement timer…\n",
    )
    const exit_code = await streamModelProcess({
      command: [
        input.tsci_bin,
        "build",
        "server-ngspice-preflight.circuit.tsx",
        "--ignore-warnings",
        "--disable-pcb",
        "--routing-disabled",
        "--disable-parts-engine",
      ],
      cwd: input.model_dir,
      signal: input.signal,
      on_chunk: async (stream, message) => {
        process_output = captureProcessOutput(process_output, message)
        await input.append(stream, message)
      },
    })
    if (exit_code !== 0) {
      throw new ModelInfrastructureError(
        `ngspice preflight failed: ${summarizeProcessFailure(process_output)}`,
      )
    }
    const circuit_json: unknown = JSON.parse(await readFile(join(output_directory, "circuit.json"), "utf8"))
    const diagnostics = getCircuitBuildDiagnostics(circuit_json)
    const errors = [...diagnostics.source_errors, ...diagnostics.simulation_errors]
    if (errors.length > 0) {
      throw new ModelInfrastructureError(`ngspice preflight failed: ${errors.join("; ")}`)
    }
    if (
      !isCircuitJson(circuit_json) ||
      !circuit_json.some((element) => element.type === "simulation_transient_voltage_graph")
    ) {
      throw new ModelInfrastructureError("ngspice preflight produced no transient voltage graph")
    }
    const duration_ms = Date.now() - started_at
    await input.append("system", `ngspice preflight passed in ${duration_ms} ms.\n`)
    return duration_ms
  } finally {
    await Promise.all([
      rm(source_file, { force: true }),
      rm(output_directory, { recursive: true, force: true }),
    ])
  }
}

async function finalizeAndLockBenchmarks(input: {
  model_run_id: string
  job_dir: string
  model_dir: string
  signal: AbortSignal
  context: ModelRunnerContext
  append: (stream: JobLogStream, message: string) => Promise<void>
  initial_feedback?: string
  repair_lock?: BenchmarkLock
}): Promise<{ benchmark_lock: BenchmarkLock }> {
  const configured_attempts = Number(process.env.MODEL_BENCHMARK_FINALIZATION_ATTEMPTS ?? 4)
  const max_attempts = Number.isInteger(configured_attempts)
    ? Math.max(1, Math.min(8, configured_attempts))
    : 4
  let benchmark_validation_feedback = input.initial_feedback
  for (let attempt = 1; attempt <= max_attempts; attempt += 1) {
    const benchmark_exit_code = await streamModelProcess({
      command: [
        input.context.agent_bin,
        "do",
        "--prompt",
        buildModelBenchmarkPrompt(benchmark_validation_feedback, {
          locked_circuit_repair: Boolean(input.repair_lock),
        }),
        "--dir",
        input.model_dir,
      ],
      cwd: input.model_dir,
      signal: input.signal,
      on_chunk: input.append,
    })
    if (benchmark_exit_code !== 0) {
      throw new Error(`Benchmark-finalization agent exited with code ${benchmark_exit_code}`)
    }
    const forbidden_artifacts = await findPrematureRefinementArtifacts(input.model_dir)
    if (forbidden_artifacts.length > 0) {
      throw new Error(
        `Benchmark finalization created forbidden model artifacts before the suite was locked: ${forbidden_artifacts.join(", ")}`,
      )
    }

    let rejection: string | undefined
    if (!(await hasBenchmarkManifest(input.model_dir))) {
      rejection = "The benchmark-finalization agent did not create benchmarks.json"
    } else {
      try {
        await validateBenchmarkSuiteForLock(input.model_dir)
        await validateBenchmarkSources({
          job_dir: input.job_dir,
          model_dir: input.model_dir,
          signal: input.signal,
          tsci_bin: input.context.tsci_bin,
          append: input.append,
        })
        const benchmark_lock = input.repair_lock
          ? await replaceBenchmarkLockAfterCircuitRepair(input.model_dir, input.repair_lock)
          : await createOrVerifyBenchmarkLock(input.model_dir)
        return { benchmark_lock }
      } catch (error) {
        rejection = error instanceof Error ? error.message : String(error)
      }
    }
    if (!rejection) rejection = "The benchmark suite did not pass server validation"
    if (attempt >= max_attempts) {
      throw new Error(
        `Benchmark finalization still failed server validation after ${attempt} attempts: ${rejection}`,
      )
    }
    benchmark_validation_feedback = rejection.slice(0, 8_000)
    await input.append(
      "system",
      `The server rejected benchmark-finalization attempt ${attempt}: ${rejection}\nReturning the exact validation error to the benchmark agent for correction; model refinement remains untimed and has not started.\n`,
    )
    updateServerProgress(
      input.model_run_id,
      input.context.model_run_store,
      "locking_benchmarks",
      `Correcting benchmark suite after server validation attempt ${attempt}`,
    )
  }
  throw new Error("The benchmark suite could not be locked")
}

function waitForComponent(
  job_id: string,
  job_store: JobStore,
  signal: AbortSignal,
): Promise<"complete" | "failed" | "cancelled"> {
  const getOutcome = (): "complete" | "failed" | "cancelled" | undefined => {
    const job = job_store.getJob(job_id)
    if (job?.display_status === "complete") return "complete"
    if (job?.display_status === "failed") return "failed"
    if (job?.display_status === "cancelled") return "cancelled"
    return undefined
  }
  const current_outcome = getOutcome()
  if (current_outcome) return Promise.resolve(current_outcome)

  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined
    const finish = (outcome: "complete" | "failed" | "cancelled") => {
      signal.removeEventListener("abort", stopWaiting)
      unsubscribe?.()
      resolve(outcome)
    }
    const stopWaiting = () => finish("cancelled")
    signal.addEventListener("abort", stopWaiting, { once: true })
    unsubscribe = job_store.subscribe(job_id, (event) => {
      if (event.event_type === "log") return
      const outcome = getOutcome()
      if (outcome) finish(outcome)
    })
    if (!unsubscribe) finish("failed")
  })
}

function markModelRunCancelled(model_run_id: string, model_run_store: ModelRunStore): void {
  updateServerProgress(model_run_id, model_run_store, "cancelled", "The model run was stopped")
  const update = {
    status: "cancelled" as const,
    is_complete: true,
    has_errors: false,
    completed_at: new Date().toISOString(),
  }
  const model_run = model_run_store.getModelRun(model_run_id)
  if (model_run?.segment_started_at) model_run_store.finishSegment(model_run_id, update)
  else model_run_store.updateModelRun(model_run_id, update)
}

function updateServerProgress(
  model_run_id: string,
  model_run_store: ModelRunStore,
  phase: ModelProgressPhase,
  message: string,
  update: Partial<Pick<ModelProgress, "iteration" | "evidence" | "benchmark" | "champion">> = {},
): void {
  const current = model_run_store.getModelRun(model_run_id)?.progress
  model_run_store.updateProgress(model_run_id, {
    sequence: (current?.sequence ?? 0) + 1,
    phase,
    message,
    updated_at: new Date().toISOString(),
    iteration: update.iteration ?? current?.iteration,
    evidence: update.evidence ?? current?.evidence,
    benchmark: update.benchmark ?? current?.benchmark,
    champion: update.champion ?? current?.champion,
  })
}

function isCircuitJson(value: unknown): value is import("circuit-json").AnyCircuitElement[] {
  return (
    Array.isArray(value) &&
    value.every(
      (element) => typeof element === "object" && element !== null && typeof element.type === "string",
    )
  )
}

async function attachModelToGeneratedComponent(input: {
  job_id: string
  job_dir: string
  model_dir: string
  job_store: JobStore
}): Promise<void> {
  const integrated_component = join(input.model_dir, "component-with-model.circuit.tsx")
  const original_component = join(input.model_dir, "component.circuit.tsx")
  await Promise.all([
    copyFile(integrated_component, join(input.job_dir, "index.circuit.tsx")),
    copyFile(original_component, join(input.job_dir, "component.circuit.tsx")),
    copyFile(join(input.model_dir, "model.lib"), join(input.job_dir, "model.lib")),
  ])
  const [component_code, circuit_json_value] = await Promise.all([
    readFile(integrated_component, "utf8"),
    readFile(join(input.job_dir, "dist", "spice", "component-with-model", "circuit.json"), "utf8")
      .then((text) => JSON.parse(text) as unknown)
      .catch(() => undefined),
  ])
  input.job_store.updateJob(input.job_id, {
    component_code,
    ...(isCircuitJson(circuit_json_value) ? { circuit_json: circuit_json_value } : {}),
  })
}

async function writeServerIntegratedComponent(input: {
  model_dir: string
  manifest: ModelManifest
  model_source: string
}): Promise<void> {
  const spice_pin_mapping = Object.fromEntries(
    input.manifest.pins.map((pin) => [pin.spice_node, pin.component_pin]),
  )
  await Bun.write(
    join(input.model_dir, "component-with-model.circuit.tsx"),
    `import type { ComponentProps } from "react"
import Component from "./component.circuit"

const modelSource = ${JSON.stringify(input.model_source)}
const ModelComponent = Component as any

export type ComponentWithModelProps = ComponentProps<typeof Component>

export default function ComponentWithModel(props: ComponentWithModelProps) {
  return (
    <ModelComponent
      {...props}
      spiceModel={
        <spicemodel
          source={modelSource}
          spicePinMapping={${JSON.stringify(spice_pin_mapping, null, 2)}}
        />
      }
    />
  )
}
`,
  )
}

function normalizeModelSource(source: string): string {
  return source.replace(/\r\n?/g, "\n").trim()
}

function assertIntegratedCircuitUsesCanonicalModel(value: unknown, model_source: string): void {
  if (!isCircuitJson(value)) throw new Error("The integrated component did not produce valid Circuit JSON")
  const spice_models = value.filter((element) => element.type === "simulation_spice_subcircuit")
  if (
    spice_models.length !== 1 ||
    !("subcircuit_source" in spice_models[0]!) ||
    typeof spice_models[0]!.subcircuit_source !== "string" ||
    normalizeModelSource(spice_models[0]!.subcircuit_source) !== normalizeModelSource(model_source)
  ) {
    throw new Error("The integrated component does not contain exactly one canonical model.lib subcircuit")
  }
}

type SimulationFailureKind = "benchmark_structure" | "simulation" | "infrastructure" | "process"

interface ValidationBuildRun {
  run_id: string
  source_path: string
  generated_path: string
  saved_path: string
}

interface ValidationBuildResult {
  exit_code: number
  path?: string
  error_message?: string
  failure_kind?: SimulationFailureKind
}

interface BenchmarkValidationState {
  benchmark_id: string
  benchmark_file: string
  source_signature: string
  runs: ValidationBuildRun[]
  results: Array<ValidationBuildResult | undefined>
  building_verification: SimulationBenchmarkVerification
  verification?: SimulationBenchmarkVerification
  failure_kind?: SimulationFailureKind
  finalizing: boolean
  partial_write: Promise<void>
}

function getValidationConcurrency(): number {
  const concurrency_value = Number(process.env.MODEL_VALIDATION_CONCURRENCY ?? 4)
  return Number.isInteger(concurrency_value) ? Math.max(1, Math.min(8, concurrency_value)) : 4
}

async function prepareBenchmarkValidation(input: {
  benchmark_id: string
  benchmark_file: string
  source_signature: string
  job_dir: string
  model_dir: string
}): Promise<BenchmarkValidationState> {
  const benchmark_source = join(input.model_dir, "benchmarks", input.benchmark_file)
  const runs: ValidationBuildRun[] = [
    {
      run_id: "default",
      source_path: benchmark_source,
      generated_path: join(input.job_dir, "dist", "spice", "benchmarks", input.benchmark_id, "circuit.json"),
      saved_path: join(
        input.model_dir,
        "validation-artifacts",
        input.benchmark_id,
        "runs",
        "default",
        "circuit.json",
      ),
    },
  ]
  return {
    benchmark_id: input.benchmark_id,
    benchmark_file: input.benchmark_file,
    source_signature: input.source_signature,
    runs,
    results: Array(runs.length),
    building_verification: {
      benchmark_id: input.benchmark_id,
      passed: false,
      status: "building",
      generated_at: new Date().toISOString(),
      source_signature: input.source_signature,
    },
    finalizing: false,
    partial_write: Promise.resolve(),
  }
}

function isInfrastructureFailure(message: string): boolean {
  return /SPICE engine .* not found in platform config|Available engines:\s*\[\]|spiceEngine\.simulate is not a function|Cannot find package ['"]@tscircuit\/ngspice-spice-engine|ngspice executable .*not found|ENOENT.*\b(?:tsci|ngspice)\b/i.test(
    message,
  )
}

async function executeValidationBuild(input: {
  state: BenchmarkValidationState
  run: ValidationBuildRun
  model_dir: string
  signal: AbortSignal
  tsci_bin: string
  append: (stream: JobLogStream, message: string) => Promise<void>
}): Promise<ValidationBuildResult> {
  const { state, run } = input
  if (input.signal.aborted) {
    return { exit_code: 143, error_message: "Validation was cancelled", failure_kind: "process" }
  }
  await input.append(
    "system",
    `Building complete transient waveform for locked benchmark ${state.benchmark_file}…\n`,
  )
  await rm(dirname(run.generated_path), { recursive: true, force: true })
  const source_relative = relative(input.model_dir, run.source_path)
  let process_output = ""
  let exit_code: number
  try {
    exit_code = await streamModelProcess({
      command: [
        input.tsci_bin,
        "build",
        source_relative,
        "--ignore-warnings",
        "--disable-pcb",
        "--routing-disabled",
        "--disable-parts-engine",
      ],
      cwd: input.model_dir,
      signal: input.signal,
      on_chunk: async (stream, message) => {
        process_output = captureProcessOutput(process_output, message)
        await input.append(stream, message)
      },
    })
  } catch (error) {
    const error_message = error instanceof Error ? error.message : String(error)
    return {
      exit_code: 1,
      error_message,
      failure_kind: isInfrastructureFailure(error_message) ? "infrastructure" : "process",
    }
  }
  if (exit_code !== 0) {
    const error_message = summarizeProcessFailure(process_output)
    return {
      exit_code,
      error_message,
      failure_kind: isInfrastructureFailure(process_output) ? "infrastructure" : "process",
    }
  }
  try {
    const circuit_text = await readFile(run.generated_path, "utf8")
    await mkdir(dirname(run.saved_path), { recursive: true })
    await Bun.write(run.saved_path, circuit_text)
    const diagnostics = getCircuitBuildDiagnostics(JSON.parse(circuit_text) as unknown)
    if (diagnostics.source_errors.length > 0) {
      return {
        exit_code: 1,
        path: run.saved_path,
        error_message: diagnostics.source_errors.join("; "),
        failure_kind: "benchmark_structure",
      }
    }
    if (diagnostics.simulation_errors.length > 0) {
      const error_message = diagnostics.simulation_errors.join("; ")
      return {
        exit_code: 1,
        path: run.saved_path,
        error_message,
        failure_kind: isInfrastructureFailure(error_message) ? "infrastructure" : "simulation",
      }
    }
    return { exit_code: 0, path: run.saved_path }
  } catch (error) {
    return {
      exit_code: 1,
      error_message: error instanceof Error ? error.message : String(error),
      failure_kind: "process",
    }
  }
}

async function runValidationTaskPool<T>(input: {
  tasks: T[]
  concurrency: number
  signal: AbortSignal
  run: (task: T) => Promise<void>
}): Promise<void> {
  let next_index = 0
  const worker = async () => {
    while (!input.signal.aborted) {
      const task_index = next_index
      next_index += 1
      const task = input.tasks[task_index]
      if (!task) return
      await input.run(task)
    }
  }
  await Promise.all(Array.from({ length: Math.min(input.concurrency, input.tasks.length) }, () => worker()))
}

async function validateChampion(
  input: {
    model_run_id: string
    job_id: string
    job_dir: string
    model_dir: string
    benchmark_lock: BenchmarkLock
    signal: AbortSignal
  },
  context: ModelRunnerContext,
): Promise<{
  manifest: ModelManifest
  model_source: string
  model_card: string
  iteration: number
  integration_error?: string
  benchmark_contract_error?: string
  infrastructure_error?: string
  simulation_verifications: SimulationBenchmarkVerification[]
}> {
  const [model_source, manifest_value, model_card, iteration] = await Promise.all([
    readFile(join(input.model_dir, "model.lib"), "utf8"),
    readFile(join(input.model_dir, "model-manifest.json"), "utf8").then(
      (text) => JSON.parse(text) as unknown,
    ),
    readFile(join(input.model_dir, "model-card.md"), "utf8"),
    readIterationCount(input.model_dir).catch(() => 0),
  ])
  const manifest = parseModelManifest(manifest_value)
  validateManifestAgainstModel(manifest, model_source)
  await verifyBenchmarkLock(input.model_dir, input.benchmark_lock)
  await writeServerIntegratedComponent({ model_dir: input.model_dir, manifest, model_source })

  const append = async (stream: JobLogStream, message: string) => {
    await context.model_run_store.appendLog(input.model_run_id, stream, message)
  }
  const integration_errors: string[] = []
  const build_exit_code = await streamModelProcess({
    command: [
      context.tsci_bin,
      "build",
      "component-with-model.circuit.tsx",
      "--ignore-warnings",
      "--disable-pcb",
      "--routing-disabled",
      "--disable-parts-engine",
    ],
    cwd: input.model_dir,
    signal: input.signal,
    on_chunk: append,
  })
  if (build_exit_code !== 0) {
    integration_errors.push(`The tscircuit model integration build exited with code ${build_exit_code}`)
  } else {
    const integrated_circuit: unknown = JSON.parse(
      await readFile(join(input.job_dir, "dist", "spice", "component-with-model", "circuit.json"), "utf8"),
    )
    const diagnostics = getCircuitBuildDiagnostics(integrated_circuit)
    const integration_build_errors = [...diagnostics.source_errors, ...diagnostics.simulation_errors]
    if (integration_build_errors.length > 0) {
      integration_errors.push(
        `The tscircuit model integration build produced semantic errors: ${integration_build_errors.join("; ")}`,
      )
    } else {
      assertIntegratedCircuitUsesCanonicalModel(integrated_circuit, model_source)
      await append("system", "Built the server-generated canonical model wrapper.\n")
    }
  }

  const benchmark_files = await listModelBenchFiles(input.model_dir)
  if (benchmark_files.length === 0) throw new Error("No tscircuit benchmark circuits were created")
  const states = await Promise.all(
    benchmark_files.map(async (benchmark_file) => {
      const benchmark_id = benchmark_file.replace(/\.circuit\.tsx$/i, "")
      return prepareBenchmarkValidation({
        benchmark_id,
        benchmark_file,
        source_signature: await getModelSimulationSourceSignature(input.model_dir, benchmark_id),
        job_dir: input.job_dir,
        model_dir: input.model_dir,
      })
    }),
  )
  await writeSimulationValidationReport(
    input.model_dir,
    states.map((state) => state.building_verification),
  )

  let report_write = Promise.resolve()
  const publishReport = (): Promise<void> => {
    report_write = report_write.then(() =>
      writeSimulationValidationReport(
        input.model_dir,
        states.map((state) => state.verification ?? state.building_verification),
      ),
    )
    return report_write
  }
  const failState = async (
    state: BenchmarkValidationState,
    run: ValidationBuildRun,
    result: ValidationBuildResult,
  ): Promise<void> => {
    if (state.verification) return
    state.failure_kind = result.failure_kind ?? "process"
    const error_message = `${state.benchmark_file} build exited with code ${result.exit_code}${
      result.error_message ? `: ${result.error_message}` : ""
    }`
    state.verification = {
      benchmark_id: state.benchmark_id,
      passed: false,
      status: "failed",
      generated_at: new Date().toISOString(),
      source_signature: state.source_signature,
      error_message,
    }
    await publishReport()
  }
  const finalizeState = async (state: BenchmarkValidationState): Promise<void> => {
    if (
      state.verification ||
      state.finalizing ||
      state.results.filter((result) => Boolean(result?.path)).length !== state.runs.length
    ) {
      return
    }
    state.finalizing = true
    state.verification = await verifySimulationBenchmark({
      model_dir: input.model_dir,
      benchmark_id: state.benchmark_id,
      source_signature: state.source_signature,
      circuit_json_paths: state.results.map((result) => ({
        path: result!.path!,
      })),
    })
    await publishReport()
  }
  let infrastructure_failure_message: string | undefined
  const runTask = async (task: {
    state: BenchmarkValidationState
    run: ValidationBuildRun
  }): Promise<void> => {
    if (task.state.verification || input.signal.aborted || infrastructure_failure_message) return
    const result = await executeValidationBuild({
      state: task.state,
      run: task.run,
      model_dir: input.model_dir,
      signal: input.signal,
      tsci_bin: context.tsci_bin,
      append,
    })
    task.state.results[0] = result
    if (result.exit_code !== 0 || !result.path) {
      await failState(task.state, task.run, result)
      if (result.failure_kind === "infrastructure") {
        infrastructure_failure_message = result.error_message ?? "Simulation infrastructure failed"
      }
      return
    }
    task.state.partial_write = task.state.partial_write.then(async () => {
      const successful_paths = task.state.results.flatMap((candidate) =>
        candidate?.path ? [{ path: candidate.path }] : [],
      )
      task.state.building_verification = await verifyPartialSimulationBenchmark({
        model_dir: input.model_dir,
        benchmark_id: task.state.benchmark_id,
        source_signature: task.state.source_signature,
        circuit_json_paths: successful_paths,
      })
      await publishReport()
      await finalizeState(task.state)
    })
    await task.state.partial_write
  }

  const concurrency = getValidationConcurrency()
  await append(
    "system",
    `Starting transient waveform validation with up to ${concurrency} concurrent build(s); each benchmark runs exactly once and publishes its complete time trace as soon as it finishes.\n`,
  )
  await runValidationTaskPool({
    tasks: states.flatMap((state) => (state.runs[0] ? [{ state, run: state.runs[0] }] : [])),
    concurrency,
    signal: input.signal,
    run: runTask,
  })
  await Promise.all(states.map((state) => state.partial_write))
  await Promise.all(states.map(finalizeState))

  if (input.signal.aborted) {
    integration_errors.push("The independent benchmark re-run reached its validation time limit")
  }
  for (const state of states) {
    if (!state.verification) {
      await failState(state, state.runs[0]!, {
        exit_code: input.signal.aborted ? 143 : 1,
        error_message:
          infrastructure_failure_message ??
          (input.signal.aborted
            ? "Validation was cancelled before every required simulator output completed"
            : "Validation did not produce every required simulator output"),
        failure_kind: infrastructure_failure_message ? "infrastructure" : "process",
      })
    }
  }
  await report_write
  const simulation_verifications = states.flatMap((state) => (state.verification ? [state.verification] : []))
  for (const state of states) {
    if (state.verification && !state.verification.passed) {
      integration_errors.push(`${state.benchmark_file}: ${state.verification.error_message}`)
    }
  }
  const structural_failure = states.find(
    (state) => state.failure_kind === "benchmark_structure" && state.verification,
  )
  const benchmark_contract_error = structural_failure
    ? `${structural_failure.benchmark_file}: ${structural_failure.verification!.error_message ?? "benchmark source contract failed"}`
    : undefined
  const infrastructure_failure = states.find(
    (state) => state.failure_kind === "infrastructure" && state.verification,
  )
  const infrastructure_error = infrastructure_failure
    ? `${infrastructure_failure.benchmark_file}: ${infrastructure_failure.verification!.error_message ?? "simulation infrastructure failed"}`
    : undefined
  await verifyBenchmarkLock(input.model_dir, input.benchmark_lock)
  return {
    manifest,
    model_source,
    model_card,
    iteration,
    integration_error: integration_errors.length > 0 ? integration_errors.join("; ") : undefined,
    benchmark_contract_error,
    infrastructure_error,
    simulation_verifications,
  }
}

export async function runModel(input: { model_run_id: string }, context: ModelRunnerContext): Promise<void> {
  const model_run = context.model_run_store.getModelRun(input.model_run_id)
  if (!model_run) throw new Error(`Model run ${input.model_run_id} was not found`)
  const job_dir = context.job_store.getJobDir(model_run.job_id)
  const model_dir = context.model_run_store.getModelDir(input.model_run_id)
  const cancellation_signal = context.model_run_store.getCancellationSignal(input.model_run_id)
  if (!job_dir || !model_dir || !cancellation_signal) throw new Error("Model run workspace was not found")
  await ensureJobTscircuitRuntimeConfig(job_dir)

  const append = async (stream: JobLogStream, message: string): Promise<void> => {
    await context.model_run_store.appendLog(input.model_run_id, stream, message)
  }

  let budget_exhausted = false
  let stale_timeout = false
  let process_controller = new AbortController()
  const cancel_process = () => process_controller.abort()
  if (cancellation_signal.aborted) {
    markModelRunCancelled(input.model_run_id, context.model_run_store)
    return
  }
  cancellation_signal.addEventListener("abort", cancel_process, { once: true })
  let budget_monitor: ReturnType<typeof setInterval> | undefined
  let progress_monitor: ModelProgressMonitor | undefined
  let artifact_monitor: ModelArtifactMonitor | undefined

  try {
    if (!(await Bun.file(join(model_dir, "AGENTS.md")).exists())) {
      await writeModelScaffold({ job_dir, model_dir })
    }
    progress_monitor = startModelProgressMonitor({
      model_run_id: input.model_run_id,
      model_dir,
      model_run_store: context.model_run_store,
    })
    artifact_monitor = startModelArtifactMonitor({
      model_run_id: input.model_run_id,
      model_dir,
      model_run_store: context.model_run_store,
    })
    await progress_monitor.sync()

    if (!(await hasCompletedSetup(model_dir))) {
      context.model_run_store.updateModelRun(input.model_run_id, {
        status: "setting_up",
        is_complete: false,
        has_errors: false,
      })
      updateServerProgress(
        input.model_run_id,
        context.model_run_store,
        "extracting_datasheet",
        "Starting datasheet extraction and reference setup",
      )
      await append(
        "system",
        "Starting untimed datasheet evidence and benchmark-reference setup in parallel with component generation…\n",
      )
      const setup_exit_code = await streamModelProcess({
        command: [context.agent_bin, "do", "--prompt", buildModelSetupPrompt(), "--dir", model_dir],
        cwd: model_dir,
        signal: process_controller.signal,
        on_chunk: append,
      })
      if (cancellation_signal.aborted) {
        await append("system", "\nThe SPICE model setup was stopped. Extracted evidence was preserved.\n")
        markModelRunCancelled(input.model_run_id, context.model_run_store)
        return
      }
      if (setup_exit_code !== 0) throw new Error(`Setup agent exited with code ${setup_exit_code}`)
      await progress_monitor.sync()
      if (!(await hasCompletedSetup(model_dir))) {
        throw new Error("The setup agent did not create setup-complete.json")
      }
      await append("system", "Untimed evidence setup is complete.\n")
    }

    const component_job = context.job_store.getJob(model_run.job_id)
    if (component_job?.display_status !== "complete") {
      context.model_run_store.updateModelRun(input.model_run_id, {
        status: "waiting_for_component",
        is_complete: false,
        has_errors: false,
      })
      updateServerProgress(
        input.model_run_id,
        context.model_run_store,
        "waiting_for_component",
        "Reference setup is complete; waiting for the authoritative component pinout",
      )
      await append("system", "Waiting for the component agent. The refinement countdown has not started.\n")
      const component_outcome = await waitForComponent(
        model_run.job_id,
        context.job_store,
        cancellation_signal,
      )
      if (cancellation_signal.aborted) {
        markModelRunCancelled(input.model_run_id, context.model_run_store)
        return
      }
      if (component_outcome !== "complete") {
        throw new Error(`Component generation ${component_outcome}; refinement could not start`)
      }
    }
    await copyComponentIntoModelWorkspace({ job_dir, model_dir })
    const benchmark_lock_exists = await hasBenchmarkLock(model_dir)
    let benchmark_lock = context.model_run_store.getRememberedBenchmarkLock(input.model_run_id)
    if (!benchmark_lock_exists) {
      const premature_artifacts = await findPrematureRefinementArtifacts(model_dir)
      if (premature_artifacts.length > 0) {
        throw new Error(
          `Cannot establish a pre-refinement benchmark lock because model artifacts already exist: ${premature_artifacts.join(", ")}`,
        )
      }
      await clearIncompleteBenchmarkFinalization(model_dir)
      context.model_run_store.updateModelRun(input.model_run_id, {
        status: "setting_up",
        is_complete: false,
        has_errors: false,
      })
      updateServerProgress(
        input.model_run_id,
        context.model_run_store,
        "locking_benchmarks",
        "Finalizing the benchmark suite before model refinement",
      )
      await append(
        "system",
        "Starting the untimed benchmark-finalization pass. Model refinement has not started.\n",
      )
      const finalized = await finalizeAndLockBenchmarks({
        model_run_id: input.model_run_id,
        job_dir,
        model_dir,
        signal: process_controller.signal,
        context,
        append,
      })
      benchmark_lock = finalized.benchmark_lock
      context.model_run_store.rememberBenchmarkLock(input.model_run_id, benchmark_lock)
    } else {
      benchmark_lock = await verifyBenchmarkLock(model_dir, benchmark_lock)
      context.model_run_store.rememberBenchmarkLock(input.model_run_id, benchmark_lock)
    }
    const locked_simulation_run_count = await getSimulationRunCount(model_dir).catch(() => 0)
    const validation_canary_ms = await preflightNgspice({
      job_dir,
      model_dir,
      signal: process_controller.signal,
      tsci_bin: context.tsci_bin,
      append,
    })
    context.model_run_store.setValidationProfile(input.model_run_id, {
      simulation_run_count: locked_simulation_run_count,
      canary_duration_ms: validation_canary_ms,
    })
    const draft_total = context.model_run_store.getModelRun(input.model_run_id)?.progress?.evidence
      ?.benchmark_drafts
    const locked_total = benchmark_lock.benchmark_ids.length
    const omitted = draft_total === undefined ? undefined : Math.max(0, draft_total - locked_total)
    updateServerProgress(
      input.model_run_id,
      context.model_run_store,
      "locking_benchmarks",
      draft_total === undefined
        ? `Locked ${locked_total} executable benchmark${locked_total === 1 ? "" : "s"}`
        : `Locked ${locked_total} of ${draft_total} benchmark drafts; ${omitted} remain evidence-only`,
      {
        benchmark: {
          completed: 0,
          total: locked_total,
          draft_total,
          locked_total,
          omitted,
        },
      },
    )
    await append(
      "system",
      draft_total === undefined
        ? `The server locked ${locked_total} executable benchmark${locked_total === 1 ? "" : "s"}, evidence, and test benches.\n`
        : `The server locked ${locked_total} of ${draft_total} benchmark drafts; ${omitted} remain visible as evidence-only coverage.\n`,
    )

    context.model_run_store.startSegment(input.model_run_id)
    updateServerProgress(
      input.model_run_id,
      context.model_run_store,
      "building_baseline",
      "The benchmark suite is locked; starting baseline model refinement",
    )
    await append(
      "system",
      `The component is ready. Starting the fixed ngspice-validated SPICE refinement workflow with ${Math.round(
        (context.model_run_store.getRemainingTimeMs(input.model_run_id) ?? 0) / 1000,
      )} seconds of refinement time remaining…\n`,
    )

    let final_champion: Awaited<ReturnType<typeof validateChampion>> | undefined
    let final_validation: Awaited<ReturnType<typeof scoreModelBenchmarks>> | undefined
    let final_error_message: string | undefined
    let agent_attempt = 0
    let benchmark_recovery_count = 0

    const startBudgetMonitor = () =>
      setInterval(() => {
        const remaining_time_ms = context.model_run_store.getRemainingTimeMs(input.model_run_id)
        if (remaining_time_ms !== undefined && remaining_time_ms <= 0) {
          budget_exhausted = true
        }
      }, 500)
    budget_monitor = startBudgetMonitor()

    while (true) {
      agent_attempt += 1

      if (agent_attempt > 1) {
        context.model_run_store.updateModelRun(input.model_run_id, {
          status: "running",
          is_complete: false,
          has_errors: false,
          error_message: undefined,
        })
        updateServerProgress(
          input.model_run_id,
          context.model_run_store,
          "refining",
          `Validation was incomplete; starting correction pass ${agent_attempt}`,
        )
        await append(
          "system",
          `Validation did not reach 100%. Returning the server-owned validation feedback to the agent for correction pass ${agent_attempt}…\n`,
        )
      }

      await verifyBenchmarkLock(model_dir, benchmark_lock)
      const agent_controller = new AbortController()
      let refinement_effort_exhausted = false
      const cancel_agent = () => agent_controller.abort()
      process_controller.signal.addEventListener("abort", cancel_agent, { once: true })
      const refinement_monitor = setInterval(() => {
        const remaining_time_ms = context.model_run_store.getRemainingTimeMs(input.model_run_id) ?? 0
        if (remaining_time_ms <= 0) {
          refinement_effort_exhausted = true
          budget_exhausted = true
          agent_controller.abort()
        }
      }, 250)
      let agent_exit_code: number
      try {
        agent_exit_code = await streamModelProcess({
          command: [context.agent_bin, "do", "--prompt", buildModelAgentPrompt(), "--dir", model_dir],
          cwd: model_dir,
          signal: agent_controller.signal,
          on_chunk: append,
        })
      } finally {
        clearInterval(refinement_monitor)
        process_controller.signal.removeEventListener("abort", cancel_agent)
      }
      if (cancellation_signal.aborted) {
        await append("system", "\nThe SPICE model run was stopped. Champion checkpoints were preserved.\n")
        await publishAvailableModelCheckpoint(input.model_run_id, model_dir, context.model_run_store).catch(
          () => false,
        )
        markModelRunCancelled(input.model_run_id, context.model_run_store)
        return
      }

      const checkpoint_available = await publishAvailableModelCheckpoint(
        input.model_run_id,
        model_dir,
        context.model_run_store,
      )
      if (!checkpoint_available) {
        throw new Error("The agent did not leave a canonical, promoted, or recoverable model checkpoint")
      }
      if (!(await hasBenchmarkManifest(model_dir))) {
        if (refinement_effort_exhausted) {
          final_error_message = "Refinement effort expired before creating a benchmark suite."
          break
        }
        throw new Error("The agent did not create benchmarks.json")
      }
      await verifyBenchmarkLock(model_dir, benchmark_lock)
      if (refinement_effort_exhausted) {
        await append(
          "system",
          "Refinement effort expired. Running independent validation against the latest checkpoint without charging the validation time.\n",
        )
      }
      if (agent_exit_code !== 0 && !budget_exhausted && !refinement_effort_exhausted) {
        throw new Error(`tsci-agent exited with code ${agent_exit_code}`)
      }

      context.model_run_store.updateModelRun(input.model_run_id, {
        status: "validating",
        is_complete: false,
        has_errors: false,
      })
      await progress_monitor.sync()
      await artifact_monitor.sync()
      updateServerProgress(
        input.model_run_id,
        context.model_run_store,
        "validating",
        "Re-running the locked suite and extracting server-verified simulator results",
      )
      context.model_run_store.pauseSegment(input.model_run_id)
      if (budget_monitor) clearInterval(budget_monitor)
      budget_monitor = undefined
      const validation_controller = new AbortController()
      const cancel_validation = () => validation_controller.abort()
      cancellation_signal.addEventListener("abort", cancel_validation, { once: true })
      const configured_validation_timeout_ms = Number(process.env.MODEL_VALIDATION_TIMEOUT_MS ?? 30 * 60_000)
      const validation_timeout_ms = Number.isFinite(configured_validation_timeout_ms)
        ? Math.max(1_000, configured_validation_timeout_ms)
        : 30 * 60_000
      const validation_timer = setTimeout(() => {
        validation_controller.abort()
      }, validation_timeout_ms)
      try {
        await clearVerifiedSimulationResults(model_dir)
        final_champion = await validateChampion(
          {
            model_run_id: input.model_run_id,
            job_id: model_run.job_id,
            job_dir,
            model_dir,
            benchmark_lock,
            signal: validation_controller.signal,
          },
          context,
        )
        if (final_champion.infrastructure_error) {
          throw new ModelInfrastructureError(final_champion.infrastructure_error)
        }
        await verifyBenchmarkLock(model_dir, benchmark_lock)
        if (final_champion.benchmark_contract_error) {
          final_error_message = final_champion.benchmark_contract_error
        } else if (!(await hasCompleteVerifiedSimulationReport(model_dir))) {
          final_validation = undefined
          final_error_message =
            "Scoring was deferred because independent simulation validation is incomplete."
        } else {
          final_validation = await scoreModelBenchmarks(model_dir, {
            results_directory_override: getVerifiedResultsDirectory(model_dir),
          })
          await Bun.write(
            join(model_dir, "validation-report.json"),
            `${JSON.stringify(final_validation, null, 2)}\n`,
          )
          await artifact_monitor.sync()
        }
      } catch (error) {
        if (error instanceof ModelInfrastructureError) throw error
        final_error_message = error instanceof Error ? error.message : String(error)
        if (error instanceof ModelProcessStaleError) stale_timeout = true
      } finally {
        clearTimeout(validation_timer)
        cancellation_signal.removeEventListener("abort", cancel_validation)
      }
      if (cancellation_signal.aborted) {
        markModelRunCancelled(input.model_run_id, context.model_run_store)
        return
      }

      if (final_champion?.benchmark_contract_error) {
        const configured_recoveries = Number(process.env.MODEL_BENCHMARK_RECOVERY_ATTEMPTS ?? 2)
        const maximum_recoveries = Number.isInteger(configured_recoveries)
          ? Math.max(0, Math.min(4, configured_recoveries))
          : 2
        if (benchmark_recovery_count >= maximum_recoveries) {
          final_error_message = `Benchmark circuit recovery limit reached: ${final_champion.benchmark_contract_error}`
          break
        }
        benchmark_recovery_count += 1
        context.model_run_store.pauseSegment(input.model_run_id)
        if (budget_monitor) clearInterval(budget_monitor)
        budget_monitor = undefined
        budget_exhausted = false
        process_controller = new AbortController()
        await append(
          "system",
          `Independent validation found a structural defect in the locked benchmark circuit. Pausing and discarding model refinement, then returning only the circuit harness for controlled repair (lock generation ${benchmark_lock.generation + 1}).\n`,
        )
        updateServerProgress(
          input.model_run_id,
          context.model_run_store,
          "locking_benchmarks",
          `Repairing a structural benchmark defect in lock generation ${benchmark_lock.generation}`,
        )
        await clearRefinementArtifacts(model_dir)
        const repaired = await finalizeAndLockBenchmarks({
          model_run_id: input.model_run_id,
          job_dir,
          model_dir,
          signal: process_controller.signal,
          context,
          append,
          initial_feedback: final_champion.benchmark_contract_error,
          repair_lock: benchmark_lock,
        })
        benchmark_lock = repaired.benchmark_lock
        context.model_run_store.rememberBenchmarkLock(input.model_run_id, benchmark_lock)
        const repaired_run_count = await getSimulationRunCount(model_dir)
        context.model_run_store.setValidationProfile(input.model_run_id, {
          simulation_run_count: repaired_run_count,
        })
        context.model_run_store.restartSegment(input.model_run_id)
        budget_monitor = startBudgetMonitor()
        final_champion = undefined
        final_validation = undefined
        final_error_message = undefined
        agent_attempt = 0
        await append(
          "system",
          `Committed benchmark lock generation ${benchmark_lock.generation}; restarting model refinement from a clean time boundary.\n`,
        )
        continue
      }

      const validation_complete = final_validation?.all_passed === true && !final_champion?.integration_error
      if (validation_complete) break

      const simulation_failures =
        final_champion?.simulation_verifications.filter((verification) => !verification.passed) ?? []
      const score_failures = final_validation?.benchmarks.filter((benchmark) => !benchmark.passed) ?? []
      const scoring_status = final_validation
        ? score_failures.length > 0
          ? score_failures
              .map(
                (failure) =>
                  `- ${failure.benchmark_id}: ${summarizeValidationFeedback(
                    failure.error_message,
                    `NRMSE ${failure.normalized_rmse}`,
                  )}`,
              )
              .join("\n")
          : "- None"
        : "- Not scored because independent simulation validation is incomplete."
      final_error_message =
        final_champion?.integration_error ??
        final_error_message ??
        `${score_failures.length} of ${final_validation?.benchmark_count ?? 0} benchmarks failed scoring.`
      await Bun.write(
        join(model_dir, "validation-feedback.md"),
        `# Server validation feedback\n\nValidation is not complete. Fix the model without changing the server-locked benchmark manifest, circuits, evidence, tolerances, or transient waveform definitions.\n\nThe exact server-run outputs are saved in \`simulation-validation.json\` and \`validation-artifacts/<benchmark-id>/\`. Inspect those Circuit JSON files and extracted curves before changing the model.\n\n## Simulation failures\n\n${
          simulation_failures.length > 0
            ? simulation_failures
                .map(
                  (failure) =>
                    `- ${failure.benchmark_id}: ${summarizeValidationFeedback(
                      failure.error_message,
                      "simulation verification failed",
                    )}`,
                )
                .join("\n")
            : "- None"
        }\n\n## Scoring failures\n\n${scoring_status}\n`,
      )
      await append(
        "system",
        `Independent validation is not at 100%: ${simulation_failures.length} simulation verification failure(s), ${score_failures.length} scoring failure(s).\n`,
      )

      const remaining_after_validation = context.model_run_store.getRemainingTimeMs(input.model_run_id) ?? 0
      if (remaining_after_validation <= 0 || budget_exhausted) {
        final_error_message = "Ran out of iterations before every benchmark could be verified."
        break
      }
      if (stale_timeout) break
      budget_exhausted = false
      context.model_run_store.startSegment(input.model_run_id)
      budget_monitor = startBudgetMonitor()
    }

    if (budget_monitor) {
      clearInterval(budget_monitor)
      budget_monitor = undefined
    }
    const validation_complete = final_validation?.all_passed === true && !final_champion?.integration_error
    if (validation_complete && final_champion && final_validation) {
      await verifyBenchmarkLock(model_dir, benchmark_lock)
      await rm(join(model_dir, "validation-feedback.md"), { force: true })
      await attachModelToGeneratedComponent({
        job_id: model_run.job_id,
        job_dir,
        model_dir,
        job_store: context.job_store,
      })
      await append("system", "Attached the validated server-generated model wrapper to the component.\n")
      await append("system", "SPICE model complete. Every locked benchmark passed verified simulation.\n")
      updateServerProgress(
        input.model_run_id,
        context.model_run_store,
        "complete",
        "Every locked benchmark passed server-verified simulation",
        {
          iteration: final_champion.iteration,
          benchmark: {
            completed: final_validation.benchmark_count,
            total: final_validation.benchmark_count,
          },
          champion: {
            revision: final_champion.manifest.revision,
            passing: final_validation.passing_count,
            total: final_validation.benchmark_count,
            score: final_validation.score,
            worst_normalized_error: final_validation.worst_normalized_error,
          },
        },
      )
      context.model_run_store.finishSegment(input.model_run_id, {
        status: "complete",
        is_complete: true,
        has_errors: false,
        error_message: undefined,
        completed_at: new Date().toISOString(),
        iteration: final_champion.iteration,
        model_source: final_champion.model_source,
        manifest: final_champion.manifest,
        validation: final_validation,
        model_card: final_champion.model_card,
      })
    } else {
      const timeout_message =
        final_error_message ?? "Ran out of iterations before every benchmark could be verified."
      await append(
        "system",
        `${stale_timeout ? "The model run timed out after producing no output" : "Ran out of iterations before 100% validation"}. The latest model checkpoint remains available. ${timeout_message}\n`,
      )
      updateServerProgress(input.model_run_id, context.model_run_store, "timed_out", timeout_message)
      context.model_run_store.finishSegment(input.model_run_id, {
        status: "timed_out",
        is_complete: true,
        has_errors: true,
        error_message: timeout_message,
        completed_at: new Date().toISOString(),
        ...(final_champion
          ? {
              iteration: final_champion.iteration,
              model_source: final_champion.model_source,
              manifest: final_champion.manifest,
              model_card: markModelCardAsUnverified(final_champion.model_card),
            }
          : {}),
        ...(final_validation ? { validation: final_validation } : {}),
      })
    }
  } catch (error) {
    if (budget_monitor) clearInterval(budget_monitor)
    if (cancellation_signal.aborted) {
      markModelRunCancelled(input.model_run_id, context.model_run_store)
      return
    }
    const is_stale_error = error instanceof ModelProcessStaleError
    const is_infrastructure_error = error instanceof ModelInfrastructureError
    const error_message = is_stale_error
      ? "The model run timed out after producing no output."
      : error instanceof Error
        ? error.message
        : String(error)
    await publishAvailableModelCheckpoint(input.model_run_id, model_dir, context.model_run_store).catch(
      () => false,
    )
    await append(
      "system",
      `\n${
        is_stale_error
          ? "The model run timed out after producing no output"
          : is_infrastructure_error
            ? "The model run stopped safely because a server infrastructure check failed"
            : "SPICE model workflow failed"
      }: ${error_message}\n`,
    ).catch(() => undefined)
    const current_run = context.model_run_store.getModelRun(input.model_run_id)
    const update = {
      status: is_stale_error ? ("timed_out" as const) : ("failed" as const),
      is_complete: true,
      has_errors: true,
      completed_at: new Date().toISOString(),
      error_message,
    }
    updateServerProgress(
      input.model_run_id,
      context.model_run_store,
      is_stale_error ? "timed_out" : "failed",
      error_message,
    )
    if (current_run?.segment_started_at) context.model_run_store.finishSegment(input.model_run_id, update)
    else context.model_run_store.updateModelRun(input.model_run_id, update)
  } finally {
    progress_monitor?.stop()
    artifact_monitor?.stop()
    cancellation_signal.removeEventListener("abort", cancel_process)
  }
}

export async function listModelBenchFiles(model_dir: string): Promise<string[]> {
  const manifest_value: unknown = JSON.parse(await readFile(join(model_dir, "benchmarks.json"), "utf8"))
  return parseBenchmarkManifest(manifest_value).benchmarks.map((benchmark) => `${benchmark.id}.circuit.tsx`)
}
