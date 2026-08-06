import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createStageWorkspace, promoteStageDirectory } from "../infrastructure/artifacts"
import type { ModelRunStore } from "../model-run-store"
import type { ModelContract, ModelRequirement } from "../modeling"
import { projectReferenceComparisonDraft } from "../modeling/ui-projection"
import { writeJson } from "./stage-helpers"

function sourceImage(requirement: ModelRequirement): string {
  const image = requirement.reference_curve?.image?.trim()
  if (!image) throw new Error(`Reference graph ${requirement.requirement_id} has no retained source image`)
  return image
}

/** Create Comparison Graphs is the first stage allowed to publish numeric chart state. */
export async function projectComparisonGraphsUi(input: {
  model_run_store: ModelRunStore
  model_run_id: string
  model_dir: string
  contract: ModelContract
  evidence_dir: string
  signal: AbortSignal
}): Promise<void> {
  input.signal.throwIfAborted()
  const requirements = input.contract.characterization.requirements.filter(
    (requirement) => requirement.support.status === "modeled" && requirement.reference_curve,
  )
  if (requirements.length === 0) throw new Error("Create Comparison Graphs has no reference curves")
  const workspace = await createStageWorkspace({
    prefix: "model-comparison-draft",
    files: [],
    directories: [{ source: input.evidence_dir, destination: "bundle/evidence" }],
  })
  try {
    const bundle = join(workspace.path, "bundle")
    const cases_dir = join(bundle, "cases")
    await mkdir(cases_dir, { recursive: true })
    const updated_at = new Date().toISOString()
    const selected_previews = Object.fromEntries(
      requirements.map((requirement) => [
        requirement.requirement_id,
        { reference_preview: projectReferenceComparisonDraft({ requirement, updated_at }) },
      ]),
    )
    await Promise.all([
      writeJson(join(bundle, "reference-index.json"), {
        version: 1,
        references: requirements.map((requirement) => ({
          benchmark_id: requirement.requirement_id,
          requirement_ids: [requirement.requirement_id],
          sources: [
            {
              page: requirement.reference_curve?.crop?.page ?? requirement.sources[0]?.page,
              figure: requirement.sources[0]?.locator,
              image: sourceImage(requirement),
            },
          ],
        })),
      }),
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
    const preview_options = requirements.map((requirement) => ({
      benchmark_id: requirement.requirement_id,
      title: requirement.title,
      circuit_file: `validation/cases/${requirement.requirement_id}.circuit.tsx`,
      reference_file: sourceImage(requirement),
    }))
    const first = preview_options[0]
      ? selected_previews[preview_options[0].benchmark_id]?.reference_preview
      : undefined
    if (!first) throw new Error("Create Comparison Graphs produced no chart preview")
    input.model_run_store.projectComparisonDraft(input.model_run_id, {
      preview_options,
      reference_preview: first,
    })
  } finally {
    await workspace.dispose().catch(() => undefined)
  }
}
