import { appendFile, cp, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseTrustedAgentEvent, type TrustedAgentEvent } from "../agent-event-protocol"
import {
  captureAgentProcessOutput,
  isTransientAgentTransportFailure,
  summarizeAgentProcessFailure,
} from "../agent-tools/agent-transport-failure"
import { repositoryRoot } from "../paths/repository-paths"
import { renderTrustedAgentEvent } from "./render-trusted-agent-event"
import {
  AgentTransportUnavailableError,
  AutomatedConversionUnavailableError,
  type JobRunnerContext,
  type StreamProcessInput,
  streamProcess,
  throwIfCancelled,
} from "./stream-job-process"

function boundedInteger(value: number, fallback: number, minimum: number, maximum: number): number {
  return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback
}

async function waitForTransportRetry(delay_ms: number, signal: AbortSignal): Promise<void> {
  throwIfCancelled(signal)
  await new Promise<void>((resolve_wait) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (timer) clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve_wait()
    }
    timer = setTimeout(finish, delay_ms)
    signal.addEventListener("abort", finish, { once: true })
  })
  throwIfCancelled(signal)
}

export async function runStructuredAgentPhase(input: {
  context: JobRunnerContext
  prompt: string
  cwd: string
  signal: AbortSignal
  append: StreamProcessInput["on_chunk"]
  event_log_file?: string
  event_publish_file?: string
  event_phase?: string
}): Promise<TrustedAgentEvent[]> {
  let events: TrustedAgentEvent[] = []
  let stdout_buffer = ""
  let invalid_stdout = false
  let last_sequence = 0
  let thinking_buffer = ""

  const flushThinking = async (): Promise<void> => {
    if (!thinking_buffer) return
    const buffered = thinking_buffer
    thinking_buffer = ""
    await input.append("stderr", buffered)
  }

  const consume_line = async (line: string): Promise<void> => {
    if (!line.trim()) return
    const event = parseTrustedAgentEvent(line)
    if (!event || event.sequence !== last_sequence + 1) {
      invalid_stdout = true
      await input.append("stdout", `${line}\n`)
      return
    }
    last_sequence = event.sequence
    events.push(event)
    if (input.event_log_file) {
      await appendFile(
        input.event_log_file,
        `${JSON.stringify({
          recorded_at: new Date().toISOString(),
          phase: input.event_phase ?? "agent",
          event,
        })}\n`,
        "utf8",
      )
    }
    if (event.type === "thinking_delta") {
      thinking_buffer += event.text
      return
    }
    await flushThinking()
    await renderTrustedAgentEvent(event, input.append)
  }

  const command_prefix = input.context.agent_event_runner
    ? [process.execPath, input.context.agent_event_runner]
    : [input.context.agent_bin]
  const configured_retry_limit =
    input.context.agent_transport_retry_limit ?? Number(process.env.JOB_AGENT_TRANSPORT_RETRIES ?? 5)
  const transport_retry_limit = boundedInteger(configured_retry_limit, 5, 0, 6)
  const configured_base_delay =
    input.context.agent_transport_retry_base_delay_ms ??
    Number(process.env.JOB_AGENT_TRANSPORT_RETRY_BASE_DELAY_MS ?? 2_000)
  const transport_retry_base_delay_ms = boundedInteger(configured_base_delay, 2_000, 0, 30_000)
  const restore_image_runtime = await prepareAgentImageRuntime(input.cwd)
  try {
    let transport_retry = 0
    while (true) {
      events = []
      stdout_buffer = ""
      invalid_stdout = false
      last_sequence = 0
      thinking_buffer = ""
      let process_output = ""
      const exit_code = await streamProcess({
        command: [
          ...command_prefix,
          "do",
          ...(input.context.use_openai ? ["--use-openai"] : []),
          "--prompt",
          input.prompt,
          "--dir",
          input.cwd,
        ],
        cwd: input.cwd,
        signal: input.signal,
        on_chunk: async (stream, message) => {
          process_output = captureAgentProcessOutput(process_output, message)
          if (stream === "stderr") {
            await input.append(stream, message)
            return
          }
          stdout_buffer += message
          const lines = stdout_buffer.split(/\r?\n/)
          stdout_buffer = lines.pop() ?? ""
          for (const line of lines) await consume_line(line)
        },
      })
      if (stdout_buffer) await consume_line(stdout_buffer)
      await flushThinking()

      const agent_end = [...events].reverse().find((event) => event.type === "agent_end")
      const attempt_error =
        exit_code !== 0
          ? new Error(
              `tsci-agent exited with code ${exit_code}${
                summarizeAgentProcessFailure(process_output)
                  ? `: ${summarizeAgentProcessFailure(process_output)}`
                  : ""
              }`,
            )
          : invalid_stdout || events.length === 0
            ? new Error("tsci-agent did not provide a valid structured event stream")
            : !agent_end || agent_end.failed
              ? new Error("tsci-agent did not complete successfully")
              : undefined
      if (!attempt_error) {
        const image_reads = events.filter((event) => event.type === "tool_end" && event.tool_name === "read")
        const successful_image_reads = image_reads.filter(
          (event) => event.type === "tool_end" && event.result_has_image,
        ).length
        await input.append(
          "system",
          `Agent phase completed with ${successful_image_reads}/${image_reads.length} read result(s) containing pixels.\n`,
        )
        return events
      }

      if (!isTransientAgentTransportFailure(process_output)) throw attempt_error
      if (transport_retry >= transport_retry_limit) {
        const detail = summarizeAgentProcessFailure(process_output) ?? attempt_error.message
        throw new AgentTransportUnavailableError(
          `Agent transport remained unavailable after ${transport_retry + 1} connection attempt(s): ${detail}`,
        )
      }

      transport_retry += 1
      const delay_ms = Math.min(30_000, transport_retry_base_delay_ms * 2 ** (transport_retry - 1))
      await input.append(
        "system",
        `Agent transport was unavailable; preserving the current workspace and retrying the same phase in ${Math.ceil(delay_ms / 1_000)} second(s) (${transport_retry}/${transport_retry_limit})…\n`,
      )
      await waitForTransportRetry(delay_ms, input.signal)
    }
  } finally {
    try {
      await restore_image_runtime()
    } finally {
      if (input.event_log_file && input.event_publish_file) {
        await cp(input.event_log_file, input.event_publish_file).catch(() => undefined)
      }
    }
  }
}

const PHOTON_WASM_FILE = "photon_rs_bg.wasm"

const IMAGE_CANARY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
)

let image_runtime_canary: Promise<void> | undefined

async function assertImageRuntimeCanary(): Promise<void> {
  image_runtime_canary ??= import("@silvia-odwyer/photon-node").then((photon) => {
    const image = photon.PhotonImage.new_from_byteslice(IMAGE_CANARY_PNG)
    try {
      if (image.get_width() !== 1 || image.get_height() !== 1) {
        throw new Error("image canary decoded with unexpected dimensions")
      }
    } finally {
      image.free()
    }
  })
  await image_runtime_canary
}

async function prepareAgentImageRuntime(cwd: string): Promise<() => Promise<void>> {
  await assertImageRuntimeCanary().catch((error) => {
    const detail = error instanceof Error ? error.message : String(error)
    throw new AutomatedConversionUnavailableError(
      `The image-processing runtime failed its startup canary: ${detail}`,
    )
  })
  const source_path = resolve(
    repositoryRoot,
    "node_modules",
    "@silvia-odwyer",
    "photon-node",
    PHOTON_WASM_FILE,
  )
  const source = await readFile(source_path).catch(() => undefined)
  if (
    !source ||
    source.length < 8 ||
    source[0] !== 0 ||
    source[1] !== 97 ||
    source[2] !== 115 ||
    source[3] !== 109
  ) {
    throw new AutomatedConversionUnavailableError(
      "The image-processing runtime is unavailable. Reinstall dependencies before retrying.",
    )
  }
  const target_path = join(cwd, PHOTON_WASM_FILE)
  const previous = await readFile(target_path).catch(() => undefined)
  await Bun.write(target_path, source)
  return async () => {
    if (previous) await Bun.write(target_path, previous)
    else await rm(target_path, { force: true })
  }
}
