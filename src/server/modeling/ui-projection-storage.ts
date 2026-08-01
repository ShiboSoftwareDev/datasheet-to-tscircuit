import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ModelSelectedPreview } from "@/shared/job-types"
import { readVerifiedPublicationArtifact, resolveAcceptedModelPublication } from "./model-publication"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function loadStoredModelPreview(input: {
  job_id: string
  model_dir: string
  case_id: string
  prefer_current_preview?: boolean
  current_preview_generation?: string
}): Promise<ModelSelectedPreview | undefined> {
  // Mirrors the validation-plan case-id grammar while rejecting path separators.
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.case_id)) return undefined
  const readLoosePreview = (root: string) =>
    readFile(join(root, "cases", `${input.case_id}.preview.json`), "utf8")
      .then((text) => JSON.parse(text))
      .then((value: unknown) => (isRecord(value) ? (value as ModelSelectedPreview) : undefined))
      .catch(() => undefined)
  if (input.current_preview_generation) {
    if (!/^[a-zA-Z0-9_-]{16,200}$/.test(input.current_preview_generation)) return undefined
    return readLoosePreview(join(input.model_dir, "current-previews", input.current_preview_generation))
  }
  if (input.prefer_current_preview) {
    // The store publishes preview options only after this directory has been
    // atomically replaced, so never fall back to an older accepted benchmark.
    return readLoosePreview(join(input.model_dir, "current-preview"))
  }
  const publication = await resolveAcceptedModelPublication(input.model_dir, input.job_id)
  if (publication) {
    const relative_path = `validation/cases/${input.case_id}.preview.json`
    if (!publication.accepted_bundle_manifest.files[relative_path]) return undefined
    const bytes = await readVerifiedPublicationArtifact({
      publication,
      bundle: "accepted_model",
      relative_path,
      max_bytes: 2 * 1024 * 1024,
    })
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return isRecord(value) ? (value as ModelSelectedPreview) : undefined
  }
  return (
    (await readLoosePreview(join(input.model_dir, "validation"))) ??
    readLoosePreview(join(input.model_dir, "current-preview"))
  )
}
