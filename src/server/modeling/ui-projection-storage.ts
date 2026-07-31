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
}): Promise<ModelSelectedPreview | undefined> {
  // Mirrors the validation-plan case-id grammar while rejecting path separators.
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.case_id)) return undefined
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
  const value: unknown = await readFile(
    join(input.model_dir, "validation", "cases", `${input.case_id}.preview.json`),
    "utf8",
  )
    .then((text) => JSON.parse(text))
    .catch(() => undefined)
  return isRecord(value) ? (value as ModelSelectedPreview) : undefined
}
