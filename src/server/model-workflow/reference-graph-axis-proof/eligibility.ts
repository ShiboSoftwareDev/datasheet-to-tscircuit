import type { ObservedReferenceGraph, ReferenceGraphObservation } from "../reference-graph-observation"
import type {
  ReferenceGraphAxisProofResult,
  ReferenceGraphSourceProof,
  ScopeDivisionReferenceGraphAxisCalibrationReceipt,
} from "./types"

function applyServerOwnedScopeCalibration(
  graph: ObservedReferenceGraph,
  receipt: ScopeDivisionReferenceGraphAxisCalibrationReceipt,
): ObservedReferenceGraph {
  const canonical = structuredClone(graph)
  const curve = canonical.digitized_curve
  if (!curve) throw new Error(`Verified scope graph ${graph.graph_id} has no digitized curve`)

  const x_first_pixel = receipt.x_axis.grid.first_anchor_line_pixel
  const x_second_pixel = receipt.x_axis.grid.second_anchor_line_pixel
  const secondsAtPixel = (pixel: number) => (pixel - x_first_pixel) * receipt.x_axis.source_seconds_per_pixel
  const y_first_pixel = receipt.y_axis.grid.first_anchor_line_pixel
  const y_second_pixel = receipt.y_axis.grid.second_anchor_line_pixel
  const voltsAtPixel = (pixel: number) =>
    receipt.y_axis.nominal_baseline_volts +
    (receipt.y_axis.nominal_baseline_pixel - pixel) * receipt.y_axis.source_volts_per_pixel

  const x_first_value = 0
  const x_second_value = secondsAtPixel(x_second_pixel)
  const y_first_value = voltsAtPixel(y_first_pixel)
  const y_second_value = voltsAtPixel(y_second_pixel)
  if (!(x_second_value > x_first_value) || !(y_second_value > y_first_value)) {
    throw new Error(`Verified scope graph ${graph.graph_id} has an invalid source-owned axis orientation`)
  }

  curve.x_axis = {
    scale: "linear",
    first: { pixel: x_first_pixel, value: x_first_value },
    second: { pixel: x_second_pixel, value: x_second_value },
  }
  curve.x_range = { min: x_first_value, max: x_second_value }
  curve.y_axis = {
    scale: "linear",
    first: { pixel: y_first_pixel, value: y_first_value },
    second: { pixel: y_second_pixel, value: y_second_value },
  }
  curve.y_range = { min: y_first_value, max: y_second_value }
  curve.points = curve.points.map((point) => ({
    ...point,
    x: secondsAtPixel(point.pixel_x),
    y: voltsAtPixel(point.pixel_y),
  }))
  return canonical
}

export function verifiedReferenceGraphIds(proof: ReferenceGraphSourceProof): Set<string> {
  return new Set(proof.results.flatMap((result) => (result.status === "verified" ? [result.graph_id] : [])))
}

/** Produces the only observation view characterization is allowed to consume. */
export function applyReferenceGraphSourceEligibility(input: {
  observation: ReferenceGraphObservation
  proof: ReferenceGraphSourceProof
}): ReferenceGraphObservation {
  if (input.proof.source_pdf_sha256 !== input.observation.source_pdf_sha256) {
    throw new Error("Reference graph source proof does not belong to the observed PDF")
  }
  const results = new Map(input.proof.results.map((result) => [result.graph_id, result]))
  return {
    ...input.observation,
    reviewed_hints: input.observation.reviewed_hints.map((entry) => ({ ...entry })),
    graphs: input.observation.graphs.map((graph) => {
      const was_candidate =
        graph.response_quantity === "voltage" &&
        graph.public_pin_observable &&
        graph.fixture_reproducible &&
        graph.electrical_binding !== undefined &&
        graph.digitized_curve !== undefined
      if (!was_candidate) return structuredClone(graph)
      const result = results.get(graph.graph_id)
      if (result?.status === "verified") {
        return result.receipt.algorithm === "canonical_pdf_tesseract_scope_divisions_v2"
          ? applyServerOwnedScopeCalibration(graph, result.receipt)
          : structuredClone(graph)
      }
      const reason =
        result?.status === "ineligible"
          ? result.reason
          : "No canonical PDF axis-calibration result was retained for this graph."
      return {
        ...structuredClone(graph),
        fixture_reproducible: false,
        reason: `${graph.reason} Axis calibration is source-ineligible: ${reason}`,
        electrical_binding: undefined,
        digitized_curve: undefined,
      }
    }),
  }
}

export function axisReceiptForGraph(
  proof: ReferenceGraphSourceProof,
  graph_id: string,
): Extract<ReferenceGraphAxisProofResult, { status: "verified" }> {
  const matches = proof.results.filter(
    (result): result is Extract<ReferenceGraphAxisProofResult, { status: "verified" }> =>
      result.status === "verified" && result.graph_id === graph_id,
  )
  if (matches.length !== 1) {
    throw new Error(`Independent graph ${graph_id} does not have exactly one verified axis receipt`)
  }
  return matches[0]!
}
