import type { JobLogStream } from "@/shared/job-types"
import { addPipelineArtifactReferences, PipelineError, type PipelineArtifactReference } from "../../pipeline"
import { retainStageRejection, seedStageWorkspaceFromRejection, type StageWorkspace } from "../artifacts"
import { ProcessError } from "../process"
import type { AgentClient } from "./agent-client"

export interface AgentArtifactAttempt<Value> {
  value: Value
  attempts: number
  agent_duration_ms: number
}

function getErrorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    const details = [...new Set(error.errors.map((entry) => getErrorMessage(entry)))].filter(
      (detail) => detail && !error.message.includes(detail),
    )
    return [error.message, ...details].join("\n")
  }
  return error instanceof Error ? error.message : String(error)
}

interface ArtifactAttemptFailure {
  readonly attempt: number
  readonly rejected_at: string
  readonly error: string
  readonly retained: boolean
  readonly artifact_path: string
}

const MAX_CUMULATIVE_FEEDBACK_CHARACTERS = 14_000

function boundedDiagnostic(value: string, max_characters: number): string {
  if (value.length <= max_characters) return value
  const marker = "\n... diagnostic truncated ...\n"
  if (max_characters <= marker.length) return value.slice(-max_characters)
  const available = max_characters - marker.length
  const prefix_length = Math.ceil(available / 2)
  return `${value.slice(0, prefix_length)}${marker}${value.slice(-(available - prefix_length))}`
}

function cumulativeFeedback(failures: readonly ArtifactAttemptFailure[]): string | undefined {
  if (failures.length === 0) return undefined
  const headers = failures.map(({ attempt }) => `Rejected attempt ${attempt}:\n`)
  const separator_characters = Math.max(0, failures.length - 1) * 2
  const available_for_errors = Math.max(
    failures.length,
    MAX_CUMULATIVE_FEEDBACK_CHARACTERS -
      headers.reduce((total, header) => total + header.length, 0) -
      separator_characters,
  )
  const base_error_budget = Math.floor(available_for_errors / failures.length)
  let remainder = available_for_errors % failures.length
  return failures
    .map(({ error }, index) => {
      const error_budget = base_error_budget + (remainder > 0 ? 1 : 0)
      remainder = Math.max(0, remainder - 1)
      return `${headers[index]}${boundedDiagnostic(error, error_budget)}`
    })
    .join("\n\n")
}

async function emitOutputBestEffort(
  on_output: (stream: JobLogStream, message: string) => void | Promise<void>,
  stream: JobLogStream,
  message: string,
): Promise<void> {
  try {
    await on_output(stream, message)
  } catch {
    // Log observers never own the artifact-stage outcome.
  }
}

async function writeAttemptHistory(input: {
  debug_dir: string
  stage_id: string
  contract_id?: string
  contract_sha256?: string
  failures: readonly ArtifactAttemptFailure[]
}): Promise<void> {
  await Bun.write(
    `${input.debug_dir}/attempt-history.json`,
    `${JSON.stringify(
      {
        version: 1,
        stage_id: input.stage_id,
        ...(input.contract_id ? { contract_id: input.contract_id } : {}),
        ...(input.contract_sha256 ? { contract_sha256: input.contract_sha256 } : {}),
        failures: input.failures,
      },
      null,
      2,
    )}\n`,
  )
}

async function retainAttemptFailure(input: {
  workspace: string
  attempt: number
  error_message: string
  failures: ArtifactAttemptFailure[]
  stage_id: string
  contract_id?: string
  contract_sha256?: string
  rejection_debug: {
    debug_dir: string
    files?: readonly string[]
    directories?: readonly string[]
  }
  phase_label: string
  on_output: (stream: JobLogStream, message: string) => void | Promise<void>
}): Promise<ArtifactAttemptFailure> {
  let retained = true
  try {
    await retainStageRejection({
      workspace: input.workspace,
      debug_dir: input.rejection_debug.debug_dir,
      attempt: input.attempt,
      error_message: input.error_message,
      files: input.rejection_debug.files,
      directories: input.rejection_debug.directories,
    })
  } catch (retention_error) {
    retained = false
    await emitOutputBestEffort(
      input.on_output,
      "system",
      `Could not retain rejected attempt ${input.attempt}: ${getErrorMessage(retention_error)}\n`,
    )
  }

  const failure: ArtifactAttemptFailure = {
    attempt: input.attempt,
    rejected_at: new Date().toISOString(),
    error: input.error_message,
    retained,
    artifact_path: `${input.rejection_debug.debug_dir}/rejected-attempts/${input.attempt}`,
  }
  input.failures.push(failure)
  await writeAttemptHistory({
    debug_dir: input.rejection_debug.debug_dir,
    stage_id: input.stage_id,
    contract_id: input.contract_id,
    contract_sha256: input.contract_sha256,
    failures: input.failures,
  }).catch(async (history_error) => {
    await emitOutputBestEffort(
      input.on_output,
      "system",
      `Could not write ${input.phase_label} attempt history: ${getErrorMessage(history_error)}\n`,
    )
  })
  return failure
}

function appendPipelineArtifactReferences(
  error: PipelineError,
  references: readonly PipelineArtifactReference[],
): PipelineError {
  const artifact_refs: PipelineArtifactReference[] = []
  const seen = new Set<string>()
  for (const reference of [...error.diagnostic.artifact_refs, ...references]) {
    const key = JSON.stringify([reference.artifact_id ?? null, reference.path ?? null])
    if (seen.has(key)) continue
    seen.add(key)
    artifact_refs.push(reference)
  }

  const enriched = new PipelineError(
    {
      ...error.diagnostic,
      artifact_refs,
    },
    error.cause === undefined ? undefined : { cause: error.cause },
  )
  enriched.stack = error.stack
  return enriched
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
  validate: (workspace: string, attempt: number) => Promise<Value>
  promote: (workspace: string, value: Value, signal: AbortSignal) => Promise<void>
  extensions?: readonly string[]
  tool_profile?: "model_candidate_files"
  heartbeat_paths?: (workspace: string) => readonly string[]
  contract_id?: string
  contract_sha256?: string
  reuse_rejected_artifacts?: boolean
  rejection_debug: {
    debug_dir: string
    files?: readonly string[]
    directories?: readonly string[]
  }
  on_output: (stream: JobLogStream, message: string) => void | Promise<void>
}): Promise<AgentArtifactAttempt<Value>> {
  const max_attempts = Math.max(1, Math.min(4, Math.floor(input.max_artifact_attempts)))
  const failures: ArtifactAttemptFailure[] = []
  let total_duration_ms = 0

  for (let attempt = 1; attempt <= max_attempts; attempt += 1) {
    input.signal.throwIfAborted()
    const workspace = await input.create_workspace(attempt)
    try {
      const previous_failure = failures.at(-1)
      if (
        attempt > 1 &&
        input.reuse_rejected_artifacts !== false &&
        previous_failure?.attempt === attempt - 1 &&
        previous_failure.retained
      ) {
        const seeded = await seedStageWorkspaceFromRejection({
          workspace: workspace.path,
          debug_dir: input.rejection_debug.debug_dir,
          attempt: attempt - 1,
          files: input.rejection_debug.files,
          directories: input.rejection_debug.directories,
        }).catch(async (seed_error) => {
          await emitOutputBestEffort(
            input.on_output,
            "system",
            `Could not seed correction attempt ${attempt} from the retained candidate: ${getErrorMessage(seed_error)}\n`,
          )
          return false
        })
        if (seeded) {
          await emitOutputBestEffort(
            input.on_output,
            "system",
            `Correction attempt ${attempt}/${max_attempts} starts from rejected attempt ${attempt - 1}.\n`,
          )
        }
      }
      input.signal.throwIfAborted()
      const agent_result = await input.agent_client.run({
        workspace: workspace.path,
        prompt: input.build_prompt(cumulativeFeedback(failures)),
        use_openai: input.use_openai,
        signal: input.signal,
        phase_label: input.phase_label,
        extensions: input.extensions,
        tool_profile: input.tool_profile,
        heartbeat_paths: input.heartbeat_paths?.(workspace.path),
        on_output: (stream, message) => emitOutputBestEffort(input.on_output, stream, message),
      })
      total_duration_ms += agent_result.duration_ms
      input.signal.throwIfAborted()
      let value: Value
      try {
        value = await input.validate(workspace.path, attempt)
      } catch (error) {
        input.signal.throwIfAborted()
        const current_error = boundedDiagnostic(getErrorMessage(error), 6_000)
        const failure = await retainAttemptFailure({
          workspace: workspace.path,
          attempt,
          error_message: current_error,
          failures,
          stage_id: input.stage_id,
          contract_id: input.contract_id,
          contract_sha256: input.contract_sha256,
          rejection_debug: input.rejection_debug,
          phase_label: input.phase_label,
          on_output: input.on_output,
        })
        // Retention and trace persistence are asynchronous. Preserve a
        // cancellation that arrives after validation failed instead of
        // replacing it with an artifact-invalid terminal result.
        input.signal.throwIfAborted()
        if (error instanceof PipelineError) {
          throw appendPipelineArtifactReferences(error, [
            { path: `${input.rejection_debug.debug_dir}/attempt-history.json` },
            ...(failure.retained ? [{ path: failure.artifact_path }] : []),
          ])
        }
        if (error instanceof ProcessError) {
          addPipelineArtifactReferences(error, [
            { path: `${input.rejection_debug.debug_dir}/attempt-history.json` },
            ...(failure.retained ? [{ path: failure.artifact_path }] : []),
          ])
          throw error
        }
        if (attempt >= max_attempts) {
          const history = cumulativeFeedback(failures) ?? current_error
          throw new PipelineError(
            {
              code: `${input.stage_id}_artifact_invalid`,
              message: `${input.phase_label} did not produce a valid artifact after ${attempt} attempt(s).\n${history}`,
              stage_id: input.stage_id,
              operation: "validate_agent_artifact",
              artifact_refs: [
                { path: `${input.rejection_debug.debug_dir}/attempt-history.json` },
                ...failures
                  .filter(({ retained }) => retained)
                  .map(({ artifact_path }) => ({
                    path: artifact_path,
                  })),
              ],
              hint: `Inspect attempt-history.json and each retained candidate for ${input.stage_id}.`,
            },
            { cause: error },
          )
        }
        await emitOutputBestEffort(
          input.on_output,
          "system",
          `${input.phase_label} artifact attempt ${attempt} was rejected: ${current_error}\n` +
            `Starting correction attempt ${attempt + 1}/${max_attempts} with cumulative feedback.\n`,
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
      await workspace
        .dispose()
        .catch((cleanup_error) =>
          emitOutputBestEffort(
            input.on_output,
            "system",
            `Could not clean up ${input.phase_label} attempt ${attempt}: ${getErrorMessage(cleanup_error)}\n`,
          ),
        )
    }
  }
  throw new PipelineError({
    code: `${input.stage_id}_artifact_missing`,
    message: `${input.phase_label} produced no artifact`,
    stage_id: input.stage_id,
    operation: "run_agent_artifact_stage",
  })
}
