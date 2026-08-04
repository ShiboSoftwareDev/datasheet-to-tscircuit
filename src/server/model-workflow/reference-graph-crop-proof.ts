import { createHash } from "node:crypto"
import type { ModelCharacterization, ModelReferenceCropRegion, ModelRequirement } from "../modeling/types"
import { modelReferenceElectricalBindingsEqual } from "../modeling/reference-electrical-binding"
import type { ObservedReferenceGraph, ReferenceGraphObservation } from "./reference-graph-observation"
import { normalizeFigureLabel } from "./time-graph-hints"

export interface CanonicalReferenceCropProof {
  algorithm: "exact_observer_crop_v1"
  canonical_crop: ModelReferenceCropRegion
  canonical_crop_sha256: string
}

function cropsEqual(left: ModelReferenceCropRegion, right: ModelReferenceCropRegion): boolean {
  return (
    left.page === right.page &&
    left.render_dpi === right.render_dpi &&
    left.x_px === right.x_px &&
    left.y_px === right.y_px &&
    left.width_px === right.width_px &&
    left.height_px === right.height_px
  )
}

function graphIdentityMatches(graph: ObservedReferenceGraph, requirement: ModelRequirement): boolean {
  const curve = requirement.reference_curve
  if (!curve?.electrical_binding || !graph.electrical_binding) return false
  if (!modelReferenceElectricalBindingsEqual(curve.electrical_binding, graph.electrical_binding)) return false
  const cited_on_page = requirement.sources.filter(({ page }) => page === graph.page)
  if (cited_on_page.length === 0) return false
  const graph_figure = normalizeFigureLabel(graph.locator)
  if (!graph_figure) return cited_on_page.length === 1
  return cited_on_page.some(({ locator }) => normalizeFigureLabel(locator) === graph_figure)
}

export function canonicalReferenceCropProof(crop: ModelReferenceCropRegion): CanonicalReferenceCropProof {
  const canonical_crop = { ...crop }
  return {
    algorithm: "exact_observer_crop_v1",
    canonical_crop,
    canonical_crop_sha256: createHash("sha256").update(JSON.stringify(canonical_crop)).digest("hex"),
  }
}

/**
 * Resolves graph identity without consulting the characterizer's rectangle,
 * then replaces that untrusted rectangle with the observer-owned canonical
 * crop. This is deliberately a server transform, not fuzzy crop acceptance.
 */
export function canonicalizeCharacterizationReferenceCrops(input: {
  characterization: ModelCharacterization
  observation: ReferenceGraphObservation
  eligible_graph_ids?: ReadonlySet<string>
}): ModelCharacterization {
  const eligible = input.observation.graphs.filter(
    (graph) =>
      graph.response_quantity === "voltage" &&
      graph.public_pin_observable &&
      graph.fixture_reproducible &&
      graph.electrical_binding !== undefined &&
      graph.digitized_curve !== undefined &&
      (!input.eligible_graph_ids || input.eligible_graph_ids.has(graph.graph_id)),
  )
  return {
    ...input.characterization,
    requirements: input.characterization.requirements.map((requirement) => {
      if (requirement.support.status !== "modeled") return requirement
      const matches = eligible.filter((graph) => graphIdentityMatches(graph, requirement))
      if (matches.length !== 1) {
        throw new Error(
          `Modeled requirement ${requirement.requirement_id} must identify exactly one independently verified graph by PDF page, figure locator, and electrical binding; found ${matches.length}`,
        )
      }
      const curve = requirement.reference_curve
      if (!curve) {
        throw new Error(`Modeled requirement ${requirement.requirement_id} is missing a reference curve`)
      }
      return {
        ...requirement,
        reference_curve: {
          ...curve,
          crop: { ...matches[0]!.crop },
        },
      }
    }),
  }
}

export function assertExactCanonicalReferenceCrop(input: {
  requirement: ModelRequirement
  graph: ObservedReferenceGraph
}): CanonicalReferenceCropProof {
  const candidate = input.requirement.reference_curve?.crop
  if (!candidate || !cropsEqual(candidate, input.graph.crop)) {
    throw new Error(
      `Modeled requirement ${input.requirement.requirement_id} must use the exact canonical observer crop for independent graph ${input.graph.graph_id}`,
    )
  }
  return canonicalReferenceCropProof(input.graph.crop)
}

export function matchingReferenceGraphs(input: {
  requirement: ModelRequirement
  graphs: readonly ObservedReferenceGraph[]
}): ObservedReferenceGraph[] {
  return input.graphs.filter((graph) => graphIdentityMatches(graph, input.requirement))
}
