import { ProcessError } from "@/server/infrastructure/process/process-error"
import { BunProcessRunner } from "@/server/infrastructure/process/process-runner"

export interface NgspiceExecutionRequest {
  executable: string
  cwd: string
  circuit_path: string
  raw_path: string
  signal?: AbortSignal
}

export interface NgspiceExecutionResult {
  exit_code: number
  stdout: string
  stderr: string
  cancelled: boolean
}

export type NgspiceExecutor = (request: NgspiceExecutionRequest) => Promise<NgspiceExecutionResult>

function appendOutputTail(current: string, chunk: string): string {
  const next = `${current}${chunk}`
  return next.length <= 200_000 ? next : next.slice(-200_000)
}

/** Runs ngspice through the shared detached process-group supervisor. */
export const executeLocalNgspice: NgspiceExecutor = async (request) => {
  const signal = request.signal ?? new AbortController().signal
  let stdout = ""
  let stderr = ""
  try {
    const result = await new BunProcessRunner().run({
      command: [request.executable, "-b", "-r", request.raw_path, request.circuit_path],
      command_label: "ngspice validation",
      cwd: request.cwd,
      signal,
      idle_timeout_ms: 30_000,
      wall_timeout_ms: 120_000,
      heartbeat_paths: [request.raw_path],
      max_output_chars: 200_000,
      on_output: (stream, message) => {
        if (stream === "stdout") stdout = appendOutputTail(stdout, message)
        else stderr = appendOutputTail(stderr, message)
      },
    })
    return { exit_code: result.exit_code, stdout, stderr, cancelled: false }
  } catch (error) {
    if (!(error instanceof ProcessError)) throw error
    if (
      error.code === "process_spawn_failed" ||
      error.code === "process_output_handler_failed" ||
      error.code === "process_idle_timeout" ||
      error.code === "process_wall_timeout"
    ) {
      throw error
    }
    const detail = error.output_tail ? `\n${error.output_tail}` : ""
    stderr = appendOutputTail(stderr, `${error.message}${detail}`)
    return {
      exit_code: error.exit_code ?? -1,
      stdout,
      stderr,
      cancelled: error.code === "process_cancelled" || signal.aborted,
    }
  }
}
