import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { JobLogStream } from "@/shared/job-types"
import {
  captureAgentProcessOutput,
  isTransientAgentTransportFailure,
} from "../agent-tools/agent-transport-failure"
import { streamModelProcess } from "./stream-model-process"

const IMAGE_READ_MARKER = "[datasheet-model-image-read]"
const MODEL_AGENT_READ_EXTENSION = fileURLToPath(new URL("./model-agent-read-extension.ts", import.meta.url))

export interface ModelAgentImageReadSummary {
  attempted: number
  successful: number
  failures: Array<{ path: string; reason?: string }>
}

function boundedInteger(value: number, fallback: number, minimum: number, maximum: number): number {
  return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback
}

async function waitForRetry(delay_ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || delay_ms <= 0) return
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (timer) clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    timer = setTimeout(finish, delay_ms)
    signal.addEventListener("abort", finish, { once: true })
  })
}

export async function runModelAgentProcess(input: {
  agent_bin: string
  use_openai: boolean
  prompt: string
  model_dir: string
  signal: AbortSignal
  append: (stream: JobLogStream, message: string) => Promise<void>
  phase_label: string
  transport_retry_limit?: number
  transport_retry_base_delay_ms?: number
}): Promise<{
  exit_code: number
  process_output: string
  image_reads: ModelAgentImageReadSummary
}> {
  const configured_retry_limit =
    input.transport_retry_limit ?? Number(process.env.MODEL_AGENT_TRANSPORT_RETRIES ?? 5)
  const retry_limit = boundedInteger(configured_retry_limit, 5, 0, 6)
  const configured_base_delay =
    input.transport_retry_base_delay_ms ??
    Number(process.env.MODEL_AGENT_TRANSPORT_RETRY_BASE_DELAY_MS ?? 2_000)
  const base_delay_ms = boundedInteger(configured_base_delay, 2_000, 0, 30_000)
  const image_reads: ModelAgentImageReadSummary = {
    attempted: 0,
    successful: 0,
    failures: [],
  }
  let image_read_buffer = ""
  const consumeImageReadEvents = (message: string, flush = false): void => {
    const lines = `${image_read_buffer}${message}`.split(/\r?\n/)
    image_read_buffer = flush ? "" : (lines.pop() ?? "")
    for (const line of lines) {
      const marker_index = line.indexOf(IMAGE_READ_MARKER)
      if (marker_index < 0) continue
      try {
        const event = JSON.parse(line.slice(marker_index + IMAGE_READ_MARKER.length)) as {
          path?: unknown
          has_image?: unknown
          reason?: unknown
        }
        if (typeof event.path !== "string" || typeof event.has_image !== "boolean") continue
        image_reads.attempted += 1
        if (event.has_image) image_reads.successful += 1
        else {
          image_reads.failures.push({
            path: event.path,
            reason: typeof event.reason === "string" ? event.reason : undefined,
          })
        }
      } catch {
        // A malformed observer line is retained in the normal process log.
      }
    }
  }

  for (let retry = 0; ; retry += 1) {
    let process_output = ""
    const exit_code = await streamModelProcess({
      command: [
        input.agent_bin,
        "do",
        ...(input.use_openai ? ["--use-openai"] : []),
        "--extension",
        MODEL_AGENT_READ_EXTENSION,
        "--prompt",
        input.prompt,
        "--dir",
        input.model_dir,
      ],
      cwd: input.model_dir,
      signal: input.signal,
      activity_paths: [join(input.model_dir, "model-progress.json")],
      workspace_root: input.model_dir,
      cleanup_workspace_processes: true,
      on_chunk: async (stream, message) => {
        if (stream === "stderr") consumeImageReadEvents(message)
        process_output = captureAgentProcessOutput(process_output, message)
        await input.append(stream, message)
      },
    })
    if (
      exit_code === 0 ||
      input.signal.aborted ||
      !isTransientAgentTransportFailure(process_output) ||
      retry >= retry_limit
    ) {
      consumeImageReadEvents("", true)
      return { exit_code, process_output, image_reads }
    }

    const delay_ms = Math.min(30_000, base_delay_ms * 2 ** retry)
    await input.append(
      "system",
      `${input.phase_label} transport was throttled or disconnected; preserving the current workspace and retrying in ${Math.ceil(delay_ms / 1_000)} second(s) (${retry + 1}/${retry_limit})…\n`,
    )
    await waitForRetry(delay_ms, input.signal)
    if (input.signal.aborted) {
      consumeImageReadEvents("", true)
      return { exit_code, process_output, image_reads }
    }
  }
}
