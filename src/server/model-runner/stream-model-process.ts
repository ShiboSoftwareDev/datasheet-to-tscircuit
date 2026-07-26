import { readdirSync, readFileSync, readlinkSync } from "node:fs"
import { stat } from "node:fs/promises"
import { delimiter, dirname, parse, resolve, sep } from "node:path"
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
  cleanup_workspace_processes?: boolean
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

export class ModelPreparationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelPreparationError"
  }
}

export class ModelWorkspaceIsolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelWorkspaceIsolationError"
  }
}

const DEFAULT_MODEL_STALE_TIMEOUT_MS = 10 * 60_000
const DESCENDANT_INITIAL_SAMPLE_WINDOW_MS = 1_000
const DESCENDANT_INITIAL_SAMPLE_INTERVAL_MS = 10
const DESCENDANT_STEADY_SAMPLE_INTERVAL_MS = 500
const DESCENDANT_OUTPUT_SAMPLE_INTERVAL_MS = 100

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

function listWorkspacePids(workspace_directory: string): number[] {
  if (process.platform !== "linux") return []
  const workspace_path = resolve(workspace_directory)
  if (workspace_path === parse(workspace_path).root) return []
  const pids: number[] = []
  const entries = (() => {
    try {
      return readdirSync("/proc", { withFileTypes: true, encoding: "utf8" })
    } catch {
      return []
    }
  })()
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue
    const pid = Number(entry.name)
    if (pid === process.pid) continue
    try {
      const cwd = resolve(readlinkSync(`/proc/${entry.name}/cwd`).replace(/ \(deleted\)$/, ""))
      if (cwd === workspace_path || cwd.startsWith(`${workspace_path}${sep}`)) pids.push(pid)
    } catch {
      // Processes can exit or change working directory while /proc is scanned.
    }
  }
  return pids
}

function killProcessTree(
  child_process: Bun.Subprocess,
  signal: NodeJS.Signals,
  known_descendants: Set<number>,
  workspace_directory?: string,
): void {
  for (const pid of listDescendantPids(child_process.pid)) known_descendants.add(pid)
  // A detached helper is reparented as soon as the CLI exits and then disappears
  // from the root PID's process tree. Every model command runs in an isolated
  // workspace, so its cwd provides a stable way to find those surviving helpers.
  if (workspace_directory) {
    for (const pid of listWorkspacePids(workspace_directory)) known_descendants.add(pid)
  }
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
  stop_after_exit: Promise<void>
}): Promise<void> {
  const reader = input.readable.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const next = await Promise.race([
        reader.read().then((chunk) => ({ kind: "chunk" as const, chunk })),
        input.stop_after_exit.then(() => ({ kind: "stop" as const })),
      ])
      if (next.kind === "stop") {
        await reader.cancel().catch(() => undefined)
        break
      }
      const { chunk } = next
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
  let has_observed_activity = activity_signatures.some((signature) => signature !== "missing")
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
  // Capture Bun's exit promise once. Re-reading the `exited` getter from
  // concurrent drain, retry, and cleanup paths can register multiple native
  // waiters for the same short-lived process under load.
  const process_exited = child_process.exited

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
  let descendant_sample_timer: ReturnType<typeof setTimeout> | undefined
  let stream_drain_timer: ReturnType<typeof setTimeout> | undefined
  let stop_stream_readers: (() => void) | undefined
  const stop_after_exit = new Promise<void>((resolve) => {
    stop_stream_readers = resolve
  })
  const known_descendants = new Set<number>()
  const descendant_sampling_started_at = Date.now()
  let last_descendant_sample_at = 0
  const captureDescendants = (): void => {
    last_descendant_sample_at = Date.now()
    const descendants = listDescendantPids(child_process.pid)
    if (descendants.length > 0) {
      known_descendants.clear()
      for (const pid of descendants) known_descendants.add(pid)
    }
  }
  const sampleDescendants = () => {
    descendant_sample_timer = undefined
    captureDescendants()
    if (!completed && input.cleanup_workspace_processes) {
      const elapsed_ms = Date.now() - descendant_sampling_started_at
      descendant_sample_timer = setTimeout(
        sampleDescendants,
        input.cleanup_workspace_processes && elapsed_ms < DESCENDANT_INITIAL_SAMPLE_WINDOW_MS
          ? DESCENDANT_INITIAL_SAMPLE_INTERVAL_MS
          : DESCENDANT_STEADY_SAMPLE_INTERVAL_MS,
      )
    }
  }
  const stop_process = () => {
    if (stopping) return
    stopping = true
    const cleanup_workspace = input.cleanup_workspace_processes ? input.cwd : undefined
    killProcessTree(child_process, "SIGTERM", known_descendants, cleanup_workspace)
    force_kill_timer = setTimeout(
      () => killProcessTree(child_process, "SIGKILL", known_descendants, cleanup_workspace),
      2_000,
    )
  }
  const arm_stale_timer = () => {
    if (stale_timer) clearTimeout(stale_timer)
    stale_timer = setTimeout(() => {
      void (async () => {
        const signatures = await getActivitySignatures(activity_paths)
        if (completed) return
        if (JSON.stringify(signatures) !== JSON.stringify(activity_signatures)) {
          activity_signatures = signatures
          has_observed_activity = true
          arm_stale_timer()
          return
        }
        if (activity_paths.length > 0 && !has_observed_activity) {
          // A newly spawned agent can take most of one timeout interval to load
          // under CPU pressure. Give its declared heartbeat file one full startup
          // grace interval before calling a completely silent process stale.
          has_observed_activity = true
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
    // Keep a live snapshot of descendants while the root PID still exists.
    // Detached helpers are reparented as soon as the CLI exits, at which point
    // they can no longer be discovered from the root process tree.
    if (Date.now() - last_descendant_sample_at >= DESCENDANT_OUTPUT_SAMPLE_INTERVAL_MS) {
      captureDescendants()
    }
    if (stream === "stdout" || stream === "stderr") auditWorkspace.push(stream, message)
    await input.on_chunk(stream, message)
  }
  arm_stale_timer()
  if (input.cleanup_workspace_processes) {
    descendant_sample_timer = setTimeout(sampleDescendants, DESCENDANT_INITIAL_SAMPLE_INTERVAL_MS)
  }
  input.signal.addEventListener("abort", stop_process, { once: true })
  void process_exited.then(() => {
    // Bun can occasionally leave a detached child's pipe readable open after
    // reporting process exit, especially when several short builds finish
    // together. Give buffered output a bounded drain window, then release the
    // readers so a completed validation worker cannot hang the whole pool.
    stream_drain_timer = setTimeout(() => stop_stream_readers?.(), 250)
  })

  try {
    const [exit_code] = await Promise.all([
      process_exited,
      readProcessStream({
        readable: child_process.stdout,
        stream: "stdout",
        on_chunk,
        stop_after_exit,
      }),
      readProcessStream({
        readable: child_process.stderr,
        stream: "stderr",
        on_chunk,
        stop_after_exit,
      }),
    ])
    auditWorkspace.flush()
    if (stale) throw new ModelProcessStaleError()
    return exit_code
  } catch (error) {
    stop_process()
    await process_exited.catch(() => undefined)
    throw error
  } finally {
    completed = true
    stop_stream_readers?.()
    input.signal.removeEventListener("abort", stop_process)
    // A successful CLI parent exit is not proof that every tool process it
    // launched has exited. Kill the now-orphaned process group before another
    // model phase can lock or consume the workspace. This prevents a late setup
    // writer from regenerating evidence after the server snapshot is created.
    killProcessTree(
      child_process,
      "SIGKILL",
      known_descendants,
      input.cleanup_workspace_processes ? input.cwd : undefined,
    )
    if (descendant_sample_timer) clearTimeout(descendant_sample_timer)
    if (stream_drain_timer) clearTimeout(stream_drain_timer)
    if (force_kill_timer) clearTimeout(force_kill_timer)
    if (stale_timer) clearTimeout(stale_timer)
  }
}
