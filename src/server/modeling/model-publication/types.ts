import type { FRESH_MODEL_PUBLICATION_POLICY } from "./constants"

export type ModelPublicationPolicy = typeof FRESH_MODEL_PUBLICATION_POLICY

export interface ModelPublicationCommit {
  version: 3
  publication_policy: ModelPublicationPolicy
  publication_id: string
  job_id: string
  model_run_id: string
  invocation_id: string
  revision: string
  accepted_bundle_manifest_sha256: string
  published_component_bundle_manifest_sha256: string
  accepted_model_directory: string
  published_component_directory: string
  published_at: string
}

export interface LegacyModelPublicationCommitV2 {
  version: 2
  publication_id: string
  job_id: string
  model_run_id: string
  invocation_id: string
  revision: string
  accepted_bundle_manifest_sha256: string
  published_component_bundle_manifest_sha256: string
  accepted_model_directory: string
  published_component_directory: string
  published_at: string
}

export type ReadableModelPublicationCommit = ModelPublicationCommit | LegacyModelPublicationCommitV2

export type ModelPublicationRecord = Omit<
  ModelPublicationCommit,
  "accepted_bundle_manifest_sha256" | "published_component_bundle_manifest_sha256"
>

export interface PublicationBundleManifest {
  version: 1
  files: Readonly<Record<string, Readonly<{ size_bytes: number; sha256: string }>>>
}

export interface ResolvedModelPublication {
  commit: ReadableModelPublicationCommit
  accepted_model_dir: string
  published_component_dir: string
  accepted_bundle_manifest: PublicationBundleManifest
  published_component_bundle_manifest: PublicationBundleManifest
}

export type ModelPublicationBundle = "accepted_model" | "published_component"
