import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createStageWorkspace, promoteStageDirectory } from "../infrastructure/artifacts"
import type { ModelRunStore } from "../model-run-store"
import { projectModelPreviewOptions, projectModelReferencePreview } from "../modeling/ui-projection"
import type { ValidationPlan } from "../spice-validation"
import { writeJson } from "./stage-helpers"

/**
 * Makes independently sourced graph artifacts visible before model generation.
 * This bundle contains no model, no simulation result, and no acceptance claim.
 */
export async function projectReferenceDraftUi(input: {
  model_run_store: ModelRunStore
  model_run_id: string
  model_dir: string
  plan: ValidationPlan
  evidence_dir: string
  signal: AbortSignal
}): Promise<void> {
  input.signal.throwIfAborted()
  const workspace = await createStageWorkspace({
    prefix: "model-reference-draft",
    files: [],
    directories: [{ source: input.evidence_dir, destination: "bundle/evidence" }],
  })
  try {
    const bundle = join(workspace.path, "bundle")
    const cases_dir = join(bundle, "cases")
    await mkdir(cases_dir, { recursive: true })
    const updated_at = new Date().toISOString()
    const selected_previews = Object.fromEntries(
      input.plan.cases.map((validation_case) => [
        validation_case.id,
        {
          reference_preview: projectModelReferencePreview({
            validation_case,
            updated_at,
          }),
        },
      ]),
    )
    await Promise.all([
      writeJson(join(bundle, "validation-plan.json"), input.plan),
      ...Object.entries(selected_previews).map(([case_id, preview]) =>
        writeJson(join(cases_dir, `${case_id}.preview.json`), preview),
      ),
    ])
    await promoteStageDirectory({
      workspace: workspace.path,
      source: "bundle",
      destination_root: input.model_dir,
      destination: "current-preview",
      max_files: 256,
      max_total_bytes: 96 * 1024 * 1024,
      signal: input.signal,
    })
    const preview_options = projectModelPreviewOptions(input.plan)
    const first_option = preview_options[0]
    const first_preview = first_option
      ? selected_previews[first_option.benchmark_id]?.reference_preview
      : undefined
    if (!first_preview) throw new Error("Reference draft has no graph preview")
    input.model_run_store.projectReferenceDraft(input.model_run_id, {
      preview_options,
      reference_preview: first_preview,
    })
  } finally {
    await workspace.dispose().catch(() => undefined)
  }
}
