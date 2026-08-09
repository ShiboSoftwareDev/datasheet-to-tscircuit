import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { ModelCircuitPreview, ModelSelectedPreview } from "@/shared/job-types"
import { parseModelSelectedPreview } from "@/shared/model-selected-preview"
import { createStageWorkspace, promoteStageDirectory } from "../infrastructure/artifacts"
import type { ModelRunStore } from "../model-run-store"
import { projectModelPreviewOptions, projectModelReferencePreview } from "../modeling/ui-projection"
import type { ValidationPlan } from "../spice-validation"
import { writeJson } from "./stage-helpers"

/**
 * Publishes Create Simulation TSX's source-only output. The browser Runframe
 * executes this source for development previews; authoritative simulator
 * results remain owned by Run Simulations.
 */
export async function projectSimulationSourcesUi(input: {
  model_run_store: ModelRunStore
  model_run_id: string
  model_dir: string
  plan: ValidationPlan
  evidence_dir: string
  source_by_case: Readonly<Record<string, string>>
  signal: AbortSignal
}): Promise<void> {
  input.signal.throwIfAborted()
  const workspace = await createStageWorkspace({
    prefix: "model-simulation-sources",
    files: [],
    directories: [{ source: input.evidence_dir, destination: "bundle/evidence" }],
  })
  try {
    const bundle = join(workspace.path, "bundle")
    const cases_dir = join(bundle, "cases")
    await mkdir(cases_dir, { recursive: true })
    const updated_at = new Date().toISOString()
    const selected_previews: Record<string, ModelSelectedPreview> = {}

    for (const validation_case of input.plan.cases) {
      input.signal.throwIfAborted()
      const source = input.source_by_case[validation_case.id]
      if (source === undefined) {
        throw new Error(`Create Simulation TSX did not produce source for ${validation_case.id}`)
      }
      const circuit_preview: ModelCircuitPreview = {
        source_file: `validation/cases/${validation_case.id}.circuit.tsx`,
        code: source,
        build_status: "source_ready",
        updated_at,
        analysis_type: validation_case.analysis.type,
        is_stale: false,
      }
      const preview = parseModelSelectedPreview({
        circuit_preview,
        reference_preview: projectModelReferencePreview({ validation_case, updated_at }),
      })
      selected_previews[validation_case.id] = preview
      await Promise.all([
        writeJson(join(cases_dir, `${validation_case.id}.preview.json`), preview),
        Bun.write(join(cases_dir, `${validation_case.id}.circuit.tsx`), source),
      ])
    }

    await writeJson(join(bundle, "validation-plan.json"), input.plan)
    await promoteStageDirectory({
      workspace: workspace.path,
      source: "bundle",
      destination_root: input.model_dir,
      destination: "current-preview",
      max_files: 256,
      max_total_bytes: 128 * 1024 * 1024,
      signal: input.signal,
    })

    const preview_options = projectModelPreviewOptions(input.plan)
    const first_option = preview_options[0]
    const first_preview = first_option ? selected_previews[first_option.benchmark_id] : undefined
    if (!first_preview?.circuit_preview || !first_preview.reference_preview) {
      throw new Error("Create Simulation TSX produced no source preview")
    }
    input.model_run_store.projectSimulationSources(input.model_run_id, {
      preview_options,
      circuit_preview: first_preview.circuit_preview,
      reference_preview: first_preview.reference_preview,
    })
  } finally {
    await workspace.dispose().catch(() => undefined)
  }
}
