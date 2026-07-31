import { stat } from "node:fs/promises"
import type { JobLogStream } from "@/shared/job-types"
import { ProcessError } from "./process-error"

export interface ProcessRunRequest {
  command: readonly string[]
  command_label: string
  cwd: string
  signal: AbortSignal
  env?: Record<string, string | undefined>
  idle_timeout_ms?: number
  wall_timeout_ms?: number
  heartbeat_paths?: readonly string[]
  max_output_chars?: number
  /** Keep false only for nested commands that must remain in an already-supervised parent process group. */
  detached?: boolean
  on_output?: (stream: Extract<JobLogStream, "stdout" | "stderr">, message: string) => void | Promise<void>
}

export interface ProcessRunResult {
  exit_code: number
  duration_ms: number
  output_tail: string
}

export interface ProcessRunner {
  run(request: ProcessRunRequest): Promise<ProcessRunResult>
}

class OutputHandlerFailure extends Error {
  constructor(cause: unknown) {
    super("The process output handler failed", { cause })
    this.name = "OutputHandlerFailure"
  }
}

const DEFAULT_OUTPUT_CHARS = 200_000
const MAX_OUTPUT_CHARS = 1_000_000

function normalizeOutputLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_OUTPUT_CHARS
  if (!Number.isFinite(value)) return DEFAULT_OUTPUT_CHARS
  return Math.max(1_000, Math.min(MAX_OUTPUT_CHARS, Math.floor(value)))
}

function appendTail(current: string, chunk: string, limit: number): string {
  const next = `${current}${chunk}`
  return next.length <= limit ? next : next.slice(-limit)
}

async function heartbeatSignature(paths: readonly string[]): Promise<string> {
  const entries = await Promise.all(
    paths.map(async (path) => {
      const metadata = await stat(path).catch(() => undefined)
      return metadata ? `${path}:${metadata.mtimeMs}:${metadata.size}` : `${path}:missing`
    }),
  )
  return entries.join("\n")
}

function signalProcess(child: Bun.Subprocess, signal: NodeJS.Signals, detached: boolean): void {
  if (child.exitCode !== null) return
  try {
    if (detached && process.platform !== "win32") process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    try {
      if (child.exitCode === null) child.kill(signal)
    } catch {
      // The process may have exited between checks.
    }
  }
}

async function settleProcessTasks(tasks: readonly Promise<unknown>[], timeout_ms = 2_000): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeout_ms)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function readStream(input: {
  readable: ReadableStream<Uint8Array>
  stream: "stdout" | "stderr"
  on_chunk: (stream: "stdout" | "stderr", message: string) => Promise<void>
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
    const remainder = decoder.decode()
    if (remainder) await input.on_chunk(input.stream, remainder)
  } finally {
    reader.releaseLock()
  }
}

export class BunProcessRunner implements ProcessRunner {
  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    if (request.command.length === 0) {
      throw new ProcessError({
        code: "process_spawn_failed",
        command_label: request.command_label,
        message: `${request.command_label} has no executable`,
      })
    }
    if (request.signal.aborted) {
      throw new ProcessError({
        code: "process_cancelled",
        command_label: request.command_label,
        message: `${request.command_label} was cancelled before it started`,
      })
    }

    const started_at = performance.now()
    const output_limit = normalizeOutputLimit(request.max_output_chars)
    let output_tail = ""
    let last_activity_at = Date.now()
    let last_heartbeat: string | undefined
    let termination: "cancelled" | "idle_timeout" | "wall_timeout" | undefined
    let is_settled = false
    let idle_check_running = false
    let force_kill_timer: ReturnType<typeof setTimeout> | undefined
    let idle_timer: ReturnType<typeof setInterval> | undefined
    let wall_timer: ReturnType<typeof setTimeout> | undefined
    let child: Bun.Subprocess
    let release_termination: (() => void) | undefined
    const detached = request.detached ?? true
    const termination_started = new Promise<void>((resolve) => {
      release_termination = resolve
    })

    try {
      child = Bun.spawn([...request.command], {
        cwd: request.cwd,
        detached,
        env: { ...process.env, ...request.env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
    } catch (error) {
      throw new ProcessError({
        code: "process_spawn_failed",
        command_label: request.command_label,
        message: `${request.command_label} could not start`,
        cause: error,
      })
    }

    const terminate = (reason: "cancelled" | "idle_timeout" | "wall_timeout") => {
      if (termination || is_settled) return
      termination = reason
      release_termination?.()
      signalProcess(child, "SIGTERM", detached)
      force_kill_timer = setTimeout(() => signalProcess(child, "SIGKILL", detached), 2_000)
    }
    const on_abort = () => terminate("cancelled")
    request.signal.addEventListener("abort", on_abort, { once: true })
    // Close the check/listener race if cancellation happened after spawning.
    if (request.signal.aborted) terminate("cancelled")

    const wall_timeout_ms = request.wall_timeout_ms ?? 30 * 60_000
    if (wall_timeout_ms > 0) {
      wall_timer = setTimeout(() => terminate("wall_timeout"), wall_timeout_ms)
    }

    if (request.idle_timeout_ms && request.idle_timeout_ms > 0) {
      const interval_ms = Math.max(100, Math.min(1_000, Math.floor(request.idle_timeout_ms / 4)))
      idle_timer = setInterval(() => {
        if (idle_check_running || is_settled) return
        idle_check_running = true
        void (async () => {
          try {
            const heartbeat_paths = request.heartbeat_paths ?? []
            const signature = await heartbeatSignature(heartbeat_paths)
            if (is_settled) return
            if (last_heartbeat === undefined) {
              last_heartbeat = signature
              if (heartbeat_paths.length > 0) last_activity_at = Date.now()
            } else if (signature !== last_heartbeat) {
              last_heartbeat = signature
              last_activity_at = Date.now()
            }
            if (Date.now() - last_activity_at >= request.idle_timeout_ms! && child.exitCode === null) {
              terminate("idle_timeout")
            }
          } finally {
            idle_check_running = false
          }
        })()
      }, interval_ms)
    }

    const on_chunk = async (stream: "stdout" | "stderr", message: string) => {
      last_activity_at = Date.now()
      output_tail = appendTail(output_tail, message, output_limit)
      if (!request.on_output || termination || is_settled) return
      const output_task = Promise.resolve()
        .then(() => request.on_output?.(stream, message))
        .catch((error) => {
          throw new OutputHandlerFailure(error)
        })
      await Promise.race([output_task, termination_started])
    }

    const exit_task = child.exited
    const stdout_task = readStream({
      readable: child.stdout as ReadableStream<Uint8Array>,
      stream: "stdout",
      on_chunk,
    })
    const stderr_task = readStream({
      readable: child.stderr as ReadableStream<Uint8Array>,
      stream: "stderr",
      on_chunk,
    })
    const process_tasks = [exit_task, stdout_task, stderr_task] as const

    try {
      const [exit_code] = await Promise.all(process_tasks)
      const duration_ms = Math.round(performance.now() - started_at)
      if (termination === "cancelled" || request.signal.aborted) {
        throw new ProcessError({
          code: "process_cancelled",
          command_label: request.command_label,
          message: `${request.command_label} was cancelled`,
          exit_code,
          output_tail,
        })
      }
      if (termination === "idle_timeout") {
        throw new ProcessError({
          code: "process_idle_timeout",
          command_label: request.command_label,
          message: `${request.command_label} produced no output or heartbeat before its idle timeout`,
          exit_code,
          output_tail,
        })
      }
      if (termination === "wall_timeout") {
        throw new ProcessError({
          code: "process_wall_timeout",
          command_label: request.command_label,
          message: `${request.command_label} exceeded its absolute time limit`,
          exit_code,
          output_tail,
        })
      }
      if (exit_code !== 0) {
        throw new ProcessError({
          code: "process_exit_failed",
          command_label: request.command_label,
          message: `${request.command_label} exited with code ${exit_code}`,
          exit_code,
          output_tail,
        })
      }
      return { exit_code, duration_ms, output_tail }
    } catch (error) {
      if (error instanceof ProcessError) throw error
      const failure_termination = termination ?? (request.signal.aborted ? "cancelled" : undefined)
      is_settled = true
      release_termination?.()
      release_termination = undefined
      signalProcess(child, "SIGKILL", detached)
      await settleProcessTasks(process_tasks)
      const exit_code = child.exitCode ?? undefined
      if (failure_termination === "cancelled") {
        throw new ProcessError({
          code: "process_cancelled",
          command_label: request.command_label,
          message: `${request.command_label} was cancelled`,
          exit_code,
          output_tail,
        })
      }
      if (failure_termination === "idle_timeout") {
        throw new ProcessError({
          code: "process_idle_timeout",
          command_label: request.command_label,
          message: `${request.command_label} produced no output or heartbeat before its idle timeout`,
          exit_code,
          output_tail,
        })
      }
      if (failure_termination === "wall_timeout") {
        throw new ProcessError({
          code: "process_wall_timeout",
          command_label: request.command_label,
          message: `${request.command_label} exceeded its absolute time limit`,
          exit_code,
          output_tail,
        })
      }
      if (error instanceof OutputHandlerFailure) {
        throw new ProcessError({
          code: "process_output_handler_failed",
          command_label: request.command_label,
          message: `${request.command_label} could not persist or deliver process output`,
          output_tail,
          cause: error.cause,
        })
      }
      throw new ProcessError({
        code: "process_exit_failed",
        command_label: request.command_label,
        message: `${request.command_label} failed while streaming process output`,
        output_tail,
        cause: error,
      })
    } finally {
      is_settled = true
      request.signal.removeEventListener("abort", on_abort)
      if (idle_timer) clearInterval(idle_timer)
      if (wall_timer) clearTimeout(wall_timer)
      if (force_kill_timer) clearTimeout(force_kill_timer)
    }
  }
}
