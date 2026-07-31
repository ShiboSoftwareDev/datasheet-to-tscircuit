import type { JobLogStream } from "@/shared/job-types"
import { PipelineError } from "../../pipeline"
import { retainStageRejection, type StageWorkspace } from "../artifacts"
import type { AgentClient } from "./agent-client"

export interface AgentArtifactAttempt<Value> {
  value: Value
  attempts: number
  agent_duration_ms: number
}

function getErrorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    const details = error.errors.map((entry) => (entry instanceof Error ? entry.message : String(entry)))
    return [error.message, ...details].join("\n")
  }
  return error instanceof Error ? error.message : String(error)
}

/** Promote only artifacts that parse and pass their server-owned contract. */
export async function runAgentArtifactStage<Value>(input: {
  stage_id: string
  phase_label: string
  max_artifact_attempts: number
  signal: AbortSignal
  use_openai: boolean
  agent_client: AgentClient
  create_workspace: (attempt: number) => Promise<StageWorkspace>
  build_prompt: (feedback?: string) => string
  validate: (workspace: string) => Promise<Value>
  promote: (workspace: string, value: Value, signal: AbortSignal) => Promise<void>
  extensions?: readonly string[]
  heartbeat_paths?: (workspace: string) => readonly string[]
  rejection_debug: {
    debug_dir: string
    files?: readonly string[]
    directories?: readonly string[]
  }
  on_output: (stream: JobLogStream, message: string) => void | Promise<void>
}): Promise<AgentArtifactAttempt<Value>> {
  const max_attempts = Math.max(1, Math.min(4, Math.floor(input.max_artifact_attempts)))
  let feedback: string | undefined
  let total_duration_ms = 0

  for (let attempt = 1; attempt <= max_attempts; attempt += 1) {
    input.signal.throwIfAborted()
    const workspace = await input.create_workspace(attempt)
    try {
      input.signal.throwIfAborted()
      const agent_result = await input.agent_client.run({
        workspace: workspace.path,
        prompt: input.build_prompt(feedback),
        use_openai: input.use_openai,
        signal: input.signal,
        phase_label: input.phase_label,
        extensions: input.extensions,
        heartbeat_paths: input.heartbeat_paths?.(workspace.path),
        on_output: input.on_output,
      })
      total_duration_ms += agent_result.duration_ms
      input.signal.throwIfAborted()
      let value: Value
      try {
        value = await input.validate(workspace.path)
      } catch (error) {
        input.signal.throwIfAborted()
        feedback = getErrorMessage(error).slice(0, 14_000)
        await retainStageRejection({
          workspace: workspace.path,
          debug_dir: input.rejection_debug.debug_dir,
          attempt,
          error_message: feedback,
          files: input.rejection_debug.files,
          directories: input.rejection_debug.directories,
        }).catch(async (retention_error) => {
          await input.on_output(
            "system",
            `Could not retain rejected attempt ${attempt}: ${getErrorMessage(retention_error)}\n`,
          )
        })
        if (attempt >= max_attempts) {
          throw new PipelineError(
            {
              code: `${input.stage_id}_artifact_invalid`,
              message: `${input.phase_label} did not produce a valid artifact after ${attempt} attempt(s): ${feedback}`,
              stage_id: input.stage_id,
              operation: "validate_agent_artifact",
              artifact_refs: [
                {
                  path: `${input.rejection_debug.debug_dir}/rejected-attempts/${attempt}`,
                },
              ],
              hint: `Inspect the retained rejected artifact and validation-error.txt for ${input.stage_id}.`,
            },
            { cause: error },
          )
        }
        await input.on_output(
          "system",
          `${input.phase_label} artifact attempt ${attempt} was rejected: ${feedback}\n` +
            `Starting a clean correction attempt ${attempt + 1}/${max_attempts}.\n`,
        )
        continue
      }
      input.signal.throwIfAborted()
      try {
        // Promotion is the stage's commit boundary. Never enter it after cancellation.
        input.signal.throwIfAborted()
        await input.promote(workspace.path, value, input.signal)
      } catch (error) {
        if (input.signal.aborted && error === input.signal.reason) throw error
        throw new PipelineError(
          {
            code: `${input.stage_id}_artifact_promotion_failed`,
            message: `${input.phase_label} produced a valid artifact, but the server could not promote it: ${getErrorMessage(error)}`,
            stage_id: input.stage_id,
            operation: "promote_agent_artifact",
            retryable: false,
            hint: "Resolve the server storage error; rerunning the generation agent will not repair it.",
          },
          { cause: error },
        )
      }
      return { value, attempts: attempt, agent_duration_ms: total_duration_ms }
    } finally {
      await workspace.dispose().catch(async (cleanup_error) => {
        try {
          await input.on_output(
            "system",
            `Could not clean up ${input.phase_label} attempt ${attempt}: ${getErrorMessage(cleanup_error)}\n`,
          )
        } catch {
          // Cleanup and optional log-sink failures never replace the stage outcome.
        }
      })
    }
  }
  throw new PipelineError({
    code: `${input.stage_id}_artifact_missing`,
    message: `${input.phase_label} produced no artifact`,
    stage_id: input.stage_id,
    operation: "run_agent_artifact_stage",
  })
}
