import type { ModelReferenceElectricalBinding } from "../../modeling/types"
import type {
  CharacterizerReferenceGraphObservation,
  ObservedReferenceGraph,
  ObservedVoltageTimeCurve,
  ReferenceGraphObservation,
} from "./types"

export type EligibleObservedReferenceGraph = ObservedReferenceGraph & {
  response_quantity: "voltage"
  public_pin_observable: true
  fixture_reproducible: true
  electrical_binding: ModelReferenceElectricalBinding
  digitized_curve: ObservedVoltageTimeCurve
}

export function eligibleObservedGraphs(
  observation: ReferenceGraphObservation,
): EligibleObservedReferenceGraph[] {
  return observation.graphs.filter(
    (graph): graph is EligibleObservedReferenceGraph =>
      graph.response_quantity === "voltage" &&
      graph.public_pin_observable &&
      graph.fixture_reproducible &&
      graph.electrical_binding !== undefined &&
      graph.digitized_curve !== undefined,
  )
}

/**
 * The characterization agent receives graph identity and geometry so it can
 * inspect the same source, but never receives the independent numeric trace,
 * axis ranges, calibration anchors, colors, or curve digest.
 */
export function projectReferenceGraphObservationForCharacterizer(
  observation: ReferenceGraphObservation,
): CharacterizerReferenceGraphObservation {
  return {
    version: 1,
    source_pdf_sha256: observation.source_pdf_sha256,
    reviewed_hints: observation.reviewed_hints.map((entry) => ({ ...entry })),
    graphs: observation.graphs.map(({ digitized_curve: _withheld, ...graph }) => ({
      ...graph,
      crop: { ...graph.crop },
      numeric_curve_withheld: true,
    })),
  }
}
