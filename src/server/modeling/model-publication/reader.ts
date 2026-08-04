import { lstat, realpath } from "node:fs/promises"
import { join } from "node:path"
import { stableStringify } from "../../spice-validation/hashing"
import { recompileApplicationFixtureContractFromSources } from "../application-fixture-contract"
import { assertCircuitEmbedsModel, createIntegratedComponentSource } from "../component-integration"
import { createModelManifest } from "../model-artifacts"
import { requireModelCompletionIntegrity } from "../model-completion-integrity"
import { parseModelCharacterization } from "../parse-model-characterization"
import { parseModelContract } from "../parse-model-contract"
import { readVerifiedPublicationArtifact } from "./artifact-reader"
import { validatePublicationBundle } from "./bundle-manifest"
import { MODEL_PUBLICATION_FILE, POINTER_BYTE_LIMIT } from "./constants"
import { isInside, isRecord, readBoundedText, resolveInside } from "./filesystem"
import { assertPublicationOwnership, parseModelPublication, publicationRecord } from "./pointer-schema"
import type { ResolvedModelPublication } from "./types"

async function requireRealDirectory(input: {
  path: string
  label: string
  real_job_root: string
}): Promise<void> {
  const { path, label, real_job_root } = input
  const metadata = await lstat(path).catch(() => undefined)
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${MODEL_PUBLICATION_FILE} references a missing or unsafe ${label}`)
  }
  const real_directory = await realpath(path)
  if (!isInside(real_job_root, real_directory)) {
    throw new Error(`${MODEL_PUBLICATION_FILE} ${label} resolves outside the job workspace`)
  }
}

/** Reads the single commit point that binds a model snapshot to its owning job and wrapper. */
export async function readModelPublication(
  job_dir: string,
  expected_job_id: string,
): Promise<ResolvedModelPublication | undefined> {
  const pointer_path = join(job_dir, MODEL_PUBLICATION_FILE)
  const pointer_metadata = await lstat(pointer_path).catch((error) => {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return undefined
    }
    throw error
  })
  if (!pointer_metadata) return undefined
  if (!pointer_metadata.isFile() || pointer_metadata.isSymbolicLink()) {
    throw new Error(`${MODEL_PUBLICATION_FILE} must be a regular file and not a symlink`)
  }
  const value: unknown = JSON.parse(
    await readBoundedText(pointer_path, POINTER_BYTE_LIMIT, MODEL_PUBLICATION_FILE),
  )
  const commit = parseModelPublication(value)
  assertPublicationOwnership(commit, expected_job_id)
  const real_job_root = await realpath(job_dir)
  const accepted_model_dir = resolveInside(
    job_dir,
    commit.accepted_model_directory,
    "accepted model directory",
  )
  const published_component_dir = resolveInside(
    job_dir,
    commit.published_component_directory,
    "published component directory",
  )
  await Promise.all([
    requireRealDirectory({
      path: accepted_model_dir,
      label: "accepted model directory",
      real_job_root,
    }),
    requireRealDirectory({
      path: published_component_dir,
      label: "published component directory",
      real_job_root,
    }),
  ])
  return validateResolvedModelPublication(
    { commit, accepted_model_dir, published_component_dir },
    expected_job_id,
  )
}

export async function validateResolvedModelPublication(
  publication: Pick<ResolvedModelPublication, "commit" | "accepted_model_dir" | "published_component_dir">,
  expected_job_id: string,
): Promise<ResolvedModelPublication> {
  assertPublicationOwnership(publication.commit, expected_job_id)
  const [accepted_bundle_manifest, published_component_bundle_manifest] = await Promise.all([
    validatePublicationBundle(
      publication.accepted_model_dir,
      publication.commit.accepted_bundle_manifest_sha256,
    ),
    validatePublicationBundle(
      publication.published_component_dir,
      publication.commit.published_component_bundle_manifest_sha256,
    ),
  ])
  const resolved: ResolvedModelPublication = {
    ...publication,
    accepted_bundle_manifest,
    published_component_bundle_manifest,
  }
  const [
    accepted_source,
    published_source,
    accepted_wrapper_source,
    wrapper_source,
    accepted_circuit_text,
    circuit_text,
    contract_text,
    accepted_record_text,
    component_record_text,
  ] = await Promise.all([
    readVerifiedPublicationArtifact({
      publication: resolved,
      bundle: "accepted_model",
      relative_path: "model.lib",
      max_bytes: 2 * 1024 * 1024,
    }).then((bytes) => new TextDecoder().decode(bytes)),
    readVerifiedPublicationArtifact({
      publication: resolved,
      bundle: "published_component",
      relative_path: "model.lib",
      max_bytes: 2 * 1024 * 1024,
    }).then((bytes) => new TextDecoder().decode(bytes)),
    readVerifiedPublicationArtifact({
      publication: resolved,
      bundle: "accepted_model",
      relative_path: "component-with-model.circuit.tsx",
      max_bytes: 2 * 1024 * 1024,
    }).then((bytes) => new TextDecoder().decode(bytes)),
    readVerifiedPublicationArtifact({
      publication: resolved,
      bundle: "published_component",
      relative_path: "index.circuit.tsx",
      max_bytes: 2 * 1024 * 1024,
    }).then((bytes) => new TextDecoder().decode(bytes)),
    readVerifiedPublicationArtifact({
      publication: resolved,
      bundle: "accepted_model",
      relative_path: "component-with-model.circuit.json",
      max_bytes: 16 * 1024 * 1024,
    }).then((bytes) => new TextDecoder().decode(bytes)),
    readVerifiedPublicationArtifact({
      publication: resolved,
      bundle: "published_component",
      relative_path: "component.circuit.json",
      max_bytes: 16 * 1024 * 1024,
    }).then((bytes) => new TextDecoder().decode(bytes)),
    readVerifiedPublicationArtifact({
      publication: resolved,
      bundle: "accepted_model",
      relative_path: "model-contract.json",
      max_bytes: 4 * 1024 * 1024,
    }).then((bytes) => new TextDecoder().decode(bytes)),
    readVerifiedPublicationArtifact({
      publication: resolved,
      bundle: "accepted_model",
      relative_path: "publication-record.json",
      max_bytes: POINTER_BYTE_LIMIT,
    }).then((bytes) => new TextDecoder().decode(bytes)),
    readVerifiedPublicationArtifact({
      publication: resolved,
      bundle: "published_component",
      relative_path: "publication-record.json",
      max_bytes: POINTER_BYTE_LIMIT,
    }).then((bytes) => new TextDecoder().decode(bytes)),
  ])
  if (accepted_source !== published_source) {
    throw new Error(`${MODEL_PUBLICATION_FILE} model snapshots disagree`)
  }
  if (accepted_wrapper_source !== wrapper_source || accepted_circuit_text !== circuit_text) {
    throw new Error(`${MODEL_PUBLICATION_FILE} component snapshots disagree`)
  }
  const expected_record = publicationRecord(publication.commit)
  const accepted_record: unknown = JSON.parse(accepted_record_text)
  const component_record: unknown = JSON.parse(component_record_text)
  if (
    stableStringify(accepted_record) !== stableStringify(expected_record) ||
    stableStringify(component_record) !== stableStringify(expected_record)
  ) {
    throw new Error(`${MODEL_PUBLICATION_FILE} metadata does not match both published bundles`)
  }
  if (publication.commit.version === 3) {
    const expected_policy_marker = {
      version: 1,
      policy: publication.commit.publication_policy,
    }
    const [accepted_policy, component_policy] = await Promise.all(
      (["accepted_model", "published_component"] as const).map((bundle) =>
        readVerifiedPublicationArtifact({
          publication: resolved,
          bundle,
          relative_path: "model-workflow-policy.json",
          max_bytes: POINTER_BYTE_LIMIT,
        }).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown),
      ),
    )
    if (
      stableStringify(accepted_policy) !== stableStringify(expected_policy_marker) ||
      stableStringify(component_policy) !== stableStringify(expected_policy_marker)
    ) {
      throw new Error(`${MODEL_PUBLICATION_FILE} fresh workflow policy does not match both published bundles`)
    }
  }
  const circuit_value: unknown = JSON.parse(circuit_text)
  const contract_value: unknown = JSON.parse(contract_text)
  const contract = parseModelContract(contract_value)
  if (contract.application_fixture) {
    const [source_plan_bytes, source_pdf_bytes, source_evidence_bytes, standalone_bytes] = await Promise.all([
      readVerifiedPublicationArtifact({
        publication: resolved,
        bundle: "accepted_model",
        relative_path: "typical-application-plan.json",
        max_bytes: 4 * 1024 * 1024,
      }),
      readVerifiedPublicationArtifact({
        publication: resolved,
        bundle: "accepted_model",
        relative_path: "datasheet.pdf",
        max_bytes: 64 * 1024 * 1024,
      }),
      readVerifiedPublicationArtifact({
        publication: resolved,
        bundle: "accepted_model",
        relative_path: "component-evidence.json",
        max_bytes: 4 * 1024 * 1024,
      }),
      readVerifiedPublicationArtifact({
        publication: resolved,
        bundle: "accepted_model",
        relative_path: "application-fixture-contract.json",
        max_bytes: 4 * 1024 * 1024,
      }),
    ])
    let standalone_contract: unknown
    try {
      standalone_contract = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(standalone_bytes),
      ) as unknown
    } catch (error) {
      throw new Error(`${MODEL_PUBLICATION_FILE} application-fixture-contract.json is not valid UTF-8 JSON`, {
        cause: error,
      })
    }
    recompileApplicationFixtureContractFromSources({
      source_plan_bytes,
      source_pdf_bytes,
      source_evidence_bytes,
      model_interface: contract.interface,
      standalone_contract,
      embedded_contract: contract.application_fixture,
    })
  }
  if (publication.commit.version === 3) {
    const raw_contract = isRecord(contract_value) ? contract_value : undefined
    const characterization = parseModelCharacterization(raw_contract?.characterization, {
      policy: "fresh",
      reject_unknown_fields: true,
    })
    if (!characterization.requirements.some(({ support }) => support.status === "modeled")) {
      throw new Error(`${MODEL_PUBLICATION_FILE} fresh workflow contract has no modeled requirement`)
    }
    const [manifest_value, plan_value, result_value] = await Promise.all([
      readVerifiedPublicationArtifact({
        publication: resolved,
        bundle: "accepted_model",
        relative_path: "model-manifest.json",
        max_bytes: 2 * 1024 * 1024,
      }).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown),
      readVerifiedPublicationArtifact({
        publication: resolved,
        bundle: "accepted_model",
        relative_path: "validation-plan.json",
        max_bytes: 8 * 1024 * 1024,
      }).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown),
      readVerifiedPublicationArtifact({
        publication: resolved,
        bundle: "accepted_model",
        relative_path: "validation-results.json",
        max_bytes: 32 * 1024 * 1024,
      }).then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown),
    ])
    requireModelCompletionIntegrity({
      model_source: accepted_source,
      manifest: manifest_value,
      contract: contract_value,
      plan: plan_value,
      result: result_value,
      policy: "fresh_time_voltage_v1",
    })
  }
  const manifest = createModelManifest({
    model_interface: contract.interface,
    model_source: accepted_source,
    simulator: "ngspice",
  })
  if (manifest.revision !== publication.commit.revision) {
    throw new Error(`${MODEL_PUBLICATION_FILE} revision does not match the accepted model`)
  }
  if (wrapper_source !== createIntegratedComponentSource(manifest, accepted_source)) {
    throw new Error("Published wrapper is not the deterministic server-owned model integration")
  }
  assertCircuitEmbedsModel(circuit_value, accepted_source, contract.interface)
  return resolved
}
