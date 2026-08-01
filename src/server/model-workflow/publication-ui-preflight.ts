import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ModelSelectedPreview } from "@/shared/job-types"
import { hasCompletedTransientSimulation } from "@/shared/model-preview-capabilities"
import { resolveDirectoryReferenceImage } from "../modeling/reference-image"
import type { ModelUiProjection } from "../modeling/ui-projection"
import { parseStoredModelPreviewBytes } from "../modeling/ui-projection-storage"
import { stableStringify, type ValidationPlan } from "../spice-validation"

function persisted(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

function assertFreshVisiblePreview(case_id: string, preview: ModelSelectedPreview): void {
  const circuit = preview.circuit_preview
  if (!circuit?.code.trim()) {
    throw new Error(`Fresh publication preview ${case_id} does not retain its generated TSX source`)
  }
  if (
    circuit.analysis_type !== "transient" ||
    circuit.analog_simulation_status !== "available" ||
    !circuit.circuit_json ||
    !hasCompletedTransientSimulation(circuit.circuit_json)
  ) {
    throw new Error(
      `Fresh publication preview ${case_id} does not retain a visible tscircuit transient-voltage simulation`,
    )
  }
  const reference = preview.reference_preview
  if (
    reference?.reference_kind !== "curve" ||
    reference.reference_points.length < 2 ||
    !reference.result_points ||
    reference.result_points.length < 2 ||
    reference.result_origin !== "tscircuit_viewer" ||
    reference.result_status !== "verified" ||
    reference.matches_reference !== true
  ) {
    throw new Error(
      `Fresh publication preview ${case_id} does not retain a visible datasheet/reference comparison from tscircuit`,
    )
  }
}

/**
 * Exercises the files that the completed UI will actually consume before the
 * publication pointer can select them. This prevents a valid simulation bundle
 * from becoming an accepted run whose preview endpoint is too large or whose
 * datasheet image cannot be resolved.
 */
export async function preflightModelPublicationUi(input: {
  accepted_bundle: string
  plan: ValidationPlan
  projection: ModelUiProjection
  fresh: boolean
}): Promise<void> {
  const expected_case_ids = input.plan.cases.map(({ id }) => id).sort()
  const projected_case_ids = Object.keys(input.projection.selected_previews).sort()
  if (stableStringify(projected_case_ids) !== stableStringify(expected_case_ids)) {
    throw new Error("Publication UI projection does not contain the exact validation case set")
  }

  for (const validation_case of input.plan.cases) {
    const case_id = validation_case.id
    const expected = input.projection.selected_previews[case_id]
    if (!expected) throw new Error(`Publication UI projection is missing validation case ${case_id}`)
    const preview_path = join(input.accepted_bundle, "validation", "cases", `${case_id}.preview.json`)
    const loaded = parseStoredModelPreviewBytes(await readFile(preview_path), {
      fresh_accepted: input.fresh,
    })
    if (stableStringify(loaded) !== stableStringify(persisted(expected))) {
      throw new Error(`Stored publication preview ${case_id} differs from its validated UI projection`)
    }

    const stored_tsx = await readFile(
      join(input.accepted_bundle, "validation", "cases", `${case_id}.circuit.tsx`),
      "utf8",
    )
    if (!loaded.circuit_preview?.code || stored_tsx !== loaded.circuit_preview.code) {
      throw new Error(`Stored publication preview ${case_id} is missing its exact generated TSX source`)
    }
    if (input.fresh) assertFreshVisiblePreview(case_id, loaded)

    const requires_reference_image =
      input.fresh || validation_case.observations.some(({ evidence }) => Boolean(evidence?.image))
    if (requires_reference_image) {
      const reference = await resolveDirectoryReferenceImage(input.accepted_bundle, case_id)
      if (!reference.benchmark_found || !reference.image) {
        throw new Error(`Stored publication preview ${case_id} cannot resolve its datasheet reference image`)
      }
    }
  }
}
