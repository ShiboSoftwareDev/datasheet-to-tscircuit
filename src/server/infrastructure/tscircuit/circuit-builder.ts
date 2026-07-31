import { readdir, readFile, rm } from "node:fs/promises"
import { join, relative } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import { isCircuitJson } from "../../component-circuit-json"
import { ProcessError, type ProcessRunner } from "../process"

export type TscircuitCheck = "netlist" | "placement" | "routing-difficulty"

const TSCIRCUIT_IDLE_TIMEOUT_MS = 60_000
const TSCIRCUIT_WALL_TIMEOUT_MS = 5 * 60_000

async function findCircuitJson(directory: string): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = await findCircuitJson(path)
      if (nested) return nested
    } else if (entry.name === "circuit.json" || entry.name.endsWith(".circuit.json")) {
      return path
    }
  }
  return undefined
}

function circuitErrors(circuit_json: AnyCircuitElement[], ignored_types: ReadonlySet<string>): string[] {
  const errors = new Set<string>()
  for (const element of circuit_json) {
    if (!element.type.endsWith("_error") || ignored_types.has(element.type)) continue
    const message =
      "message" in element && typeof element.message === "string"
        ? element.message.split(/\s+Details:\s+Props:/i)[0]!.trim()
        : element.type
    errors.add(`${element.type}: ${message}`)
  }
  return [...errors]
}

export interface CircuitBuildResult {
  circuit_json: AnyCircuitElement[]
  circuit_json_path: string
  errors: string[]
  renders: {
    pcb_png?: string
    schematic_svg?: string
    schematic_png?: string
  }
}

function processFailureMessage(error: unknown): string {
  if (!(error instanceof ProcessError)) return error instanceof Error ? error.message : String(error)
  const tail = error.output_tail?.trim()
  return tail ? `${error.message}: ${tail.slice(-2_000)}` : error.message
}

function isInfrastructureProcessFailure(error: unknown): error is ProcessError {
  return (
    error instanceof ProcessError &&
    (error.code === "process_spawn_failed" ||
      error.code === "process_output_handler_failed" ||
      error.code === "process_idle_timeout" ||
      error.code === "process_wall_timeout")
  )
}

async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists()
}

export async function buildTscircuitSource(input: {
  workspace: string
  source_file: string
  output_stem: string
  tsci_bin: string
  process_runner: ProcessRunner
  signal: AbortSignal
  ignored_error_types?: readonly string[]
  build_args?: readonly string[]
  checks?: readonly TscircuitCheck[]
  render?: { pcb: boolean; schematic: boolean }
  on_output?: (stream: "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<CircuitBuildResult> {
  const output_dir = join(input.workspace, "dist", input.output_stem)
  await rm(output_dir, { recursive: true, force: true })
  const errors: string[] = []
  for (const check of input.checks ?? []) {
    try {
      await input.process_runner.run({
        command: [input.tsci_bin, "check", check, input.source_file],
        command_label: `tsci check ${check} ${input.source_file}`,
        cwd: input.workspace,
        signal: input.signal,
        idle_timeout_ms: TSCIRCUIT_IDLE_TIMEOUT_MS,
        wall_timeout_ms: TSCIRCUIT_WALL_TIMEOUT_MS,
        env: { NODE_ENV: "development" },
        on_output: input.on_output,
      })
    } catch (error) {
      if (input.signal.aborted || (error instanceof ProcessError && error.code === "process_cancelled")) {
        throw error
      }
      if (isInfrastructureProcessFailure(error)) throw error
      errors.push(`check/${check}: ${processFailureMessage(error)}`)
    }
  }
  try {
    await input.process_runner.run({
      command: [
        input.tsci_bin,
        "build",
        input.source_file,
        "--ignore-errors",
        "--ignore-warnings",
        ...(input.render?.pcb ? ["--pcb-png"] : []),
        ...(input.render?.schematic ? ["--schematic-svgs"] : []),
        ...(input.build_args ?? []),
      ],
      command_label: `tsci build ${input.source_file}`,
      cwd: input.workspace,
      signal: input.signal,
      idle_timeout_ms: TSCIRCUIT_IDLE_TIMEOUT_MS,
      wall_timeout_ms: TSCIRCUIT_WALL_TIMEOUT_MS,
      env: { NODE_ENV: "development" },
      on_output: input.on_output,
    })
  } catch (error) {
    if (input.signal.aborted || (error instanceof ProcessError && error.code === "process_cancelled")) {
      throw error
    }
    if (isInfrastructureProcessFailure(error)) throw error
    errors.push(`build: ${processFailureMessage(error)}`)
  }
  const circuit_json_path = await findCircuitJson(output_dir)
  if (!circuit_json_path) {
    throw new Error(
      [`tsci build ${input.source_file} produced no Circuit JSON under ${output_dir}`, ...errors].join("\n"),
    )
  }
  const value: unknown = JSON.parse(await readFile(circuit_json_path, "utf8"))
  if (!isCircuitJson(value)) {
    throw new Error(`tsci build ${input.source_file} produced malformed Circuit JSON`)
  }
  errors.push(...circuitErrors(value, new Set(input.ignored_error_types ?? [])))
  if (input.build_args?.includes("--disable-pcb") && value.some(({ type }) => type.startsWith("pcb_"))) {
    errors.push("schematic-only build unexpectedly produced PCB Circuit JSON elements")
  }

  const pcb_png = join(output_dir, "pcb.png")
  const schematic_svg = join(output_dir, "schematic.svg")
  const schematic_png = join(output_dir, "schematic.png")
  if (input.render?.schematic && (await fileExists(schematic_svg))) {
    try {
      await input.process_runner.run({
        command: [process.execPath, "render-svg-to-png.ts", relative(input.workspace, schematic_svg)],
        command_label: `render schematic ${input.source_file}`,
        cwd: input.workspace,
        signal: input.signal,
        idle_timeout_ms: TSCIRCUIT_IDLE_TIMEOUT_MS,
        wall_timeout_ms: TSCIRCUIT_WALL_TIMEOUT_MS,
        env: { NODE_ENV: "development" },
        on_output: input.on_output,
      })
    } catch (error) {
      if (input.signal.aborted || (error instanceof ProcessError && error.code === "process_cancelled")) {
        throw error
      }
      if (isInfrastructureProcessFailure(error)) throw error
      errors.push(`render/schematic: ${processFailureMessage(error)}`)
    }
  }
  if (input.render?.pcb && !(await fileExists(pcb_png))) errors.push("render: PCB PNG was not produced")
  if (input.render?.schematic && !(await fileExists(schematic_svg))) {
    errors.push("render: schematic SVG was not produced")
  }
  if (input.render?.schematic && !(await fileExists(schematic_png))) {
    errors.push("render: schematic PNG was not produced")
  }

  return {
    circuit_json: value,
    circuit_json_path,
    errors: [...new Set(errors)],
    renders: {
      ...((await fileExists(pcb_png)) ? { pcb_png } : {}),
      ...((await fileExists(schematic_svg)) ? { schematic_svg } : {}),
      ...((await fileExists(schematic_png)) ? { schematic_png } : {}),
    },
  }
}
