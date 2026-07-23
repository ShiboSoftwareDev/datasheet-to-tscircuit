import { delimiter, dirname } from "node:path"
import type { JobLogStream } from "@/shared/job-types"
import type { JobStore } from "../job-store"

export interface JobRunnerContext {
  job_store: JobStore
  agent_bin: string
  agent_event_runner?: string
  tsci_bin: string
  use_openai?: boolean
  agent_transport_retry_limit?: number
  agent_transport_retry_base_delay_ms?: number
}

export interface StreamProcessInput {
  command: string[]
  cwd: string
  signal: AbortSignal
  on_chunk: (stream: JobLogStream, message: string) => Promise<void>
}

export class JobCancelledError extends Error {
  constructor() {
    super("Job cancellation was requested")
    this.name = "JobCancelledError"
  }
}

export class AutomatedConversionUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AutomatedConversionUnavailableError"
  }
}

export class AgentTransportUnavailableError extends AutomatedConversionUnavailableError {
  constructor(message: string) {
    super(message)
    this.name = "AgentTransportUnavailableError"
  }
}

export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new JobCancelledError()
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
  on_chunk: StreamProcessInput["on_chunk"]
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

export async function streamProcess(input: StreamProcessInput): Promise<number> {
  throwIfCancelled(input.signal)
  const inherited_path = process.env.PATH ?? ""
  const command_path = input.command[0]?.includes("/")
    ? `${dirname(input.command[0])}${delimiter}${inherited_path}`
    : inherited_path
  const child_process = Bun.spawn(input.command, {
    cwd: input.cwd,
    detached: true,
    // The production server environment selects React's production JSX runtime, while tsci's
    // source evaluator emits jsxDEV calls. Keep job toolchains on the matching development
    // runtime without changing the server's own production mode.
    env: { ...process.env, NODE_ENV: "development", PATH: command_path },
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
    throwIfCancelled(input.signal)
    return exit_code
  } finally {
    input.signal.removeEventListener("abort", stop_process)
    if (force_kill_timer) clearTimeout(force_kill_timer)
  }
}
