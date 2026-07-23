import { readdirSync, readFileSync } from "node:fs"
import { stat } from "node:fs/promises"
import { delimiter, dirname } from "node:path"
import type { JobLogStream } from "@/shared/job-types"
import type { JobStore } from "../job-store"
import type { ModelRunStore } from "../model-run-store"

export interface ModelRunnerContext {
  job_store: JobStore
  model_run_store: ModelRunStore
  agent_bin: string
  tsci_bin: string
  use_openai?: boolean
}

export interface StreamModelProcessInput {
  command: string[]
  cwd: string
  signal: AbortSignal
  on_chunk: (stream: JobLogStream, message: string) => Promise<void>
  activity_paths?: string[]
  workspace_root?: string
}

export class ModelProcessStaleError extends Error {
  constructor() {
    super("The model run timed out after producing no output.")
    this.name = "ModelProcessStaleError"
  }
}

export class ModelInfrastructureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelInfrastructureError"
  }
}

export class ModelWorkspaceIsolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelWorkspaceIsolationError"
  }
}

const DEFAULT_MODEL_STALE_TIMEOUT_MS = 10 * 60_000

function listDescendantPids(root_pid: number): number[] {
  if (process.platform === "win32") return []
  const children = new Map<number, number[]>()
  const process_pairs: Array<[number, number]> = []
  if (process.platform === "linux") {
    const entries = (() => {
      try {
        return readdirSync("/proc", { withFileTypes: true, encoding: "utf8" })
      } catch {
        return []
      }
    })()
    if (entries.length === 0) return []
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
      try {
        const pid = Number(entry.name)
        const stat_text = readFileSync(`/proc/${entry.name}/stat`, "utf8")
        const closing_parenthesis = stat_text.lastIndexOf(")")
        if (closing_parenthesis < 0) continue
        const fields = stat_text
          .slice(closing_parenthesis + 2)
          .trim()
          .split(/\s+/)
        const parent_pid = Number(fields[1])
        if (Number.isInteger(parent_pid)) process_pairs.push([pid, parent_pid])
      } catch {
        // Processes can exit while /proc is being scanned.
      }
    }
  } else {
    let result: ReturnType<typeof Bun.spawnSync>
    try {
      result = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], {
        stdout: "pipe",
        stderr: "ignore",
      })
    } catch {
      return []
    }
    if (result.exitCode !== 0) return []
    for (const line of new TextDecoder().decode(result.stdout).split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/)
      if (match) process_pairs.push([Number(match[1]), Number(match[2])])
    }
  }
  for (const [pid, parent_pid] of process_pairs) {
    children.set(parent_pid, [...(children.get(parent_pid) ?? []), pid])
  }
  const descendants: number[] = []
  const pending = [...(children.get(root_pid) ?? [])]
  while (pending.length > 0) {
    const pid = pending.pop()!
    descendants.push(pid)
    pending.push(...(children.get(pid) ?? []))
  }
  return descendants
}

function killPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // The process may already have exited.
  }
}

function killProcessTree(
  child_process: Bun.Subprocess,
  signal: NodeJS.Signals,
  known_descendants: Set<number>,
): void {
  for (const pid of listDescendantPids(child_process.pid)) known_descendants.add(pid)
  for (const pid of [...known_descendants].reverse()) killPid(pid, signal)
  try {
    if (process.platform === "win32") child_process.kill(signal)
    else process.kill(-child_process.pid, signal)
  } catch {
    if (child_process.exitCode === null) child_process.kill(signal)
  }
}

function getRuntimeJobId(path: string): string | undefined {
  return path.replace(/\\/g, "/").match(/(?:^|\/)\.runtime\/jobs\/([^/]+)(?:\/|$)/)?.[1]
}

function createWorkspaceAudit(workspace_root?: string) {
  const current_job_id = workspace_root ? getRuntimeJobId(workspace_root) : undefined
  const buffers: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" }
  const inspectLine = (line: string): void => {
    if (!current_job_id || !line.includes("[tool]") || !line.includes(".runtime/jobs")) return
    const references = [...line.replace(/\\/g, "/").matchAll(/\.runtime\/jobs(?:\/([^/\s"'\\}]+))?/g)]
    for (const reference of references) {
      const referenced_job_id = reference[1]
      if (!referenced_job_id || referenced_job_id !== current_job_id) {
        throw new ModelWorkspaceIsolationError(
          `Agent workspace isolation violation: a tool attempted to access ${
            referenced_job_id ? `sibling job ${referenced_job_id}` : "the shared .runtime/jobs directory"
          }`,
        )
      }
    }
  }
  return {
    push(stream: "stdout" | "stderr", message: string): void {
      const lines = `${buffers[stream]}${message}`.split(/\r?\n/)
      buffers[stream] = lines.pop() ?? ""
      for (const line of lines) inspectLine(line)
    },
    flush(): void {
      inspectLine(buffers.stdout)
      inspectLine(buffers.stderr)
    },
  }
}

async function getActivitySignatures(paths: string[]): Promise<string[]> {
  return Promise.all(
    paths.map(async (path) => {
      const metadata = await stat(path).catch(() => undefined)
      return metadata ? `${metadata.mtimeMs}:${metadata.size}` : "missing"
    }),
  )
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

export async function streamModelProcess(input: StreamModelProcessInput): Promise<number> {
  if (input.signal.aborted) return 143
  const activity_paths = input.activity_paths ?? []
  let activity_signatures = await getActivitySignatures(activity_paths)
  const inherited_path = process.env.PATH ?? ""
  const command_path = input.command[0]?.includes("/")
    ? `${dirname(input.command[0])}${delimiter}${inherited_path}`
    : inherited_path
  const child_process = Bun.spawn(input.command, {
    cwd: input.cwd,
    detached: true,
    // Docker runs the server in production mode, but tscircuit's source evaluator emits
    // development-runtime jsxDEV calls. Every model subprocess, including benchmark structural
    // builds, must use the same matching JSX runtime as component/application subprocesses.
    env: { ...process.env, NODE_ENV: "development", PATH: command_path },
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
  let stopping = false
  let completed = false
  let stale_timer: ReturnType<typeof setTimeout> | undefined
  let force_kill_timer: ReturnType<typeof setTimeout> | undefined
  const known_descendants = new Set<number>()
  const stop_process = () => {
    if (stopping) return
    stopping = true
    killProcessTree(child_process, "SIGTERM", known_descendants)
    force_kill_timer = setTimeout(() => killProcessTree(child_process, "SIGKILL", known_descendants), 2_000)
  }
  const arm_stale_timer = () => {
    if (stale_timer) clearTimeout(stale_timer)
    stale_timer = setTimeout(() => {
      void (async () => {
        const signatures = await getActivitySignatures(activity_paths)
        if (completed) return
        if (JSON.stringify(signatures) !== JSON.stringify(activity_signatures)) {
          activity_signatures = signatures
          arm_stale_timer()
          return
        }
        stale = true
        stop_process()
      })()
    }, stale_timeout_ms)
  }
  const auditWorkspace = createWorkspaceAudit(input.workspace_root)
  const on_chunk: StreamModelProcessInput["on_chunk"] = async (stream, message) => {
    arm_stale_timer()
    if (stream === "stdout" || stream === "stderr") auditWorkspace.push(stream, message)
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
    auditWorkspace.flush()
    if (stale) throw new ModelProcessStaleError()
    return exit_code
  } catch (error) {
    stop_process()
    await child_process.exited.catch(() => undefined)
    throw error
  } finally {
    completed = true
    input.signal.removeEventListener("abort", stop_process)
    if (stopping) killProcessTree(child_process, "SIGKILL", known_descendants)
    if (force_kill_timer) clearTimeout(force_kill_timer)
    if (stale_timer) clearTimeout(stale_timer)
  }
}
