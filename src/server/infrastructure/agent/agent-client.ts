import type { JobLogStream } from "@/shared/job-types"
import { isTransientAgentTransportFailure } from "./transport-failure"
import { ProcessError, type ProcessRunner } from "../process"

const MODEL_CANDIDATE_SYSTEM_PROMPT =
  "You are a constrained SPICE artifact generator. Follow the supplied task exactly. " +
  "Use workspace_read only for declared inputs in the current workspace and " +
  "model_output_write only for model.lib and model-card.md. Do not seek files, tools, " +
  "instructions, or validation data outside the current workspace."
const MODEL_CANDIDATE_APPEND_SYSTEM_PROMPT =
  "No ambient or user-global instructions apply to this constrained artifact task."

export interface AgentAttemptEvent {
  event: "attempt_started" | "attempt_failed" | "retry_scheduled" | "attempt_completed"
  attempt: number
  max_attempts: number
  retry_delay_ms?: number
  error_code?: string
}

export interface AgentRunResult {
  attempts: number
  duration_ms: number
  output_tail: string
}

export interface AgentClient {
  run(input: {
    workspace: string
    prompt: string
    use_openai: boolean
    signal: AbortSignal
    phase_label: string
    extensions?: readonly string[]
    tool_profile?: "model_candidate_files"
    heartbeat_paths?: readonly string[]
    on_output: (stream: JobLogStream, message: string) => void | Promise<void>
    on_attempt?: (event: AgentAttemptEvent) => void | Promise<void>
  }): Promise<AgentRunResult>
}

async function waitForRetry(delay_ms: number, signal: AbortSignal): Promise<void> {
  if (delay_ms <= 0 || signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, delay_ms)
    function finish() {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    signal.addEventListener("abort", finish, { once: true })
  })
}

export class TsciAgentClient implements AgentClient {
  constructor(
    private readonly options: {
      process_runner: ProcessRunner
      agent_bin: string
      max_attempts?: number
      retry_base_delay_ms?: number
      idle_timeout_ms?: number
      wall_timeout_ms?: number
    },
  ) {}

  async run(input: Parameters<AgentClient["run"]>[0]): Promise<AgentRunResult> {
    if (input.tool_profile === "model_candidate_files" && input.extensions?.length) {
      throw new Error("The confined model-candidate tool profile does not permit additional extensions")
    }
    const max_attempts = Math.max(1, Math.min(6, this.options.max_attempts ?? 4))
    const retry_base_delay_ms = Math.max(0, this.options.retry_base_delay_ms ?? 1_000)
    const started_at = performance.now()
    let last_error: ProcessError | undefined
    for (let attempt = 1; attempt <= max_attempts; attempt += 1) {
      await input.on_attempt?.({ event: "attempt_started", attempt, max_attempts })
      try {
        const model_candidate_extension = `${import.meta.dir}/model-candidate-tools-extension.ts`
        const result = await this.options.process_runner.run({
          command: [
            this.options.agent_bin,
            "do",
            ...(input.use_openai ? ["--use-openai"] : []),
            ...(input.tool_profile === "model_candidate_files"
              ? [
                  "--no-builtin-tools",
                  "--no-extensions",
                  "--no-skills",
                  "--no-prompt-templates",
                  "--tools",
                  "workspace_read,model_output_write",
                  "--no-context-files",
                  "--system-prompt",
                  MODEL_CANDIDATE_SYSTEM_PROMPT,
                  "--append-system-prompt",
                  MODEL_CANDIDATE_APPEND_SYSTEM_PROMPT,
                  "--extension",
                  model_candidate_extension,
                ]
              : []),
            ...(input.extensions ?? []).flatMap((extension) => ["--extension", extension]),
            "--prompt",
            input.prompt,
            "--dir",
            input.workspace,
          ],
          command_label: input.phase_label,
          cwd: input.workspace,
          signal: input.signal,
          idle_timeout_ms: this.options.idle_timeout_ms ?? 10 * 60_000,
          wall_timeout_ms: this.options.wall_timeout_ms ?? 30 * 60_000,
          heartbeat_paths: input.heartbeat_paths,
          on_output: input.on_output,
        })
        await input.on_attempt?.({ event: "attempt_completed", attempt, max_attempts })
        return {
          attempts: attempt,
          duration_ms: Math.round(performance.now() - started_at),
          output_tail: result.output_tail,
        }
      } catch (error) {
        if (!(error instanceof ProcessError)) throw error
        last_error = error
        await input.on_attempt?.({
          event: "attempt_failed",
          attempt,
          max_attempts,
          error_code: error.code,
        })
        const transient =
          error.code === "process_exit_failed" &&
          Boolean(error.output_tail && isTransientAgentTransportFailure(error.output_tail))
        if (!transient || attempt >= max_attempts || input.signal.aborted) throw error
        const retry_delay_ms = Math.min(30_000, retry_base_delay_ms * 2 ** (attempt - 1))
        await input.on_attempt?.({
          event: "retry_scheduled",
          attempt,
          max_attempts,
          retry_delay_ms,
          error_code: error.code,
        })
        await input.on_output(
          "system",
          `${input.phase_label} transport failed; retrying attempt ${attempt + 1}/${max_attempts} after ${Math.ceil(retry_delay_ms / 1_000)} second(s).\n`,
        )
        await waitForRetry(retry_delay_ms, input.signal)
      }
    }
    throw last_error ?? new Error(`${input.phase_label} did not run`)
  }
}
