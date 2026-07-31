import { copyFile, mkdir, readFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import type { ModelManifest, ModelProgressPhase, ModelSelectedPreview } from "@/shared/job-types"
import { RETAINED_ACCEPTED_WARNING_PREFIX } from "@/shared/model-warnings"
import type { PipelineArtifact } from "@/shared/pipeline-types"
import { selectPreferredComponentCircuitJson } from "../component-circuit-json"
import {
  createStageWorkspace,
  promoteStageDirectory,
  promoteStageFile,
  validatePngArtifact,
} from "../infrastructure/artifacts"
import type { JobStore } from "../job-store"
import { createPipelineArtifact } from "../pipeline"
import type { ModelRunStore } from "../model-run-store"
import {
  commitModelPublication,
  projectModelUi,
  readVerifiedPublicationArtifact,
  type GeneratedModel,
  type ModelContract,
  type ModelPublicationCommit,
  type ModelPublicationRecord,
  validateResolvedModelPublication,
  writePublicationBundleManifest,
} from "../modeling"
import { stableStringify, type ValidationPlan, type ValidationRunResult } from "../spice-validation"

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"))
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`)
}

function persistedIdentity(value: unknown): string {
  return stableStringify(JSON.parse(JSON.stringify(value)))
}

export async function modelArtifact(input: {
  id: string
  path: string
  media_type: string
  role: string
}): Promise<PipelineArtifact> {
  return createPipelineArtifact({
    artifact_id: input.id,
    path: input.path,
    media_type: input.media_type,
    role: input.role,
  })
}

export async function appendModelLog(
  store: ModelRunStore,
  model_run_id: string,
  stream: "system" | "stdout" | "stderr",
  message: string,
): Promise<void> {
  await store.appendLog(model_run_id, { stream, message })
}

export function updateModelProgress(input: {
  store: ModelRunStore
  model_run_id: string
  phase: ModelProgressPhase
  message: string
  iteration?: number
}): void {
  const current = input.store.getModelRun(input.model_run_id)
  input.store.updateProgress(input.model_run_id, {
    sequence: (current?.progress?.sequence ?? 0) + 1,
    phase: input.phase,
    message: input.message,
    updated_at: new Date().toISOString(),
    ...(input.iteration === undefined ? {} : { iteration: input.iteration }),
  })
}

export function modeledRequirementIds(contract: ModelContract): string[] {
  return contract.characterization.requirements.flatMap(({ requirement_id, support }) =>
    support.status === "modeled" ? [requirement_id] : [],
  )
}

export async function persistCandidateValidationUi(input: {
  plan: ValidationPlan
  result: ValidationRunResult
  generated: GeneratedModel
  immutable_artifact_dir: string
}): Promise<void> {
  const updated_at = new Date().toISOString()
  const projection = projectModelUi({
    plan: input.plan,
    result: input.result,
    manifest: input.generated.manifest,
    model_source: input.generated.source,
    model_card: input.generated.card,
    updated_at,
  })
  await mkdir(input.immutable_artifact_dir, { recursive: true })
  await Promise.all([
    writeJson(join(input.immutable_artifact_dir, "validation-results.json"), input.result),
    writeJson(join(input.immutable_artifact_dir, "model-ui.json"), projection),
  ])
}

export interface PreparedModelPublication {
  commit: ModelPublicationCommit
  accepted_model_dir: string
  published_component_dir: string
  projection: ReturnType<typeof projectModelUi>
}

export async function prepareModelPublication(input: {
  job_id: string
  job_dir: string
  model_dir: string
  model_run_id: string
  invocation_id: string
  contract: ModelContract
  plan: ValidationPlan
  result: ValidationRunResult
  generated: GeneratedModel
  evidence_dir: string
  wrapper_source: string
  circuit_json: AnyCircuitElement[]
}): Promise<PreparedModelPublication> {
  if (!input.result.passed) throw new Error("Only a passing validation result can be published")
  const published_at = new Date().toISOString()
  const publication_id = crypto.randomUUID()
  const snapshot_id = `${input.generated.manifest.revision}-${publication_id}`
  const accepted_model_directory = `spice/accepted-revisions/${snapshot_id}`
  const published_component_directory = `published-models/${snapshot_id}`
  const accepted_model_dir = join(input.job_dir, accepted_model_directory)
  const published_component_dir = join(input.job_dir, published_component_directory)
  const publication_record: ModelPublicationRecord = {
    version: 2,
    publication_id,
    job_id: input.job_id,
    model_run_id: input.model_run_id,
    invocation_id: input.invocation_id,
    revision: input.generated.manifest.revision,
    accepted_model_directory,
    published_component_directory,
    published_at,
  }
  let accepted_bundle_manifest_sha256 = ""
  let published_component_bundle_manifest_sha256 = ""
  const projection = projectModelUi({
    plan: input.plan,
    result: input.result,
    manifest: input.generated.manifest,
    model_source: input.generated.source,
    model_card: input.generated.card,
    updated_at: published_at,
  })
  const preserved_component = join(input.job_dir, "component.circuit.tsx")
  if (!(await Bun.file(preserved_component).exists())) {
    await copyFile(join(input.job_dir, "index.circuit.tsx"), preserved_component)
  }

  const workspace = await createStageWorkspace({ prefix: "model-publication", files: [] })
  try {
    const accepted_bundle = join(workspace.path, "accepted")
    const component_bundle = join(workspace.path, "component")
    const cases_dir = join(accepted_bundle, "validation", "cases")
    await Promise.all([
      mkdir(accepted_bundle, { recursive: true }),
      mkdir(component_bundle, { recursive: true }),
      mkdir(cases_dir, { recursive: true }),
    ])
    await promoteStageDirectory({
      workspace: dirname(input.evidence_dir),
      source: basename(input.evidence_dir),
      destination_root: accepted_bundle,
      destination: "evidence",
      required: false,
      max_files: 64,
      max_total_bytes: 32 * 1024 * 1024,
      validate_file: validatePngArtifact,
    })
    await Promise.all([
      Bun.write(join(accepted_bundle, "model.lib"), input.generated.source),
      Bun.write(join(accepted_bundle, "model-card.md"), input.generated.card),
      writeJson(join(accepted_bundle, "model-manifest.json"), input.generated.manifest),
      writeJson(join(accepted_bundle, "model-contract.json"), input.contract),
      writeJson(join(accepted_bundle, "model-characterization.json"), input.contract.characterization),
      writeJson(join(accepted_bundle, "validation-plan.json"), input.plan),
      writeJson(join(accepted_bundle, "validation-results.json"), input.result),
      writeJson(join(accepted_bundle, "model-ui.json"), projection),
      Bun.write(join(accepted_bundle, "component-with-model.circuit.tsx"), input.wrapper_source),
      writeJson(join(accepted_bundle, "component-with-model.circuit.json"), input.circuit_json),
      writeJson(join(accepted_bundle, "publication-record.json"), publication_record),
      Bun.write(join(component_bundle, "index.circuit.tsx"), input.wrapper_source),
      Bun.write(join(component_bundle, "model.lib"), input.generated.source),
      writeJson(join(component_bundle, "component.circuit.json"), input.circuit_json),
      writeJson(join(component_bundle, "publication-record.json"), publication_record),
      ...Object.entries(projection.selected_previews).flatMap(([case_id, preview]) => {
        const writes: Promise<unknown>[] = [writeJson(join(cases_dir, `${case_id}.preview.json`), preview)]
        if (preview.circuit_preview?.code) {
          writes.push(Bun.write(join(cases_dir, `${case_id}.circuit.tsx`), preview.circuit_preview.code))
        }
        return writes
      }),
    ])
    ;[accepted_bundle_manifest_sha256, published_component_bundle_manifest_sha256] = await Promise.all([
      writePublicationBundleManifest(accepted_bundle),
      writePublicationBundleManifest(component_bundle),
    ])
    await Promise.all([
      promoteStageDirectory({
        workspace: workspace.path,
        source: "accepted",
        destination_root: input.model_dir,
        destination: join("accepted-revisions", snapshot_id),
        max_files: 256,
        max_total_bytes: 64 * 1024 * 1024,
      }),
      promoteStageDirectory({
        workspace: workspace.path,
        source: "component",
        destination_root: input.job_dir,
        destination: join("published-models", snapshot_id),
        max_files: 8,
        max_total_bytes: 8 * 1024 * 1024,
      }),
    ])
  } finally {
    await workspace.dispose()
  }

  return {
    commit: {
      ...publication_record,
      accepted_bundle_manifest_sha256,
      published_component_bundle_manifest_sha256,
    },
    accepted_model_dir,
    published_component_dir,
    projection,
  }
}

function withoutRetainedAcceptedWarning(warnings: readonly string[] | undefined): string[] {
  return (warnings ?? []).filter((warning) => !warning.startsWith(RETAINED_ACCEPTED_WARNING_PREFIX))
}

export async function commitPreparedModelPublication(input: {
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
    plan_value,
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
      relative_path: "validation-plan.json",
      max_bytes: 8 * 1024 * 1024,
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
  const authoritative_generated: GeneratedModel = {
    source: model_source,
    card: model_card,
    manifest: manifest_value as ModelManifest,
  }
  const authoritative_plan = plan_value as ValidationPlan
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
  commitModelPublication(input.job_dir, input.job_id, input.prepared.commit)
  const post_commit_warnings: string[] = []
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
      max_total_bytes: 32 * 1024 * 1024,
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

export function validationFailureFeedback(result: ValidationRunResult): string {
  const lines = result.cases.flatMap((validation_case) => {
    if (validation_case.status === "passed") return []
    const case_errors = validation_case.errors.map(
      ({ code, message, path }) =>
        `${validation_case.case_id}: ${code}${path ? ` at ${path}` : ""}: ${message}`,
    )
    const series_errors = validation_case.series.flatMap((series) =>
      series.passed
        ? []
        : [
            `${validation_case.case_id}/${series.observation_id}: metrics=${JSON.stringify(series.metrics)}; ` +
              `${series.errors.map(({ code, message }) => `${code}: ${message}`).join("; ") || "comparison failed"}`,
          ],
    )
    return [...case_errors, ...series_errors]
  })
  for (const error of result.errors) {
    lines.push(`${error.code}${error.path ? ` at ${error.path}` : ""}: ${error.message}`)
  }
  return [...new Set(lines)].join("\n").slice(0, 14_000) || "Validation did not pass."
}
