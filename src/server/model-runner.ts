import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises"
import { delimiter, dirname, join } from "node:path"
import type { JobLogStream, ModelManifest, ModelProgress, ModelProgressPhase } from "@/shared/job-types"
import type { JobStore } from "./job-store"
import { startModelArtifactMonitor, type ModelArtifactMonitor } from "./model-artifact-monitor"
import { startModelProgressMonitor, type ModelProgressMonitor } from "./model-progress"
import {
  buildModelAgentPrompt,
  buildModelSetupPrompt,
  copyComponentIntoModelWorkspace,
  writeModelScaffold,
} from "./model-scaffold"
import type { ModelRunStore } from "./model-run-store"
import { scoreModelBenchmarks } from "./model-scorer"
import {
  clearVerifiedSimulationResults,
  getModelSimulationSourceSignature,
  getSimulationBuildPlan,
  getVerifiedResultsDirectory,
  type SimulationBenchmarkVerification,
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

  let force_kill_timer: ReturnType<typeof setTimeout> | undefined
  const stop_process = () => {
    killProcessGroup(child_process, "SIGTERM")
    force_kill_timer = setTimeout(() => killProcessGroup(child_process, "SIGKILL"), 2_000)
  }
  input.signal.addEventListener("abort", stop_process, { once: true })

  try {
    const [exit_code] = await Promise.all([
      child_process.exited,
      readProcessStream({ readable: child_process.stdout, stream: "stdout", on_chunk: input.on_chunk }),
      readProcessStream({ readable: child_process.stderr, stream: "stderr", on_chunk: input.on_chunk }),
    ])
    return exit_code
  } finally {
    input.signal.removeEventListener("abort", stop_process)
    if (force_kill_timer) clearTimeout(force_kill_timer)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseModelManifest(value: unknown): ModelManifest {
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
    simulator: value.simulator as string,
    generated_at: value.generated_at as string,
    pins,
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

async function publishAvailableModelCheckpoint(
  model_run_id: string,
  model_dir: string,
  model_run_store: ModelRunStore,
): Promise<boolean> {
  const model_file = await recoverBestModelFile(model_dir)
  if (!model_file) return false
  const model_source = await readFile(model_file, "utf8")
  if (!/^\s*\.\s*(subckt|model)\b/im.test(model_source)) return false
  const manifest = await readFile(join(model_dir, "model-manifest.json"), "utf8")
    .then((text) => parseModelManifest(JSON.parse(text) as unknown))
    .catch(() => undefined)
  const model_card = await readFile(join(model_dir, "model-card.md"), "utf8").catch(() => undefined)
  const iteration = await readIterationCount(model_dir).catch(() => 0)
  model_run_store.updateModelRun(model_run_id, {
    model_source,
    ...(manifest ? { manifest } : {}),
    ...(model_card ? { model_card } : {}),
    iteration,
  })
  return true
}

async function hasCompletedSetup(model_dir: string): Promise<boolean> {
  return Bun.file(join(model_dir, "setup-complete.json")).exists()
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
    `import Component from "./component.circuit"

const modelSource = ${JSON.stringify(input.model_source)}
const ModelComponent = Component as any

export type ComponentWithModelProps = Parameters<typeof Component>[0]

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

async function validateChampion(
  input: { model_run_id: string; job_id: string; job_dir: string; model_dir: string; signal: AbortSignal },
  context: ModelRunnerContext,
): Promise<{
  manifest: ModelManifest
  model_source: string
  model_card: string
  iteration: number
  integration_error?: string
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
  if (!/^\s*\.\s*(subckt|model)\b/im.test(model_source)) {
    throw new Error("model.lib must contain a .SUBCKT or .MODEL declaration")
  }
  const manifest = parseModelManifest(manifest_value)
  const component_path = join(input.model_dir, "component-with-model.circuit.tsx")
  if (!(await Bun.file(component_path).exists())) {
    await writeServerIntegratedComponent({ model_dir: input.model_dir, manifest, model_source })
  }

  const append = async (stream: JobLogStream, message: string) => {
    await context.model_run_store.appendLog(input.model_run_id, stream, message)
  }
  const integration_errors: string[] = []
  let build_exit_code = await streamModelProcess({
    command: [context.tsci_bin, "build", "component-with-model.circuit.tsx", "--ignore-warnings"],
    cwd: input.model_dir,
    signal: input.signal,
    on_chunk: append,
  })
  if (build_exit_code !== 0 && !input.signal.aborted) {
    await append(
      "system",
      "The agent integration component did not build; retrying with the server-generated wrapper.\n",
    )
    await writeServerIntegratedComponent({ model_dir: input.model_dir, manifest, model_source })
    build_exit_code = await streamModelProcess({
      command: [context.tsci_bin, "build", "component-with-model.circuit.tsx", "--ignore-warnings"],
      cwd: input.model_dir,
      signal: input.signal,
      on_chunk: append,
    })
  }
  if (build_exit_code !== 0) {
    integration_errors.push(`The tscircuit model integration build exited with code ${build_exit_code}`)
  } else {
    await attachModelToGeneratedComponent({
      job_id: input.job_id,
      job_dir: input.job_dir,
      model_dir: input.model_dir,
      job_store: context.job_store,
    })
    await append("system", "Attached the model to the generated footprint/schematic component.\n")
  }

  const benchmark_files = await listModelBenchFiles(input.model_dir)
  if (benchmark_files.length === 0) throw new Error("No tscircuit benchmark circuits were created")
  const simulation_verifications: SimulationBenchmarkVerification[] = []
  for (const benchmark_file of benchmark_files) {
    const benchmark_id = benchmark_file.replace(/\.circuit\.tsx$/i, "")
    if (input.signal.aborted) {
      integration_errors.push("The independent benchmark re-run reached its validation time limit")
      break
    }
    const build_plan = await getSimulationBuildPlan(input.model_dir, benchmark_id)
    const point_paths: Array<{ path: string; x: number }> = []
    let simulation_exit_code = 0
    for (let point_index = 0; point_index < build_plan.length; point_index += 1) {
      const point = build_plan[point_index]!
      await append(
        "system",
        `Building and running locked benchmark ${benchmark_file} (${point_index + 1}/${build_plan.length})${point.x === undefined ? "" : ` at x=${point.x}`}…\n`,
      )
      await rm(join(input.job_dir, "dist", "spice", "benchmarks", benchmark_id), {
        recursive: true,
        force: true,
      })
      const command = [context.tsci_bin, "build", join("benchmarks", benchmark_file), "--ignore-warnings"]
      if (point.props) command.push("--inject-props", JSON.stringify(point.props))
      simulation_exit_code = await streamModelProcess({
        command,
        cwd: input.model_dir,
        signal: input.signal,
        on_chunk: append,
      })
      const generated_path = join(input.job_dir, "dist", "spice", "benchmarks", benchmark_id, "circuit.json")
      if (simulation_exit_code === 0 && point.x !== undefined) {
        const saved_path = join(
          input.model_dir,
          "validation-artifacts",
          benchmark_id,
          "runs",
          point.run_id,
          "circuit.json",
        )
        await mkdir(dirname(saved_path), { recursive: true })
        await Bun.write(saved_path, await readFile(generated_path))
        point_paths.push({ path: saved_path, x: point.x })
      }
      if (simulation_exit_code !== 0) break
    }
    if (simulation_exit_code !== 0) {
      const captured = await verifySimulationBenchmark({
        model_dir: input.model_dir,
        benchmark_id,
        source_signature: await getModelSimulationSourceSignature(input.model_dir, benchmark_id),
        circuit_json_paths: point_paths.length ? point_paths : undefined,
      })
      const error_message = `${benchmark_file} build exited with code ${simulation_exit_code}${
        captured.error_message ? `: ${captured.error_message}` : ""
      }`
      integration_errors.push(error_message)
      simulation_verifications.push({
        ...captured,
        benchmark_id,
        passed: false,
        error_message,
      })
      await writeSimulationValidationReport(input.model_dir, simulation_verifications)
      continue
    }
    const verification = await verifySimulationBenchmark({
      model_dir: input.model_dir,
      benchmark_id,
      source_signature: await getModelSimulationSourceSignature(input.model_dir, benchmark_id),
      circuit_json_paths: point_paths.length ? point_paths : undefined,
    })
    simulation_verifications.push(verification)
    await writeSimulationValidationReport(input.model_dir, simulation_verifications)
    if (!verification.passed) {
      integration_errors.push(`${benchmark_file}: ${verification.error_message}`)
    }
  }
  await writeSimulationValidationReport(input.model_dir, simulation_verifications)
  return {
    manifest,
    model_source,
    model_card,
    iteration,
    integration_error: integration_errors.length > 0 ? integration_errors.join("; ") : undefined,
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

  const append = async (stream: JobLogStream, message: string): Promise<void> => {
    await context.model_run_store.appendLog(input.model_run_id, stream, message)
  }

  let budget_exhausted = false
  const process_controller = new AbortController()
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
        await append("system", "\nThe PSpice model setup was stopped. Extracted evidence was preserved.\n")
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

    context.model_run_store.startSegment(input.model_run_id)
    updateServerProgress(
      input.model_run_id,
      context.model_run_store,
      "locking_benchmarks",
      "The component is ready; locking benchmarks before baseline modeling",
    )
    await append(
      "system",
      `The component is ready. Starting the fixed PSpice refinement workflow with ${Math.round(
        (context.model_run_store.getRemainingTimeMs(input.model_run_id) ?? 0) / 1000,
      )} seconds of refinement time remaining…\n`,
    )

    let final_champion: Awaited<ReturnType<typeof validateChampion>> | undefined
    let final_validation: Awaited<ReturnType<typeof scoreModelBenchmarks>> | undefined
    let final_error_message: string | undefined
    let agent_attempt = 0

    budget_monitor = setInterval(() => {
      const remaining_time_ms = context.model_run_store.getRemainingTimeMs(input.model_run_id)
      if (remaining_time_ms !== undefined && remaining_time_ms <= 0) {
        budget_exhausted = true
        process_controller.abort()
      }
    }, 500)

    while (true) {
      agent_attempt += 1
      const remaining_before_agent = context.model_run_store.getRemainingTimeMs(input.model_run_id) ?? 0
      if (remaining_before_agent <= 0) {
        budget_exhausted = true
        final_error_message = "The effort budget expired before every benchmark could be verified."
        break
      }

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

      const agent_exit_code = await streamModelProcess({
        command: [context.agent_bin, "do", "--prompt", buildModelAgentPrompt(), "--dir", model_dir],
        cwd: model_dir,
        signal: process_controller.signal,
        on_chunk: append,
      })
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
      if (agent_exit_code !== 0 && !budget_exhausted) {
        throw new Error(`tsci-agent exited with code ${agent_exit_code}`)
      }
      if (budget_exhausted) {
        final_error_message = "The effort budget expired before independent validation could finish."
        break
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

      const remaining_before_validation = context.model_run_store.getRemainingTimeMs(input.model_run_id) ?? 0
      if (remaining_before_validation <= 0) {
        budget_exhausted = true
        final_error_message = "The effort budget expired before independent validation could start."
        break
      }
      const validation_controller = new AbortController()
      const cancel_validation = () => validation_controller.abort()
      cancellation_signal.addEventListener("abort", cancel_validation, { once: true })
      process_controller.signal.addEventListener("abort", cancel_validation, { once: true })
      const validation_timer = setTimeout(() => {
        validation_controller.abort()
      }, remaining_before_validation)
      try {
        await clearVerifiedSimulationResults(model_dir)
        final_champion = await validateChampion(
          {
            model_run_id: input.model_run_id,
            job_id: model_run.job_id,
            job_dir,
            model_dir,
            signal: validation_controller.signal,
          },
          context,
        )
        final_validation = await scoreModelBenchmarks(model_dir, {
          results_directory_override: getVerifiedResultsDirectory(model_dir),
        })
        await Bun.write(
          join(model_dir, "validation-report.json"),
          `${JSON.stringify(final_validation, null, 2)}\n`,
        )
        await artifact_monitor.sync()
      } catch (error) {
        final_error_message = error instanceof Error ? error.message : String(error)
      } finally {
        clearTimeout(validation_timer)
        cancellation_signal.removeEventListener("abort", cancel_validation)
        process_controller.signal.removeEventListener("abort", cancel_validation)
      }
      if (cancellation_signal.aborted) {
        markModelRunCancelled(input.model_run_id, context.model_run_store)
        return
      }

      const validation_complete = final_validation?.all_passed === true && !final_champion?.integration_error
      if (validation_complete) break

      const simulation_failures =
        final_champion?.simulation_verifications.filter((verification) => !verification.passed) ?? []
      const score_failures = final_validation?.benchmarks.filter((benchmark) => !benchmark.passed) ?? []
      final_error_message =
        final_champion?.integration_error ??
        final_error_message ??
        `${score_failures.length} of ${final_validation?.benchmark_count ?? 0} benchmarks failed scoring.`
      await Bun.write(
        join(model_dir, "validation-feedback.md"),
        `# Server validation feedback\n\nValidation is not complete. Fix the model or benchmark circuits, then rerun the full locked suite.\n\nThe exact server-run outputs are saved in \`simulation-validation.json\` and \`validation-artifacts/<benchmark-id>/\`. Inspect those Circuit JSON files and extracted curves before changing the model.\n\n## Simulation failures\n\n${
          simulation_failures.length > 0
            ? simulation_failures
                .map(
                  (failure) =>
                    `- ${failure.benchmark_id}: ${failure.error_message ?? "simulation verification failed"}`,
                )
                .join("\n")
            : "- None"
        }\n\n## Scoring failures\n\n${
          score_failures.length > 0
            ? score_failures
                .map(
                  (failure) =>
                    `- ${failure.benchmark_id}: ${failure.error_message ?? `NRMSE ${failure.normalized_rmse}`}`,
                )
                .join("\n")
            : "- None"
        }\n`,
      )
      await append(
        "system",
        `Independent validation is not at 100%: ${simulation_failures.length} simulation verification failure(s), ${score_failures.length} scoring failure(s).\n`,
      )

      const remaining_after_validation = context.model_run_store.getRemainingTimeMs(input.model_run_id) ?? 0
      if (remaining_after_validation <= 0 || budget_exhausted) {
        final_error_message = "The effort budget expired before every benchmark could be verified."
        break
      }
    }

    if (budget_monitor) {
      clearInterval(budget_monitor)
      budget_monitor = undefined
    }
    const validation_complete = final_validation?.all_passed === true && !final_champion?.integration_error
    if (validation_complete && final_champion && final_validation) {
      await rm(join(model_dir, "validation-feedback.md"), { force: true })
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
        final_error_message ?? "The effort budget expired before every benchmark could be verified."
      await append(
        "system",
        `The model run timed out before 100% validation. The latest model checkpoint remains available. ${timeout_message}\n`,
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
              model_card: final_champion.model_card,
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
    const error_message = error instanceof Error ? error.message : String(error)
    await publishAvailableModelCheckpoint(input.model_run_id, model_dir, context.model_run_store).catch(
      () => false,
    )
    await append("system", `\nSPICE model workflow failed: ${error_message}\n`).catch(() => undefined)
    const current_run = context.model_run_store.getModelRun(input.model_run_id)
    const update = {
      status: "failed" as const,
      is_complete: true,
      has_errors: true,
      completed_at: new Date().toISOString(),
      error_message,
    }
    updateServerProgress(input.model_run_id, context.model_run_store, "failed", error_message)
    if (current_run?.segment_started_at) context.model_run_store.finishSegment(input.model_run_id, update)
    else context.model_run_store.updateModelRun(input.model_run_id, update)
  } finally {
    progress_monitor?.stop()
    artifact_monitor?.stop()
    cancellation_signal.removeEventListener("abort", cancel_process)
  }
}

export async function listModelBenchFiles(model_dir: string): Promise<string[]> {
  const bench_dir = join(model_dir, "benchmarks")
  const entries = await readdir(bench_dir).catch(() => [])
  return entries.filter((entry) => entry.endsWith(".circuit.tsx")).sort()
}
