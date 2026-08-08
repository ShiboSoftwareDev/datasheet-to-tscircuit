import { resolve } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import type { ModelSelectedPreview } from "@/shared/job-types"
import { RETAINED_ACCEPTED_WARNING_PREFIX } from "@/shared/model-warnings"
import { selectPreferredComponentCircuitJson } from "../../component-circuit-json"
import { promoteStageDirectory, promoteStageFile, validatePngArtifact } from "../../infrastructure/artifacts"
import type { JobStore } from "../../job-store"
import type { ModelRunStore } from "../../model-run-store"
import {
  commitModelPublication,
  type GeneratedModel,
  readVerifiedPublicationArtifact,
  requireModelCompletionIntegrity,
  validateResolvedModelPublication,
} from "../../modeling"
import { stableStringify, type ValidationPlan } from "../../spice-validation"
import { discardPreparedModelPublication, type PreparedModelPublication } from "./publication-prepare"

function persistedIdentity(value: unknown): string {
  return stableStringify(JSON.parse(JSON.stringify(value)))
}

function withoutRetainedAcceptedWarning(warnings: readonly string[] | undefined): string[] {
  return (warnings ?? []).filter((warning) => !warning.startsWith(RETAINED_ACCEPTED_WARNING_PREFIX))
}

async function commitPreparedModelPublicationWithoutCleanup(input: {
  prepared: PreparedModelPublication
  job_id: string
  job_dir: string
  job_store: JobStore
  model_dir: string
  model_run_id: string
  model_run_store: ModelRunStore
  plan: ValidationPlan
  generated: GeneratedModel
  circuit_json: AnyCircuitElement[]
  signal: AbortSignal
}): Promise<string[]> {
  input.signal.throwIfAborted()
  const resolved_publication = await validateResolvedModelPublication(
    {
      commit: input.prepared.commit,
      accepted_model_dir: input.prepared.accepted_model_dir,
      published_component_dir: input.prepared.published_component_dir,
    },
    input.job_id,
  )
  const current_job = input.job_store.getJob(input.job_id)
  const current_model_run = input.model_run_store.getModelRun(input.model_run_id)
  if (!current_job || !current_model_run) {
    throw new Error("Cannot publish a model for a missing job or model run")
  }
  const assertCurrentPublicationIdentity = (): void => {
    const latest_job_dir = input.job_store.getJobDir(input.job_id)
    const latest_model_dir = input.model_run_store.getModelDir(input.model_run_id)
    const latest_model_run = input.model_run_store.getModelRun(input.model_run_id)
    const identity_errors = [
      input.prepared.commit.model_run_id === input.model_run_id
        ? undefined
        : "prepared publication model_run_id is stale",
      input.prepared.commit.job_id === input.job_id
        ? undefined
        : "prepared publication belongs to a different job",
      input.prepared.commit.invocation_id === latest_model_run?.current_invocation_id
        ? undefined
        : "prepared publication invocation_id is no longer current",
      latest_model_run?.job_id === input.job_id ? undefined : "model run belongs to a different job",
      latest_job_dir && resolve(latest_job_dir) === resolve(input.job_dir)
        ? undefined
        : "job workspace identity changed",
      latest_model_dir && resolve(latest_model_dir) === resolve(input.model_dir)
        ? undefined
        : "model workspace identity changed",
    ].filter((error): error is string => Boolean(error))
    if (identity_errors.length > 0) {
      throw new Error(`Cannot commit a stale prepared model publication: ${identity_errors.join("; ")}`)
    }
  }
  assertCurrentPublicationIdentity()
  const [
    wrapper_source,
    model_source,
    model_card,
    manifest_value,
    contract_value,
    plan_value,
    result_value,
    projection_value,
    circuit_value,
  ] = await Promise.all([
    readVerifiedPublicationArtifact({
      publication: resolved_publication,
      bundle: "published_component",
      relative_path: "index.circuit.tsx",
      max_bytes: 2 * 1024 * 1024,
    }).then((bytes) => new TextDecoder().decode(bytes)),
    readVerifiedPublicationArtifact({
      publication: resolved_publication,
      bundle: "accepted_model",
      relative_path: "model.lib",
      max_bytes: 2 * 1024 * 1024,
    }).then((bytes) => new TextDecoder().decode(bytes)),
    readVerifiedPublicationArtifact({
      publication: resolved_publication,
      bundle: "accepted_model",
      relative_path: "model-card.md",
      max_bytes: 2 * 1024 * 1024,
    }).then((bytes) => new TextDecoder().decode(bytes)),
    readVerifiedPublicationArtifact({
      publication: resolved_publication,
      bundle: "accepted_model",
      relative_path: "model-manifest.json",
      max_bytes: 2 * 1024 * 1024,
    }).then((bytes) => JSON.parse(new TextDecoder().decode(bytes))),
    readVerifiedPublicationArtifact({
      publication: resolved_publication,
      bundle: "accepted_model",
      relative_path: "model-contract.json",
      max_bytes: 4 * 1024 * 1024,
    }).then((bytes) => JSON.parse(new TextDecoder().decode(bytes))),
    readVerifiedPublicationArtifact({
      publication: resolved_publication,
      bundle: "accepted_model",
      relative_path: "validation-plan.json",
      max_bytes: 8 * 1024 * 1024,
    }).then((bytes) => JSON.parse(new TextDecoder().decode(bytes))),
    readVerifiedPublicationArtifact({
      publication: resolved_publication,
      bundle: "accepted_model",
      relative_path: "validation-results.json",
      max_bytes: 32 * 1024 * 1024,
    }).then((bytes) => JSON.parse(new TextDecoder().decode(bytes))),
    readVerifiedPublicationArtifact({
      publication: resolved_publication,
      bundle: "accepted_model",
      relative_path: "model-ui.json",
      max_bytes: 16 * 1024 * 1024,
    }).then((bytes) => JSON.parse(new TextDecoder().decode(bytes))),
    readVerifiedPublicationArtifact({
      publication: resolved_publication,
      bundle: "published_component",
      relative_path: "component.circuit.json",
      max_bytes: 16 * 1024 * 1024,
    }).then((bytes) => JSON.parse(new TextDecoder().decode(bytes))),
  ])
  const completion_integrity = requireModelCompletionIntegrity({
    model_source,
    manifest: manifest_value,
    contract: contract_value,
    plan: plan_value,
    result: result_value,
    policy: "fresh_time_voltage_v1",
  })
  const authoritative_generated: GeneratedModel = {
    source: model_source,
    card: model_card,
    manifest: completion_integrity.manifest,
  }
  const authoritative_plan = completion_integrity.plan
  const authoritative_projection = projection_value as PreparedModelPublication["projection"]
  const published_circuit = selectPreferredComponentCircuitJson(circuit_value)
  if (!published_circuit) throw new Error("Published component bundle contains invalid Circuit JSON")
  const stale_inputs = [
    persistedIdentity(input.generated) === persistedIdentity(authoritative_generated)
      ? undefined
      : "generated model",
    persistedIdentity(input.plan) === persistedIdentity(authoritative_plan) ? undefined : "validation plan",
    persistedIdentity(input.circuit_json) === persistedIdentity(published_circuit)
      ? undefined
      : "integrated Circuit JSON",
    persistedIdentity(input.prepared.projection) === persistedIdentity(authoritative_projection)
      ? undefined
      : "UI projection",
  ].filter((value): value is string => Boolean(value))
  if (stale_inputs.length > 0) {
    throw new Error(
      `Cannot commit prepared publication because caller state differs from its validated bundle: ${stale_inputs.join(", ")}`,
    )
  }
  const first_preview: ModelSelectedPreview | undefined = authoritative_plan.cases[0]
    ? authoritative_projection.selected_previews[authoritative_plan.cases[0].id]
    : undefined
  const retained_warnings = withoutRetainedAcceptedWarning(current_model_run.warnings)
  const model_files = [
    "model.lib",
    "model-card.md",
    "model-manifest.json",
    "model-contract.json",
    "model-characterization.json",
    "validation-plan.json",
    "validation-results.json",
    "model-ui.json",
    "component-with-model.circuit.tsx",
    "component-with-model.circuit.json",
  ]
  input.signal.throwIfAborted()
  assertCurrentPublicationIdentity()
  // This atomic pointer is the irreversible commit barrier. All following
  // operations are recoverable live-view or legacy-root synchronization.
  const post_commit_warnings: string[] = []
  const pointer_commit = commitModelPublication(input.job_dir, input.job_id, input.prepared.commit)
  if (pointer_commit.durability_warning) {
    post_commit_warnings.push(
      `The accepted publication pointer is visible, but crash durability could not be confirmed: ${pointer_commit.durability_warning}`,
    )
  }
  try {
    const projection_result = input.job_store.projectCommittedPublication(input.job_id, {
      component_code: wrapper_source,
      circuit_json: published_circuit,
    })
    if (projection_result.checkpoint_error) {
      post_commit_warnings.push(
        `The accepted publication is durable, but its compatibility job checkpoint could not be refreshed: ${projection_result.checkpoint_error}`,
      )
    }
  } catch (error) {
    post_commit_warnings.push(
      `The accepted publication is durable, but the live job view could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  try {
    const projection_result = input.model_run_store.projectCommittedPublication(input.model_run_id, {
      update: {
        development_model: {
          model_source: authoritative_generated.source,
          model_card: authoritative_generated.card,
          manifest: authoritative_generated.manifest,
        },
        model_source: authoritative_generated.source,
        model_card: authoritative_generated.card,
        manifest: authoritative_generated.manifest,
        validation: authoritative_projection.validation,
        warnings: retained_warnings,
      },
      preview_options: authoritative_projection.preview_options,
      previews: {
        circuit_preview: first_preview?.circuit_preview,
        reference_preview: first_preview?.reference_preview,
      },
    })
    if (projection_result.checkpoint_error) {
      post_commit_warnings.push(
        `The accepted publication is durable, but its compatibility model checkpoint could not be refreshed: ${projection_result.checkpoint_error}`,
      )
    }
  } catch (error) {
    post_commit_warnings.push(
      `The accepted publication is durable, but the live model view could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const mirror_results = await Promise.allSettled([
    ...model_files.map((source) =>
      promoteStageFile({
        workspace: input.prepared.accepted_model_dir,
        source,
        destination_root: input.model_dir,
      }),
    ),
    promoteStageDirectory({
      workspace: input.prepared.accepted_model_dir,
      source: "evidence",
      destination_root: input.model_dir,
      required: false,
      max_files: 64,
      max_total_bytes: 64 * 1024 * 1024,
      validate_file: validatePngArtifact,
    }),
    promoteStageDirectory({
      workspace: input.prepared.accepted_model_dir,
      source: "validation",
      destination_root: input.model_dir,
      max_files: 64,
      max_total_bytes: 8 * 1024 * 1024,
    }),
    promoteStageFile({
      workspace: input.prepared.published_component_dir,
      source: "index.circuit.tsx",
      destination_root: input.job_dir,
    }),
    promoteStageFile({
      workspace: input.prepared.published_component_dir,
      source: "model.lib",
      destination_root: input.job_dir,
    }),
  ])
  const mirror_warnings = mirror_results.flatMap((result) =>
    result.status === "rejected"
      ? [
          `Accepted publication committed, but a legacy root-file mirror failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        ]
      : [],
  )
  post_commit_warnings.push(...mirror_warnings)
  if (post_commit_warnings.length > 0) {
    try {
      input.model_run_store.projectCommittedPublication(input.model_run_id, {
        update: { warnings: [...retained_warnings, ...post_commit_warnings] },
        preview_options: authoritative_projection.preview_options,
        previews: {
          circuit_preview: first_preview?.circuit_preview,
          reference_preview: first_preview?.reference_preview,
        },
      })
    } catch {
      // Restart recovery reconstructs both live views from the committed pair.
    }
  }
  return post_commit_warnings
}

export async function commitPreparedModelPublication(
  input: Parameters<typeof commitPreparedModelPublicationWithoutCleanup>[0],
): Promise<string[]> {
  try {
    return await commitPreparedModelPublicationWithoutCleanup(input)
  } catch (error) {
    // A rejected commit is still before the pointer barrier. If an unexpected
    // post-pointer error ever reaches this wrapper, the pointer lookup in the
    // discard helper protects the selected generation from deletion.
    await discardPreparedModelPublication(input.prepared)
    throw error
  }
}
