import { join } from "node:path"
export {
  captureAgentProcessOutput as captureProcessOutput,
  isTransientAgentTransportFailure,
} from "../agent-tools/agent-transport-failure"
import { SimulationFailureKind } from "./validate-champion"

export function summarizeProcessFailure(output: string): string | undefined {
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

export function getFatalSimulationProcessFailure(output: string): string | undefined {
  const lines = output
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const fatal_lines = lines.filter((line) =>
    /^(?:fatal error:|doanalyses:.*(?:aborted|failed)|run simulation\(s\) aborted)/i.test(line),
  )
  return fatal_lines.length > 0 ? fatal_lines.slice(-4).join(" | ").slice(-4_000) : undefined
}

export function classifyFatalSimulationFailure(message: string): SimulationFailureKind {
  return /instance\s+vsimulation_voltage_source_\d+\s+is\s+a\s+shorted\s+vsrc/i.test(message)
    ? "benchmark_structure"
    : "simulation"
}

export function summarizeValidationFeedback(message: string | undefined, fallback: string): string {
  if (!message) return fallback
  const concise = message
    .split(/\s+Details:\s+Props:/i)[0]!
    .replace(/\s+/g, " ")
    .trim()
  return concise.length > 1_200 ? `${concise.slice(0, 1_197)}…` : concise
}
