import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { createStageWorkspace, promoteStageDirectory } from "../infrastructure/artifacts"
import type { ModelRunStore } from "../model-run-store"
import type { ModelContract, ModelRequirement } from "../modeling"
import { projectModelReferencePreview } from "../modeling/ui-projection"
import type { ValidationPlan } from "../spice-validation"
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
  plan: ValidationPlan
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
    const requirement_by_id = new Map(
      requirements.map((requirement) => [requirement.requirement_id, requirement]),
    )
    const selected_previews = Object.fromEntries(
      input.plan.cases.map((validation_case) => [
        validation_case.id,
        { reference_preview: projectModelReferencePreview({ validation_case, updated_at }) },
      ]),
    )
    await Promise.all([
      writeJson(join(bundle, "reference-index.json"), {
        version: 1,
        references: input.plan.cases.map((validation_case) => {
          const case_requirements = validation_case.requirement_ids.map((requirement_id) => {
            const requirement = requirement_by_id.get(requirement_id)
            if (!requirement) throw new Error(`Missing comparison requirement ${requirement_id}`)
            return requirement
          })
          const first_requirement = case_requirements[0]
          if (!first_requirement) throw new Error(`Comparison case ${validation_case.id} has no requirements`)
          return {
            benchmark_id: validation_case.id,
            requirement_ids: validation_case.requirement_ids,
            sources: [
              {
                page: first_requirement.reference_curve?.crop?.page ?? first_requirement.sources[0]?.page,
                figure: first_requirement.sources[0]?.locator,
                image: sourceImage(first_requirement),
              },
            ],
          }
        }),
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
    const preview_options = input.plan.cases.map((validation_case) => {
      const first_requirement = requirement_by_id.get(validation_case.requirement_ids[0] ?? "")
      if (!first_requirement) throw new Error(`Comparison case ${validation_case.id} has no requirement`)
      return {
        benchmark_id: validation_case.id,
        title: validation_case.title ?? first_requirement.title,
        circuit_file: `validation/cases/${validation_case.id}.circuit.tsx`,
        reference_file: sourceImage(first_requirement),
      }
    })
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
