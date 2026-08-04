import type {
  PipelineArtifactReference,
  PipelineDiagnostic,
  PipelineDiagnosticCause,
  PipelineEntityReference,
} from "@/shared/pipeline-types"

export interface PipelineDiagnosticInput {
  readonly code: string
  readonly message: string
  readonly stage_id: string | null
  readonly operation: string
  readonly severity?: PipelineDiagnostic["severity"]
  readonly entity_refs?: readonly PipelineEntityReference[]
  readonly artifact_refs?: readonly PipelineArtifactReference[]
  readonly cause_chain?: readonly PipelineDiagnosticCause[]
  readonly hint?: string
  readonly retryable?: boolean
}

const supplementalArtifactReferences = new WeakMap<Error, readonly PipelineArtifactReference[]>()

function mergeArtifactReferences(
  ...groups: ReadonlyArray<readonly PipelineArtifactReference[] | undefined>
): PipelineArtifactReference[] {
  const merged: PipelineArtifactReference[] = []
  const seen = new Set<string>()
  for (const reference of groups.flatMap((group) => group ?? [])) {
    const key = JSON.stringify([reference.artifact_id ?? null, reference.path ?? null])
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(reference)
  }
  return merged
}

/**
 * Attach debug artifacts to a typed error without replacing its identity.
 * The pipeline conversion boundary consumes these references if the error
 * eventually becomes a PipelineError.
 */
export function addPipelineArtifactReferences(
  error: Error,
  references: readonly PipelineArtifactReference[],
): void {
  supplementalArtifactReferences.set(
    error,
    Object.freeze(
      mergeArtifactReferences(supplementalArtifactReferences.get(error), references).map((reference) =>
        Object.freeze({ ...reference }),
      ),
    ),
  )
}

const freezeDiagnostic = (input: PipelineDiagnosticInput): PipelineDiagnostic =>
  Object.freeze({
    code: input.code,
    severity: input.severity ?? "error",
    message: input.message,
    stage_id: input.stage_id,
    operation: input.operation,
    entity_refs: Object.freeze([...(input.entity_refs ?? [])]),
    artifact_refs: Object.freeze([...(input.artifact_refs ?? [])]),
    cause_chain: Object.freeze([...(input.cause_chain ?? [])]),
    ...(input.hint === undefined ? {} : { hint: input.hint }),
    retryable: input.retryable ?? false,
  })

export const getPipelineCauseChain = (error: unknown): readonly PipelineDiagnosticCause[] => {
  const causes: PipelineDiagnosticCause[] = []
  const visited = new Set<unknown>()
  let current: unknown = error

  while (current instanceof Error && !visited.has(current)) {
    visited.add(current)
    causes.push(
      Object.freeze({
        name: current.name || "Error",
        message: current.message,
        ...(current.stack === undefined ? {} : { stack: current.stack }),
      }),
    )
    current = "cause" in current ? current.cause : undefined
  }

  if (current !== undefined && current !== null && !visited.has(current)) {
    causes.push(
      Object.freeze({
        name: "NonErrorCause",
        message: String(current),
      }),
    )
  }

  return Object.freeze(causes)
}

export class PipelineError extends Error {
  readonly diagnostic: PipelineDiagnostic

  constructor(input: PipelineDiagnosticInput, options?: { cause?: unknown }) {
    super(input.message, options)
    this.name = "PipelineError"
    this.diagnostic = freezeDiagnostic({
      ...input,
      cause_chain:
        input.cause_chain ??
        (options?.cause === undefined ? undefined : getPipelineCauseChain(options.cause)),
    })
  }
}

export const toPipelineError = (
  error: unknown,
  input: Omit<PipelineDiagnosticInput, "message" | "cause_chain"> & {
    readonly fallback_message: string
  },
): PipelineError => {
  if (error instanceof PipelineError) {
    if (error.diagnostic.stage_id !== null || input.stage_id === null) {
      return error
    }
    return new PipelineError({
      ...error.diagnostic,
      stage_id: input.stage_id,
    })
  }

  const process_error_code =
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^process_(?:spawn_failed|exit_failed|output_handler_failed|idle_timeout|wall_timeout|cancelled)$/.test(
      error.code,
    )
      ? error.code
      : undefined

  return new PipelineError(
    {
      ...input,
      artifact_refs: mergeArtifactReferences(
        input.artifact_refs,
        error instanceof Error ? supplementalArtifactReferences.get(error) : undefined,
      ),
      ...(process_error_code
        ? {
            code: process_error_code,
            operation: "run_external_process",
            retryable: process_error_code === "process_spawn_failed",
          }
        : {}),
      message: error instanceof Error ? error.message : input.fallback_message,
      cause_chain: getPipelineCauseChain(error),
    },
    { cause: error },
  )
}
