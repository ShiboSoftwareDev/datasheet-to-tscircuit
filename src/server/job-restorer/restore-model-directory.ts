import { readFile, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type {
  ModelManifest,
  ModelRun,
  ModelRunStatus,
  ModelSelectedPreview,
  ModelValidationSummary,
} from "@/shared/job-types"
import { parseModelSelectedPreview, tryParseModelSelectedPreview } from "@/shared/model-selected-preview"
import { RETAINED_ACCEPTED_WARNING_PREFIX } from "@/shared/model-warnings"
import type { ModelRunStore } from "../model-run-store"
import {
  modelCheckpointRequiresPublicationPointer,
  readModelPublication,
  readVerifiedPublicationArtifact,
  validateModelCompletionIntegrity,
} from "../modeling"
import { parsePublicPipelineSnapshot } from "../pipeline"
import { isRecord, readJson, readPersistedLogs } from "./read-persisted-logs"
import { ACTIVE_MODEL_STATUSES, MODEL_STATUSES } from "./restore-types"
import {
  isModelCircuitPreview,
  isModelReferencePreview,
  parseRestoredModelProgress,
} from "./restored-model-metadata"

function selectedPreview(value: unknown): ModelSelectedPreview | undefined {
  return tryParseModelSelectedPreview(value)
}

function restoredProgressHistory(value: unknown): ModelRun["progress_history"] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const progress = parseRestoredModelProgress(entry)
    if (!progress) return []
    return [
      {
        sequence: progress.sequence,
        phase: progress.phase,
        message: progress.message,
        updated_at: progress.updated_at,
        iteration: progress.iteration,
      },
    ]
  })
}

function publicationIntegrityMessage(error: unknown): string {
  const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim()
  return detail.length > 1_000 ? `${detail.slice(0, 997)}...` : detail
}

async function readCurrentCandidateProjection(input: {
  model_dir: string
  model_run_id?: string
  invocation_id?: string
}): Promise<Record<string, unknown> | undefined> {
  if (!input.model_run_id || !input.invocation_id) return undefined
  const marker_value = await readJson(join(input.model_dir, "current-preview.json"))
  if (
    !isRecord(marker_value) ||
    marker_value.version !== 1 ||
    marker_value.model_run_id !== input.model_run_id ||
    marker_value.invocation_id !== input.invocation_id ||
    typeof marker_value.revision !== "string" ||
    typeof marker_value.preview_generation !== "string" ||
    !/^[a-zA-Z0-9_-]{16,200}$/.test(marker_value.preview_generation)
  ) {
    return undefined
  }
  const marker_revision = marker_value.revision as string
  const marker_preview_generation = marker_value.preview_generation as string
  const ui_value = await readJson(
    join(input.model_dir, "current-previews", marker_preview_generation, "model-ui.json"),
  )
  if (!isRecord(ui_value) || !isRecord(ui_value.validation)) return undefined
  const validation = ui_value.validation
  if (
    validation.artifact_state !== "candidate" ||
    validation.model_revision !== marker_revision ||
    validation.preview_generation !== marker_preview_generation ||
    !Array.isArray(ui_value.preview_options) ||
    !isRecord(ui_value.selected_previews)
  ) {
    return undefined
  }
  const parsed_selected_previews = Object.fromEntries(
    Object.entries(ui_value.selected_previews).flatMap(([case_id, value]) => {
      const preview = tryParseModelSelectedPreview(value, {
        expected_artifact_identity: /^[a-f0-9]{16}$/.test(marker_revision)
          ? {
              preview_generation: marker_preview_generation,
              model_revision: marker_revision,
            }
          : undefined,
      })
      return preview ? [[case_id, preview]] : []
    }),
  )
  return { ...ui_value, selected_previews: parsed_selected_previews }
}

function restorePublicationIntegrityFailure(input: {
  job_id: string
  model_dir: string
  model_run_store: ModelRunStore
  directory_stat: { birthtime: Date; mtime: Date }
  saved: Record<string, unknown> | undefined
  logs: ModelRun["logs"]
  error: unknown
}): ModelRun {
  const checkpoint = input.saved?.job_id === input.job_id ? input.saved : undefined
  const detail = publicationIntegrityMessage(input.error)
  const discarded_message =
    "Accepted model publication failed integrity validation; unverified model artifacts and metrics were discarded"
  const restored_progress = parseRestoredModelProgress(checkpoint?.progress)
  const progress_history = restoredProgressHistory(checkpoint?.progress_history)
  const latest_sequence = Math.max(
    restored_progress?.sequence ?? -1,
    ...progress_history.map(({ sequence }) => sequence),
  )
  const sequence =
    Number.isSafeInteger(latest_sequence) && latest_sequence < Number.MAX_SAFE_INTEGER
      ? latest_sequence + 1
      : 0
  const iteration =
    typeof checkpoint?.iteration === "number" &&
    Number.isSafeInteger(checkpoint.iteration) &&
    checkpoint.iteration >= 0
      ? checkpoint.iteration
      : 0
  const restored_at = new Date().toISOString()
  const progress: NonNullable<ModelRun["progress"]> = {
    sequence,
    phase: "failed",
    message: discarded_message,
    updated_at: restored_at,
    iteration,
  }
  const saved_warnings = Array.isArray(checkpoint?.warnings)
    ? checkpoint.warnings.filter(
        (warning): warning is string =>
          typeof warning === "string" && !warning.startsWith(RETAINED_ACCEPTED_WARNING_PREFIX),
      )
    : []
  const saved_elapsed_time_ms =
    typeof checkpoint?.elapsed_time_ms === "number" && Number.isFinite(checkpoint.elapsed_time_ms)
      ? Math.max(0, checkpoint.elapsed_time_ms)
      : 0
  const model_run_id =
    typeof checkpoint?.model_run_id === "string" &&
    checkpoint.model_run_id.trim().length > 0 &&
    checkpoint.model_run_id.length <= 200
      ? checkpoint.model_run_id
      : `restored-${input.job_id}`
  const model_run: ModelRun = {
    model_run_id,
    job_id: input.job_id,
    use_openai: typeof checkpoint?.use_openai === "boolean" ? checkpoint.use_openai : undefined,
    created_at:
      typeof checkpoint?.created_at === "string"
        ? checkpoint.created_at
        : input.directory_stat.birthtime.toISOString(),
    updated_at: restored_at,
    completed_at: restored_at,
    status: "failed",
    is_complete: true,
    has_errors: true,
    error_message: `${discarded_message} during restart: ${detail}`,
    warnings: [...saved_warnings, `${discarded_message}: ${detail}`],
    effort_multiplier:
      typeof checkpoint?.effort_multiplier === "number" && checkpoint.effort_multiplier > 0
        ? checkpoint.effort_multiplier
        : 1,
    elapsed_time_ms: saved_elapsed_time_ms,
    current_invocation_id:
      typeof checkpoint?.current_invocation_id === "string" &&
      /^[a-f0-9-]{16,80}$/.test(checkpoint.current_invocation_id)
        ? checkpoint.current_invocation_id
        : undefined,
    iteration,
    logs: input.logs,
    progress,
    progress_history: [
      ...progress_history,
      {
        sequence: progress.sequence,
        phase: progress.phase,
        message: progress.message,
        updated_at: progress.updated_at,
        iteration: progress.iteration,
      },
    ],
    preview_options: [],
    pipeline: parsePublicPipelineSnapshot(checkpoint?.pipeline),
  }
  return input.model_run_store.restoreModelRun({
    model_dir: input.model_dir,
    model_run,
    logs: input.logs,
  })
}

export async function restoreModelDirectory(input: {
  job_id: string
  model_dir: string
  model_run_store: ModelRunStore
}): Promise<ModelRun | undefined> {
  const directory_stat = await stat(input.model_dir).catch(() => undefined)
  if (!directory_stat?.isDirectory()) return undefined
  const [snapshot, logs, checkpoint_stat] = await Promise.all([
    readJson(join(input.model_dir, "model-run.json")),
    readPersistedLogs(join(input.model_dir, "model-agent.log")),
    stat(join(input.model_dir, "model-run.json")).catch(() => undefined),
  ])
  const saved = isRecord(snapshot) ? snapshot : undefined
  const checkpoint_exists = Boolean(checkpoint_stat?.isFile())
  let publication: Awaited<ReturnType<typeof readModelPublication>>
  try {
    publication = await readModelPublication(dirname(input.model_dir), input.job_id)
  } catch (error) {
    if (!checkpoint_exists) throw error
    return restorePublicationIntegrityFailure({
      ...input,
      directory_stat,
      saved,
      logs,
      error,
    })
  }
  if (!publication && modelCheckpointRequiresPublicationPointer(saved)) {
    return restorePublicationIntegrityFailure({
      ...input,
      directory_stat,
      saved,
      logs,
      error: new Error(
        "published-model.json is missing even though the completed datasheet_model pipeline recorded publish_model as committed",
      ),
    })
  }
  const readAcceptedText = async (relative_path: string, max_bytes: number): Promise<string | undefined> =>
    publication
      ? new TextDecoder().decode(
          await readVerifiedPublicationArtifact({
            publication,
            bundle: "accepted_model",
            relative_path,
            max_bytes,
          }),
        )
      : readFile(join(input.model_dir, relative_path), "utf8").catch(() => undefined)
  const readAcceptedJson = async (relative_path: string, max_bytes: number): Promise<unknown> => {
    if (!publication) return readJson(join(input.model_dir, relative_path))
    return JSON.parse((await readAcceptedText(relative_path, max_bytes))!)
  }
  let accepted_artifacts: [
    string | undefined,
    unknown,
    unknown,
    string | undefined,
    unknown,
    unknown,
    unknown,
  ]
  try {
    accepted_artifacts = await Promise.all([
      readAcceptedText("model.lib", 2 * 1024 * 1024),
      readAcceptedJson("model-manifest.json", 2 * 1024 * 1024),
      readAcceptedJson("validation-results.json", 32 * 1024 * 1024),
      readAcceptedText("model-card.md", 2 * 1024 * 1024),
      readAcceptedJson("model-ui.json", 16 * 1024 * 1024),
      readAcceptedJson("model-contract.json", 4 * 1024 * 1024),
      readAcceptedJson("validation-plan.json", 8 * 1024 * 1024),
    ])
  } catch (error) {
    if (!publication || !checkpoint_exists) throw error
    return restorePublicationIntegrityFailure({
      ...input,
      directory_stat,
      saved,
      logs,
      error,
    })
  }
  const [model_source, manifest, result, model_card, model_ui, contract, plan] = accepted_artifacts
  const saved_model_run_id = typeof saved?.model_run_id === "string" ? saved.model_run_id : undefined
  const saved_job_id = typeof saved?.job_id === "string" ? saved.job_id : undefined
  const checkpoint_identity_conflict = Boolean(
    publication &&
      ((saved_model_run_id && saved_model_run_id !== publication.commit.model_run_id) ||
        (saved_job_id && saved_job_id !== input.job_id)),
  )
  // A fully verified publication pointer is stronger than a conflicting
  // compatibility checkpoint. Ignore the checkpoint instead of hiding the
  // accepted model or partially restoring only its component job.
  const checkpoint = checkpoint_identity_conflict ? undefined : saved
  const saved_status_is_valid =
    typeof checkpoint?.status === "string" && MODEL_STATUSES.has(checkpoint.status as ModelRunStatus)
  const ui = isRecord(model_ui) ? model_ui : undefined
  const raw_status = saved_status_is_valid ? (checkpoint.status as ModelRunStatus) : "failed"
  const interrupted = ACTIVE_MODEL_STATUSES.has(raw_status)
  const saved_invocation_id =
    typeof checkpoint?.current_invocation_id === "string" &&
    /^[a-f0-9-]{16,80}$/.test(checkpoint.current_invocation_id)
      ? checkpoint.current_invocation_id
      : undefined
  const publication_matches_invocation = Boolean(
    publication && saved_invocation_id === publication.commit.invocation_id,
  )
  const checkpoint_identity_is_valid = Boolean(
    !checkpoint_identity_conflict &&
      saved_model_run_id &&
      saved_job_id === input.job_id &&
      saved_status_is_valid,
  )
  const recovered_publication = Boolean(
    publication &&
      (!checkpoint_identity_is_valid || publication_matches_invocation || saved_invocation_id === undefined),
  )
  const uncommitted_completion = Boolean(
    publication &&
      checkpoint_identity_is_valid &&
      raw_status === "complete" &&
      saved_invocation_id !== undefined &&
      !publication_matches_invocation,
  )
  const completion_integrity =
    raw_status === "complete" || publication
      ? validateModelCompletionIntegrity({
          model_source,
          manifest,
          contract,
          plan,
          result,
          policy: "legacy_compatibility",
        })
      : undefined
  const invalid_completion = completion_integrity?.valid === false
  const status: ModelRunStatus = invalid_completion
    ? "failed"
    : uncommitted_completion
      ? "failed"
      : recovered_publication
        ? "complete"
        : interrupted
          ? "failed"
          : raw_status
  const saved_elapsed_time_ms =
    typeof checkpoint?.elapsed_time_ms === "number" && Number.isFinite(checkpoint.elapsed_time_ms)
      ? Math.max(0, checkpoint.elapsed_time_ms)
      : 0
  const saved_segment_started_at =
    typeof checkpoint?.segment_started_at === "string"
      ? new Date(checkpoint.segment_started_at).valueOf()
      : Number.NaN
  const interrupted_segment_ms =
    interrupted && Number.isFinite(saved_segment_started_at)
      ? Math.max(0, Date.now() - saved_segment_started_at)
      : 0
  const effort_multiplier =
    typeof checkpoint?.effort_multiplier === "number" && checkpoint.effort_multiplier > 0
      ? checkpoint.effort_multiplier
      : 1
  const candidate_ui =
    !invalid_completion && !recovered_publication && status !== "complete" && !checkpoint_identity_conflict
      ? await readCurrentCandidateProjection({
          model_dir: input.model_dir,
          model_run_id: saved_model_run_id,
          invocation_id: saved_invocation_id,
        })
      : undefined
  const display_ui = candidate_ui ?? ui
  const selected_previews = isRecord(display_ui?.selected_previews) ? display_ui.selected_previews : undefined
  let first_selected: ModelSelectedPreview | undefined
  if (publication?.commit.version === 3 && display_ui === ui) {
    try {
      if (!selected_previews || Object.keys(selected_previews).length === 0) {
        throw new Error("Fresh accepted model-ui.json has no selected previews")
      }
      const parsed_previews = Object.values(selected_previews).map((value) =>
        parseModelSelectedPreview(value, {
          fresh_accepted: true,
          expected_artifact_identity: {
            preview_generation: basename(publication.accepted_model_dir),
            model_revision: publication.commit.revision,
          },
        }),
      )
      first_selected = parsed_previews[0]
    } catch (error) {
      if (!checkpoint_exists) throw error
      return restorePublicationIntegrityFailure({
        ...input,
        directory_stat,
        saved,
        logs,
        error,
      })
    }
  } else {
    first_selected = selected_previews ? selectedPreview(Object.values(selected_previews)[0]) : undefined
  }
  const error_message = recovered_publication
    ? undefined
    : uncommitted_completion
      ? candidate_ui
        ? "The latest model invocation did not commit the accepted publication pointer. Its candidate validation remains inspectable but is not accepted."
        : "The latest model invocation claimed completion without committing the accepted publication pointer. Its uncommitted metrics were discarded."
      : interrupted
        ? "The server restarted before this model pipeline finished. Retry to start a new trace; completed artifacts were preserved."
        : invalid_completion
          ? `The saved run cannot be restored as complete: ${completion_integrity.reason}. Retry it with the current pipeline.`
          : typeof checkpoint?.error_message === "string"
            ? checkpoint.error_message
            : undefined
  const saved_warnings = Array.isArray(checkpoint?.warnings)
    ? checkpoint.warnings.filter((warning): warning is string => typeof warning === "string")
    : []
  const warnings_without_retained = saved_warnings.filter(
    (warning) => !warning.startsWith(RETAINED_ACCEPTED_WARNING_PREFIX),
  )
  const warnings = recovered_publication
    ? [
        ...warnings_without_retained,
        ...(checkpoint_identity_conflict
          ? [
              "Ignored a conflicting model-run checkpoint and recovered the hash-verified accepted publication.",
            ]
          : []),
      ]
    : publication && status !== "complete"
      ? [
          ...warnings_without_retained,
          `${RETAINED_ACCEPTED_WARNING_PREFIX} ${publication.commit.revision} because the latest replacement attempt did not commit; its accepted metrics and downloads remain available.`,
        ]
      : saved_warnings
  const restored_progress = parseRestoredModelProgress(checkpoint?.progress)
  const progress = recovered_publication
    ? {
        sequence: (restored_progress?.sequence ?? 0) + 1,
        phase: "complete" as const,
        message: "Recovered the atomically committed model/component publication after restart",
        updated_at: publication!.commit.published_at,
        iteration: typeof checkpoint?.iteration === "number" ? checkpoint.iteration : undefined,
      }
    : restored_progress
  const model_run: ModelRun = {
    model_run_id:
      publication?.commit.model_run_id ??
      (typeof checkpoint?.model_run_id === "string" ? checkpoint.model_run_id : `restored-${input.job_id}`),
    job_id: input.job_id,
    use_openai: typeof checkpoint?.use_openai === "boolean" ? checkpoint.use_openai : undefined,
    created_at:
      typeof checkpoint?.created_at === "string"
        ? checkpoint.created_at
        : directory_stat.birthtime.toISOString(),
    updated_at:
      typeof checkpoint?.updated_at === "string" ? checkpoint.updated_at : directory_stat.mtime.toISOString(),
    completed_at: recovered_publication
      ? publication!.commit.published_at
      : typeof checkpoint?.completed_at === "string"
        ? checkpoint.completed_at
        : directory_stat.mtime.toISOString(),
    status,
    is_complete: true,
    has_errors: status === "failed" || status === "timed_out",
    error_message,
    warnings,
    effort_multiplier,
    elapsed_time_ms: saved_elapsed_time_ms + interrupted_segment_ms,
    current_invocation_id: recovered_publication ? publication!.commit.invocation_id : saved_invocation_id,
    iteration: typeof checkpoint?.iteration === "number" ? checkpoint.iteration : 0,
    logs,
    model_source: invalid_completion
      ? undefined
      : publication
        ? model_source
        : (model_source ??
          (typeof checkpoint?.model_source === "string" ? checkpoint.model_source : undefined)),
    manifest: invalid_completion
      ? undefined
      : publication && completion_integrity?.valid
        ? completion_integrity.manifest
        : completion_integrity?.valid
          ? completion_integrity.manifest
          : ((isRecord(checkpoint?.manifest) ? checkpoint.manifest : manifest) as ModelManifest | undefined),
    validation: invalid_completion
      ? undefined
      : ((candidate_ui
          ? candidate_ui.validation
          : publication
            ? status === "complete"
              ? ui?.validation
              : undefined
            : isRecord(checkpoint?.validation)
              ? checkpoint.validation
              : ui?.validation) as ModelValidationSummary | undefined),
    model_card: invalid_completion
      ? undefined
      : publication
        ? model_card
        : typeof checkpoint?.model_card === "string"
          ? checkpoint.model_card
          : model_card,
    progress,
    progress_history: Array.isArray(checkpoint?.progress_history)
      ? (checkpoint.progress_history as ModelRun["progress_history"])
      : [],
    circuit_preview: invalid_completion
      ? undefined
      : candidate_ui
        ? first_selected?.circuit_preview
        : publication
          ? status === "complete"
            ? first_selected?.circuit_preview
            : undefined
          : isModelCircuitPreview(checkpoint?.circuit_preview)
            ? checkpoint.circuit_preview
            : first_selected?.circuit_preview,
    reference_preview: invalid_completion
      ? undefined
      : candidate_ui
        ? first_selected?.reference_preview
        : publication
          ? status === "complete"
            ? first_selected?.reference_preview
            : undefined
          : isModelReferencePreview(checkpoint?.reference_preview)
            ? checkpoint.reference_preview
            : first_selected?.reference_preview,
    preview_options: invalid_completion
      ? []
      : candidate_ui
        ? (candidate_ui.preview_options as ModelRun["preview_options"])
        : publication
          ? status === "complete" && Array.isArray(ui?.preview_options)
            ? (ui.preview_options as ModelRun["preview_options"])
            : []
          : Array.isArray(checkpoint?.preview_options)
            ? (checkpoint.preview_options as ModelRun["preview_options"])
            : Array.isArray(ui?.preview_options)
              ? (ui.preview_options as ModelRun["preview_options"])
              : [],
    pipeline: parsePublicPipelineSnapshot(checkpoint?.pipeline),
  }
  return input.model_run_store.restoreModelRun({ model_dir: input.model_dir, model_run, logs })
}
