export const PUBLICATION_ID_PATTERN = /^[a-f0-9-]{16,80}$/
export const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
export const REVISION_PATTERN = /^[a-f0-9]{16}$/
export const SHA256_PATTERN = /^[a-f0-9]{64}$/
export const INVOCATION_ID_PATTERN = /^[a-f0-9-]{16,80}$/
export const ACCEPTED_MODEL_DIRECTORY_PATTERN = /^spice\/accepted-revisions\/[a-f0-9-]{16,100}$/
export const PUBLISHED_COMPONENT_DIRECTORY_PATTERN = /^published-models\/[a-f0-9-]{16,100}$/
export const POINTER_BYTE_LIMIT = 64 * 1024
export const BUNDLE_MANIFEST_BYTE_LIMIT = 2 * 1024 * 1024
export const BUNDLE_FILE_LIMIT = 512
export const BUNDLE_DIRECTORY_LIMIT = 256
export const BUNDLE_DEPTH_LIMIT = 16
export const BUNDLE_BYTE_LIMIT = 128 * 1024 * 1024

export const MODEL_PUBLICATION_FILE = "published-model.json"
export const FRESH_MODEL_PUBLICATION_POLICY = "fresh_time_voltage_v1" as const
