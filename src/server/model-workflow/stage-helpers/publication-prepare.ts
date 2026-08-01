import { copyFile, mkdir, readFile, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import {
  createStageWorkspace,
  promoteStageDirectory,
  promoteStageFile,
  validatePngArtifact,
} from "../../infrastructure/artifacts"
import type { ProcessRunner } from "../../infrastructure/process"
import {
  assertValidationCircuitEmbedsModel,
  FRESH_MODEL_PUBLICATION_POLICY,
  type GeneratedModel,
  type ModelContract,
  type ModelPublicationCommit,
  type ModelPublicationRecord,
  projectModelUi,
  readModelPublication,
  recompileApplicationFixtureContractFromSources,
  requireModelCompletionIntegrity,
  validateViewerSimulation,
  writePublicationBundleManifest,
} from "../../modeling"
import { stableStringify, type ValidationPlan, type ValidationRunResult } from "../../spice-validation"
import {
  MODEL_REFERENCE_TRACE_FILES,
  modelContractRequiresReferencePublicationProof,
  revalidateModelReferencePublication,
} from "../model-reference-publication"
import { preflightModelPublicationUi } from "../publication-ui-preflight"
import { writeViewerValidationArtifacts } from "../viewer-validation-artifacts"
import { writeJson } from "./basic"

export interface PreparedModelPublication {
  commit: ModelPublicationCommit
  job_dir: string
  accepted_model_dir: string
  published_component_dir: string
  projection: ReturnType<typeof projectModelUi>
}

async function retainModelReferenceTrace(input: {
  evidence_dir: string
  accepted_bundle: string
  required: boolean
  signal?: AbortSignal
}): Promise<void> {
  const characterization_dir = dirname(input.evidence_dir)
  await Promise.all(
    MODEL_REFERENCE_TRACE_FILES.map(async (file) => {
      if (!(await Bun.file(join(characterization_dir, file)).exists())) {
        if (input.required) {
          throw new Error(`Fresh waveform publication requires retained ${file} beside evidence/`)
        }
        return
      }
      await promoteStageFile({
        workspace: characterization_dir,
        source: file,
        destination_root: input.accepted_bundle,
        max_bytes: 4 * 1024 * 1024,
        signal: input.signal,
      })
    }),
  )
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
  circuit_json_by_case?: Readonly<Record<string, AnyCircuitElement[] | undefined>>
  process_runner?: ProcessRunner
  signal?: AbortSignal
}): Promise<PreparedModelPublication> {
  input.signal?.throwIfAborted()
  const completion_integrity = requireModelCompletionIntegrity({
    model_source: input.generated.source,
    manifest: input.generated.manifest,
    contract: input.contract,
    plan: input.plan,
    result: input.result,
    policy: "fresh_time_voltage_v1",
  })
  const canonical_datasheet_bytes = await readFile(join(input.model_dir, "datasheet.pdf"))
  const application_source_artifacts = completion_integrity.contract.application_fixture
    ? await (async () => {
        const [source_plan_bytes, source_evidence_bytes, standalone_bytes] = await Promise.all([
          readFile(join(input.model_dir, "typical-application-plan.json")),
          readFile(join(input.model_dir, "component-evidence.json")),
          readFile(join(input.model_dir, "application-fixture-contract.json")),
        ])
        let standalone_contract: unknown
        try {
          standalone_contract = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(standalone_bytes),
          ) as unknown
        } catch (error) {
          throw new Error("application-fixture-contract.json must be valid UTF-8 JSON", {
            cause: error,
          })
        }
        recompileApplicationFixtureContractFromSources({
          source_plan_bytes,
          source_pdf_bytes: canonical_datasheet_bytes,
          source_evidence_bytes,
          model_interface: completion_integrity.contract.interface,
          standalone_contract,
          embedded_contract: completion_integrity.contract.application_fixture,
        })
        return {
          source_plan_bytes,
          source_evidence_bytes,
          standalone_bytes,
        }
      })()
    : undefined
  const contract_requires_reference_proof = modelContractRequiresReferencePublicationProof(
    completion_integrity.contract,
  )
  if (!contract_requires_reference_proof) {
    throw new Error(
      "Fresh model workflow publication cannot downgrade to scalar, operating-point, DC-sweep, or ungrounded model evidence",
    )
  }
  const reference_proof_required = true
  if (!input.circuit_json_by_case) {
    throw new Error(
      "Fresh waveform publication requires retained tscircuit Circuit JSON for every validation case",
    )
  }
  const expected_case_ids = input.plan.cases.map(({ id }) => id).sort()
  const actual_case_ids = Object.entries(input.circuit_json_by_case)
    .flatMap(([case_id, circuit_json]) => (circuit_json === undefined ? [] : [case_id]))
    .sort()
  if (stableStringify(actual_case_ids) !== stableStringify(expected_case_ids)) {
    throw new Error(
      `Fresh waveform publication requires the exact validation case set in Circuit JSON (expected ${expected_case_ids.join(", ") || "none"}; received ${actual_case_ids.join(", ") || "none"})`,
    )
  }
  for (const validation_case of input.plan.cases) {
    const circuit_json = input.circuit_json_by_case[validation_case.id]
    if (!circuit_json) {
      throw new Error(
        `Fresh waveform publication is missing tscircuit Circuit JSON for ${validation_case.id}`,
      )
    }
    assertValidationCircuitEmbedsModel(circuit_json, input.generated.source, input.generated.manifest)
    const viewer_validation = validateViewerSimulation({ validation_case, circuit_json })
    if (!viewer_validation.passed) {
      throw new Error(
        `Fresh waveform publication rejected tscircuit graph ${validation_case.id}: ${viewer_validation.errors
          .map(({ code, message }) => `${code}: ${message}`)
          .join("; ")}`,
      )
    }
  }
  const published_at = new Date().toISOString()
  const publication_id = crypto.randomUUID()
  const snapshot_id = `${input.generated.manifest.revision}-${publication_id}`
  const accepted_model_directory = `spice/accepted-revisions/${snapshot_id}`
  const published_component_directory = `published-models/${snapshot_id}`
  const accepted_model_dir = join(input.job_dir, accepted_model_directory)
  const published_component_dir = join(input.job_dir, published_component_directory)
  const publication_record: ModelPublicationRecord = {
    version: 3,
    publication_policy: FRESH_MODEL_PUBLICATION_POLICY,
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
    circuit_json_by_case: input.circuit_json_by_case,
    contract: input.contract,
    validation_artifact_state: "accepted",
    preview_generation: snapshot_id,
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
      required: reference_proof_required,
      max_files: 64,
      max_total_bytes: 64 * 1024 * 1024,
      validate_file: validatePngArtifact,
    })
    await retainModelReferenceTrace({
      evidence_dir: input.evidence_dir,
      accepted_bundle,
      required: reference_proof_required,
      signal: input.signal,
    })
    await Bun.write(join(accepted_bundle, "datasheet.pdf"), canonical_datasheet_bytes)
    await revalidateModelReferencePublication({
      contract: completion_integrity.contract,
      datasheet_path: join(accepted_bundle, "datasheet.pdf"),
      evidence_dir: join(accepted_bundle, "evidence"),
      process_runner: input.process_runner,
      signal: input.signal,
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
      writeJson(join(accepted_bundle, "model-workflow-policy.json"), {
        version: 1,
        policy: FRESH_MODEL_PUBLICATION_POLICY,
      }),
      ...(application_source_artifacts
        ? [
            Bun.write(
              join(accepted_bundle, "typical-application-plan.json"),
              application_source_artifacts.source_plan_bytes,
            ),
            Bun.write(
              join(accepted_bundle, "component-evidence.json"),
              application_source_artifacts.source_evidence_bytes,
            ),
            Bun.write(
              join(accepted_bundle, "application-fixture-contract.json"),
              application_source_artifacts.standalone_bytes,
            ),
          ]
        : []),
      Bun.write(join(component_bundle, "index.circuit.tsx"), input.wrapper_source),
      Bun.write(join(component_bundle, "model.lib"), input.generated.source),
      writeJson(join(component_bundle, "component.circuit.json"), input.circuit_json),
      writeJson(join(component_bundle, "publication-record.json"), publication_record),
      writeJson(join(component_bundle, "model-workflow-policy.json"), {
        version: 1,
        policy: FRESH_MODEL_PUBLICATION_POLICY,
      }),
      ...Object.entries(projection.selected_previews).flatMap(([case_id, preview]) => {
        const writes: Promise<unknown>[] = [writeJson(join(cases_dir, `${case_id}.preview.json`), preview)]
        if (preview.circuit_preview?.code) {
          writes.push(Bun.write(join(cases_dir, `${case_id}.circuit.tsx`), preview.circuit_preview.code))
        }
        return writes
      }),
    ])
    if (input.circuit_json_by_case) {
      await writeViewerValidationArtifacts({
        validation_dir: join(accepted_bundle, "validation"),
        plan: input.plan,
        generated: input.generated,
        circuit_json_by_case: input.circuit_json_by_case,
      })
    }
    await preflightModelPublicationUi({
      accepted_bundle,
      plan: completion_integrity.plan,
      projection,
      fresh: true,
    })
    input.signal?.throwIfAborted()
    ;[accepted_bundle_manifest_sha256, published_component_bundle_manifest_sha256] = await Promise.all([
      writePublicationBundleManifest(accepted_bundle),
      writePublicationBundleManifest(component_bundle),
    ])
    input.signal?.throwIfAborted()
    const promotions = await Promise.allSettled([
      promoteStageDirectory({
        workspace: workspace.path,
        source: "accepted",
        destination_root: input.model_dir,
        destination: join("accepted-revisions", snapshot_id),
        max_files: 256,
        max_total_bytes: 128 * 1024 * 1024,
        signal: input.signal,
      }),
      promoteStageDirectory({
        workspace: workspace.path,
        source: "component",
        destination_root: input.job_dir,
        destination: join("published-models", snapshot_id),
        max_files: 8,
        max_total_bytes: 8 * 1024 * 1024,
        signal: input.signal,
      }),
    ])
    const promotion_failures = promotions.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    )
    if (promotion_failures.length > 0) {
      throw new AggregateError(
        promotion_failures,
        "Prepared model publication did not materialize both immutable bundles",
      )
    }
  } catch (error) {
    await Promise.all([
      rm(accepted_model_dir, { recursive: true, force: true }).catch(() => undefined),
      rm(published_component_dir, { recursive: true, force: true }).catch(() => undefined),
    ])
    throw error
  } finally {
    await workspace.dispose().catch(() => undefined)
  }

  return {
    commit: {
      ...publication_record,
      accepted_bundle_manifest_sha256,
      published_component_bundle_manifest_sha256,
    },
    job_dir: input.job_dir,
    accepted_model_dir,
    published_component_dir,
    projection,
  }
}

export async function discardPreparedModelPublication(prepared: PreparedModelPublication): Promise<void> {
  try {
    const current = await readModelPublication(prepared.job_dir, prepared.commit.job_id)
    if (current?.commit.publication_id === prepared.commit.publication_id) return
  } catch {
    // Preserve the generation when the current pointer cannot be classified.
    // It may be the only recoverable copy selected by a damaged checkpoint.
    return
  }
  await Promise.all([
    rm(prepared.accepted_model_dir, { recursive: true, force: true }).catch(() => undefined),
    rm(prepared.published_component_dir, { recursive: true, force: true }).catch(() => undefined),
  ])
}
