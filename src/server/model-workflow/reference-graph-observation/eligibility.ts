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

export type FoundObservedReferenceGraph = ObservedReferenceGraph & {
  response_quantity: "voltage"
  public_pin_observable: true
  fixture_reproducible: true
}

export function foundObservedGraphs(observation: ReferenceGraphObservation): FoundObservedReferenceGraph[] {
  return observation.graphs.filter(
    (graph): graph is FoundObservedReferenceGraph =>
      graph.response_quantity === "voltage" && graph.public_pin_observable && graph.fixture_reproducible,
  )
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
 * Publish only the downstream facts established by the independent graph
 * stage. Pixel coordinates, colors, and calibration internals stay private;
 * the source-calibrated time/voltage curve becomes an immutable stage output
 * so later agents do not re-digitize the same PDF.
 */
export function projectReferenceGraphObservationForCharacterizer(
  observation: ReferenceGraphObservation,
): CharacterizerReferenceGraphObservation {
  return {
    version: 1,
    source_pdf_sha256: observation.source_pdf_sha256,
    reviewed_hints: observation.reviewed_hints.map((entry) => ({ ...entry })),
    graphs: observation.graphs.map(({ digitized_curve, ...graph }) => ({
      ...graph,
      crop: { ...graph.crop },
      ...(graph.response_quantity === "voltage" &&
      graph.public_pin_observable &&
      graph.fixture_reproducible &&
      graph.electrical_binding &&
      digitized_curve
        ? {
            server_verified_reference_curve: {
              provenance: "canonical_pdf_axis_and_pixel_trace_v1" as const,
              x_quantity: "time" as const,
              x_unit: "s" as const,
              y_quantity: "voltage" as const,
              y_unit: "V" as const,
              points: digitized_curve.points.map(({ x, y }) => ({ x, y })),
            },
          }
        : {}),
    })),
  }
}
