import { mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import type { ModelManifest } from "@/shared/job-types"
import { classifyNgspiceFailure, type NgspiceExecutor, parseNgspiceAsciiRaw } from "../spice-validation"

const MAX_DIAGNOSTIC_LINES = 16
const MAX_DIAGNOSTIC_CHARACTERS = 4_000

function diagnosticLines(output: string): string[] {
  const lines = output
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const relevant = lines.filter((line) =>
    /(?:error|fatal|syntax|unknown|undefined|no such|unsupported|warning|line\s+\d+)/i.test(line),
  )
  return (relevant.length > 0 ? relevant : lines).slice(0, MAX_DIAGNOSTIC_LINES)
}

/**
 * Keeps simulator-owned model diagnostics useful to the correction agent while
 * removing temporary host/container paths from logs and prompts.
 */
export function sanitizeCandidateSmokeDiagnostic(input: {
  stdout: string
  stderr: string
  workspace: string
}): string {
  const workspace_variants = [input.workspace, input.workspace.replaceAll("\\", "/")]
  const seen = new Set<string>()
  const lines = diagnosticLines(`${input.stderr}\n${input.stdout}`).flatMap((raw_line) => {
    let line = raw_line
    for (const workspace of workspace_variants) {
      if (workspace) line = line.replaceAll(workspace, "<candidate>")
    }
    line = line
      .replace(/(?:\/[^\s"']+)+\/(model\.lib|candidate-smoke\.cir|result\.raw)/g, "$1")
      .replace(/\.\.\/model\.lib/g, "model.lib")
    if (!line || seen.has(line)) return []
    seen.add(line)
    return [line]
  })
  const diagnostic = lines.join("\n") || "ngspice returned no diagnostic output"
  return diagnostic.slice(0, MAX_DIAGNOSTIC_CHARACTERS)
}

function smokeNetlist(manifest: ModelManifest): string {
  const nodes = manifest.pins.map((_pin, index) => `smoke_${index + 1}`)
  return [
    "* Server-owned candidate syntax and zero-bias smoke check",
    ".include ../model.lib",
    `X_DUT ${nodes.join(" ")} ${manifest.entry_name}`,
    ...nodes.map((node, index) => `R_SMOKE_${index + 1} ${node} 0 1T`),
    ".op",
    ".end",
    "",
  ].join("\n")
}

/**
 * Compiles and settles the public subcircuit before it can consume private
 * validation or repair budget. The harness contains no datasheet targets or
 * held-out fixture information.
 */
export async function assertNgspiceAcceptsModelCandidate(input: {
  workspace: string
  manifest: ModelManifest
  ngspice: NgspiceExecutor
  ngspice_path: string
  signal: AbortSignal
}): Promise<void> {
  input.signal.throwIfAborted()
  const smoke_directory = join(input.workspace, ".candidate-smoke")
  const circuit_path = join(smoke_directory, "candidate-smoke.cir")
  const raw_path = join(smoke_directory, "result.raw")
  await mkdir(smoke_directory, { recursive: true })
  await Promise.all([
    Bun.write(circuit_path, smokeNetlist(input.manifest)),
    Bun.write(join(smoke_directory, ".spiceinit"), "set filetype=ascii\n"),
    rm(raw_path, { force: true }),
  ])
  input.signal.throwIfAborted()
  const execution = await input.ngspice({
    executable: input.ngspice_path,
    cwd: smoke_directory,
    circuit_path,
    raw_path,
    signal: input.signal,
  })
  input.signal.throwIfAborted()
  const process_failure = classifyNgspiceFailure(
    `${execution.stdout}\n${execution.stderr}`.trim(),
    execution.exit_code,
  )
  if (!execution.cancelled && !process_failure) {
    try {
      const raw = parseNgspiceAsciiRaw(await readFile(raw_path, "utf8"))
      const operating_point = raw.plots.find(({ plot_name }) => /operating point/i.test(plot_name))
      if (!operating_point || operating_point.rows.length === 0) {
        throw new Error("raw output contains no operating-point samples")
      }
      return
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error))
        .replaceAll(input.workspace, "<candidate>")
        .slice(0, 1_000)
      throw new Error(`ngspice candidate smoke produced no valid operating-point result: ${detail}`)
    }
  }
  const diagnostic = sanitizeCandidateSmokeDiagnostic({
    stdout: execution.stdout,
    stderr: execution.stderr,
    workspace: input.workspace,
  })
  throw new Error(
    `ngspice rejected model.lib during candidate smoke validation (exit ${execution.exit_code}):\n${diagnostic}`,
  )
}
