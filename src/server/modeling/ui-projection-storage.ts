import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import type { ModelPreviewArtifactIdentity, ModelSelectedPreview } from "@/shared/job-types"
import {
  type ModelSelectedPreviewParseOptions,
  parseModelPreviewArtifactIdentity,
  parseModelSelectedPreview,
} from "@/shared/model-selected-preview"
import { readVerifiedPublicationArtifact, resolveAcceptedModelPublication } from "./model-publication"

export const MAX_STORED_MODEL_PREVIEW_BYTES = 2 * 1024 * 1024

/**
 * Serializes the exact payload shape written for both candidate and accepted
 * per-case previews. Publication preflight and the production API deliberately
 * share this byte boundary and parser so a selected bundle cannot be larger
 * than the UI endpoint is able to read.
 */
export function serializeStoredModelPreview(preview: ModelSelectedPreview): string {
  return `${JSON.stringify(preview, null, 2)}\n`
}

export function parseStoredModelPreviewBytes(
  bytes: Uint8Array,
  options: ModelSelectedPreviewParseOptions = {},
): ModelSelectedPreview {
  if (bytes.byteLength > MAX_STORED_MODEL_PREVIEW_BYTES) {
    throw new Error(
      `Stored model preview exceeds its ${MAX_STORED_MODEL_PREVIEW_BYTES}-byte production read limit`,
    )
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
  return parseModelSelectedPreview(value, options)
}

export async function loadStoredModelPreview(input: {
  job_id: string
  model_dir: string
  case_id: string
  prefer_current_preview?: boolean
  current_preview_generation?: string
  current_model_revision?: string
  /** A completed current pipeline crossed publish_model and may not use legacy mutable roots. */
  require_accepted_publication?: boolean
}): Promise<ModelSelectedPreview | undefined> {
  // Mirrors the validation-plan case-id grammar while rejecting path separators.
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.case_id)) return undefined
  if (
    input.require_accepted_publication &&
    (input.prefer_current_preview || input.current_preview_generation)
  ) {
    throw new Error("A committed accepted publication cannot select a mutable candidate preview")
  }
  const readLoosePreview = async (
    root: string,
    expected_artifact_identity?: ModelPreviewArtifactIdentity,
  ): Promise<ModelSelectedPreview | undefined> => {
    const preview_path = join(root, "cases", `${input.case_id}.preview.json`)
    let bytes: Uint8Array
    try {
      bytes = await readFile(preview_path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw new Error(`Stored model preview ${input.case_id} could not be read`, { cause: error })
    }
    try {
      return parseStoredModelPreviewBytes(bytes, {
        expected_artifact_identity,
        require_artifact_identity: expected_artifact_identity !== undefined,
      })
    } catch (error) {
      throw new Error(
        `Stored model preview ${input.case_id} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }
  if (Boolean(input.current_preview_generation) !== Boolean(input.current_model_revision)) {
    throw new Error("current_preview_generation and current_model_revision must be provided together")
  }
  if (input.current_preview_generation) {
    const expected_artifact_identity = parseModelPreviewArtifactIdentity({
      preview_generation: input.current_preview_generation,
      model_revision: input.current_model_revision,
    })
    return readLoosePreview(
      join(input.model_dir, "current-previews", input.current_preview_generation),
      expected_artifact_identity,
    )
  }
  if (input.prefer_current_preview) {
    // The store publishes preview options only after this directory has been
    // atomically replaced, so never fall back to an older accepted benchmark.
    return readLoosePreview(join(input.model_dir, "current-preview"))
  }
  const publication = await resolveAcceptedModelPublication(input.model_dir, input.job_id)
  if (publication) {
    const relative_path = `validation/cases/${input.case_id}.preview.json`
    if (!publication.accepted_bundle_manifest.files[relative_path]) {
      if (publication.commit.version === 3) {
        throw new Error(`Fresh accepted publication is missing ${relative_path}`)
      }
      return undefined
    }
    const bytes = await readVerifiedPublicationArtifact({
      publication,
      bundle: "accepted_model",
      relative_path,
      max_bytes: MAX_STORED_MODEL_PREVIEW_BYTES,
    })
    try {
      return parseStoredModelPreviewBytes(bytes, {
        fresh_accepted: publication.commit.version === 3,
        expected_artifact_identity:
          publication.commit.version === 3
            ? {
                preview_generation: basename(publication.accepted_model_dir),
                model_revision: publication.commit.revision,
              }
            : undefined,
      })
    } catch (error) {
      if (publication.commit.version === 2) return undefined
      throw error
    }
  }
  if (input.require_accepted_publication) {
    throw new Error(
      "published-model.json is missing even though the completed datasheet_model pipeline crossed the publish_model commit barrier",
    )
  }
  return (
    (await readLoosePreview(join(input.model_dir, "validation"))) ??
    readLoosePreview(join(input.model_dir, "current-preview"))
  )
}
