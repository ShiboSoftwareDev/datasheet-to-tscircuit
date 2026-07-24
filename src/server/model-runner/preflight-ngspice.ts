import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import type { JobLogStream } from "@/shared/job-types"
import { getCircuitBuildDiagnostics } from "../model-simulation-validator"
import { ModelInfrastructureError, streamModelProcess } from "./stream-model-process"
import {
  captureProcessOutput,
  getFatalSimulationProcessFailure,
  isTransientAgentTransportFailure,
  summarizeProcessFailure,
} from "./model-process-output"
import { isCircuitJson } from "./attach-model-to-generated-component"

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
    const configured_retries = Number(process.env.MODEL_VALIDATION_TRANSPORT_RETRIES ?? 4)
    const retry_count = Number.isInteger(configured_retries)
      ? Math.max(0, Math.min(5, configured_retries))
      : 4
    const configured_base_delay_ms = Number(process.env.MODEL_VALIDATION_TRANSPORT_RETRY_BASE_DELAY_MS ?? 500)
    const base_delay_ms =
      Number.isFinite(configured_base_delay_ms) && configured_base_delay_ms >= 0
        ? configured_base_delay_ms
        : 500
    let exit_code = 1
    for (let attempt = 0; attempt <= retry_count; attempt += 1) {
      process_output = ""
      await rm(output_directory, { recursive: true, force: true })
      try {
        exit_code = await streamModelProcess({
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
      } catch (error) {
        process_output = captureProcessOutput(
          process_output,
          error instanceof Error ? error.message : String(error),
        )
        exit_code = 1
      }
      if (exit_code === 0) {
        const candidate_circuit_json: unknown = await readFile(join(output_directory, "circuit.json"), "utf8")
          .then((text) => JSON.parse(text))
          .catch(() => undefined)
        if (candidate_circuit_json !== undefined) {
          const diagnostics = getCircuitBuildDiagnostics(candidate_circuit_json)
          const diagnostic_message = [...diagnostics.source_errors, ...diagnostics.simulation_errors].join(
            "; ",
          )
          if (diagnostic_message && isTransientAgentTransportFailure(diagnostic_message)) {
            process_output = captureProcessOutput(process_output, diagnostic_message)
            exit_code = 1
          }
        }
      }
      const is_transient = exit_code !== 0 && isTransientAgentTransportFailure(process_output)
      if (!is_transient || input.signal.aborted || attempt >= retry_count) break
      await input.append(
        "system",
        `ngspice preflight transport closed; retrying the same untimed check (${attempt + 2}/${retry_count + 1}).\n`,
      )
      await Bun.sleep(Math.min(5_000, base_delay_ms * 2 ** attempt))
    }
    if (exit_code !== 0) {
      throw new ModelInfrastructureError(
        `ngspice preflight failed: ${summarizeProcessFailure(process_output)}`,
      )
    }
    const fatal_simulation_failure = getFatalSimulationProcessFailure(process_output)
    if (fatal_simulation_failure) {
      throw new ModelInfrastructureError(`ngspice preflight failed: ${fatal_simulation_failure}`)
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
