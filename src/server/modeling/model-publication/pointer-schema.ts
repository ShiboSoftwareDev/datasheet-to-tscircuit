import {
  ACCEPTED_MODEL_DIRECTORY_PATTERN,
  FRESH_MODEL_PUBLICATION_POLICY,
  INVOCATION_ID_PATTERN,
  JOB_ID_PATTERN,
  MODEL_PUBLICATION_FILE,
  PUBLICATION_ID_PATTERN,
  PUBLISHED_COMPONENT_DIRECTORY_PATTERN,
  REVISION_PATTERN,
  SHA256_PATTERN,
} from "./constants"
import { isRecord } from "./filesystem"
import type {
  LegacyModelPublicationCommitV2,
  ModelPublicationRecord,
  ReadableModelPublicationCommit,
} from "./types"

export function publicationRecord(
  commit: ReadableModelPublicationCommit,
):
  | ModelPublicationRecord
  | Omit<
      LegacyModelPublicationCommitV2,
      "accepted_bundle_manifest_sha256" | "published_component_bundle_manifest_sha256"
    > {
  const common = {
    publication_id: commit.publication_id,
    job_id: commit.job_id,
    model_run_id: commit.model_run_id,
    invocation_id: commit.invocation_id,
    revision: commit.revision,
    accepted_model_directory: commit.accepted_model_directory,
    published_component_directory: commit.published_component_directory,
    published_at: commit.published_at,
  }
  return commit.version === 3
    ? {
        version: 3,
        publication_policy: commit.publication_policy,
        ...common,
      }
    : { version: 2, ...common }
}

export function parseModelPublication(value: unknown): ReadableModelPublicationCommit {
  if (!isRecord(value) || (value.version !== 2 && value.version !== 3)) {
    throw new Error(`${MODEL_PUBLICATION_FILE} has an unsupported version; expected version 2 or 3`)
  }
  const expected_keys = [
    "accepted_model_directory",
    "accepted_bundle_manifest_sha256",
    "invocation_id",
    "job_id",
    "model_run_id",
    "publication_id",
    "published_at",
    "published_component_bundle_manifest_sha256",
    "published_component_directory",
    "revision",
    "version",
    ...(value.version === 3 ? ["publication_policy"] : []),
  ].sort()
  const actual_keys = Object.keys(value).sort()
  if (JSON.stringify(actual_keys) !== JSON.stringify(expected_keys)) {
    throw new Error(`${MODEL_PUBLICATION_FILE} contains unexpected or missing fields`)
  }
  if (typeof value.publication_id !== "string" || !PUBLICATION_ID_PATTERN.test(value.publication_id)) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.publication_id is invalid`)
  }
  if (typeof value.revision !== "string" || !REVISION_PATTERN.test(value.revision)) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.revision is invalid`)
  }
  if (typeof value.job_id !== "string" || !JOB_ID_PATTERN.test(value.job_id)) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.job_id is invalid`)
  }
  if (
    typeof value.model_run_id !== "string" ||
    !value.model_run_id.trim() ||
    value.model_run_id.length > 200
  ) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.model_run_id is invalid`)
  }
  if (typeof value.invocation_id !== "string" || !INVOCATION_ID_PATTERN.test(value.invocation_id)) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.invocation_id is invalid`)
  }
  if (
    typeof value.accepted_bundle_manifest_sha256 !== "string" ||
    !SHA256_PATTERN.test(value.accepted_bundle_manifest_sha256)
  ) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.accepted_bundle_manifest_sha256 is invalid`)
  }
  if (
    typeof value.published_component_bundle_manifest_sha256 !== "string" ||
    !SHA256_PATTERN.test(value.published_component_bundle_manifest_sha256)
  ) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.published_component_bundle_manifest_sha256 is invalid`)
  }
  if (
    typeof value.accepted_model_directory !== "string" ||
    !ACCEPTED_MODEL_DIRECTORY_PATTERN.test(value.accepted_model_directory)
  ) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.accepted_model_directory is invalid`)
  }
  if (
    typeof value.published_component_directory !== "string" ||
    !PUBLISHED_COMPONENT_DIRECTORY_PATTERN.test(value.published_component_directory)
  ) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.published_component_directory is invalid`)
  }
  if (typeof value.published_at !== "string" || !Number.isFinite(Date.parse(value.published_at))) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.published_at must be an ISO timestamp`)
  }
  if (value.version === 3 && value.publication_policy !== FRESH_MODEL_PUBLICATION_POLICY) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.publication_policy must be ${FRESH_MODEL_PUBLICATION_POLICY}`)
  }
  const snapshot_id = `${value.revision}-${value.publication_id}`
  if (value.accepted_model_directory !== `spice/accepted-revisions/${snapshot_id}`) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.accepted_model_directory does not match its revision`)
  }
  if (value.published_component_directory !== `published-models/${snapshot_id}`) {
    throw new Error(`${MODEL_PUBLICATION_FILE}.published_component_directory does not match its revision`)
  }
  const common = {
    publication_id: value.publication_id,
    job_id: value.job_id,
    model_run_id: value.model_run_id,
    invocation_id: value.invocation_id,
    revision: value.revision,
    accepted_bundle_manifest_sha256: value.accepted_bundle_manifest_sha256,
    published_component_bundle_manifest_sha256: value.published_component_bundle_manifest_sha256,
    accepted_model_directory: value.accepted_model_directory,
    published_component_directory: value.published_component_directory,
    published_at: value.published_at,
  }
  return value.version === 3
    ? {
        version: 3,
        publication_policy: FRESH_MODEL_PUBLICATION_POLICY,
        ...common,
      }
    : { version: 2, ...common }
}

export function assertPublicationOwnership(
  commit: ReadableModelPublicationCommit,
  expected_job_id: string,
): void {
  if (commit.job_id !== expected_job_id) {
    throw new Error(
      `${MODEL_PUBLICATION_FILE} belongs to job ${commit.job_id}, not expected job ${expected_job_id}`,
    )
  }
}
