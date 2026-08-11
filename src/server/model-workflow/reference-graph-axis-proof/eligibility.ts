import {
  eligibleObservedGraphs,
  primaryResponseChannel,
  type ObservedReferenceGraph,
  type ReferenceGraphObservation,
} from "../reference-graph-observation"
import type {
  ExplicitTimeScopeVoltageReferenceGraphAxisCalibrationReceipt,
  PrintedExperimentExplicitTimeScopeVoltageReferenceGraphAxisCalibrationReceipt,
  ReferenceGraphAxisProofResult,
  ReferenceGraphSourceProof,
  PrintedExperimentScopeDivisionReferenceGraphAxisCalibrationReceipt,
  ScopeDivisionReferenceGraphAxisCalibrationReceipt,
  VisibleZeroExplicitTimeScopeVoltageReferenceGraphAxisCalibrationReceipt,
  VisibleZeroScopeDivisionReferenceGraphAxisCalibrationReceipt,
} from "./types"
import { elapsedTimeAtPixel } from "../reference-graph-observation/schema"

function applyServerOwnedScopeCalibration(
  graph: ReturnType<typeof eligibleObservedGraphs>[number],
  receipt:
    | ScopeDivisionReferenceGraphAxisCalibrationReceipt
    | PrintedExperimentScopeDivisionReferenceGraphAxisCalibrationReceipt
    | ExplicitTimeScopeVoltageReferenceGraphAxisCalibrationReceipt
    | PrintedExperimentExplicitTimeScopeVoltageReferenceGraphAxisCalibrationReceipt
    | VisibleZeroScopeDivisionReferenceGraphAxisCalibrationReceipt
    | VisibleZeroExplicitTimeScopeVoltageReferenceGraphAxisCalibrationReceipt,
): ObservedReferenceGraph {
  const canonical = structuredClone(graph)
  const x_first_pixel = receipt.x_axis.grid.first_anchor_line_pixel
  const x_second_pixel = receipt.x_axis.grid.second_anchor_line_pixel
  const x_first_value = 0
  const x_second_value = (x_second_pixel - x_first_pixel) * receipt.x_axis.source_seconds_per_pixel
  if (!(x_second_value > x_first_value)) {
    throw new Error(`Verified scope graph ${graph.graph_id} has an invalid source-owned axis orientation`)
  }
  const x_axis = {
    scale: "linear" as const,
    first: { pixel: x_first_pixel, value: x_first_value },
    second: { pixel: x_second_pixel, value: x_second_value },
  }
  const secondsAtPixel = (pixel: number) => elapsedTimeAtPixel(x_axis, pixel)

  for (const plotted_channel of canonical.channels) {
    plotted_channel.digitized_curve.x_axis = structuredClone(x_axis)
    plotted_channel.digitized_curve.x_range = {
      min: x_first_value,
      max: x_second_value,
    }
    plotted_channel.digitized_curve.points = plotted_channel.digitized_curve.points.map((point) => ({
      ...point,
      x: secondsAtPixel(point.pixel_x),
    }))
  }
  if (
    receipt.algorithm === "canonical_pdf_tesseract_scope_divisions_v4" ||
    receipt.algorithm === "canonical_pdf_tesseract_explicit_time_scope_voltage_v3"
  ) {
    if (receipt.y_axis.channels.length !== canonical.channels.length) {
      throw new Error(`Verified scope graph ${graph.graph_id} has incomplete channel calibration`)
    }
    for (const plotted_channel of canonical.channels) {
      const calibration = receipt.y_axis.channels.find(
        ({ channel_id }) => channel_id === plotted_channel.channel_id,
      )
      if (!calibration) {
        throw new Error(
          `Verified scope graph ${graph.graph_id} lost calibration for ${plotted_channel.channel_id}`,
        )
      }
      const voltsAtPixel = (pixel: number) =>
        calibration.zero_reference_volts +
        (calibration.zero_reference_pixel - pixel) * calibration.source_volts_per_pixel
      const y_first_pixel = calibration.grid.first_anchor_line_pixel
      const y_second_pixel = calibration.grid.second_anchor_line_pixel
      const y_first_value = voltsAtPixel(y_first_pixel)
      const y_second_value = voltsAtPixel(y_second_pixel)
      if (!(y_second_value > y_first_value)) {
        throw new Error(
          `Verified scope graph ${graph.graph_id} channel ${plotted_channel.channel_id} has invalid voltage orientation`,
        )
      }
      plotted_channel.digitized_curve.y_axis = {
        scale: "linear",
        first: { pixel: y_first_pixel, value: y_first_value },
        second: { pixel: y_second_pixel, value: y_second_value },
      }
      plotted_channel.digitized_curve.y_range = {
        min: y_first_value,
        max: y_second_value,
      }
      plotted_channel.digitized_curve.points = plotted_channel.digitized_curve.points.map((point) => ({
        ...point,
        y: voltsAtPixel(point.pixel_y),
      }))
    }
    return canonical
  }

  const primary = primaryResponseChannel(graph)
  if (!primary) throw new Error(`Verified scope graph ${graph.graph_id} has no primary response channel`)
  const channel = canonical.channels.find(({ channel_id }) => channel_id === primary.channel_id)
  if (!channel) throw new Error(`Verified scope graph ${graph.graph_id} lost its primary response channel`)
  const curve = channel.digitized_curve
  const y_first_pixel = receipt.y_axis.grid.first_anchor_line_pixel
  const y_second_pixel = receipt.y_axis.grid.second_anchor_line_pixel
  const voltsAtPixel = (pixel: number) =>
    receipt.y_axis.nominal_baseline_volts +
    (receipt.y_axis.nominal_baseline_pixel - pixel) * receipt.y_axis.source_volts_per_pixel
  const y_first_value = voltsAtPixel(y_first_pixel)
  const y_second_value = voltsAtPixel(y_second_pixel)
  if (!(y_second_value > y_first_value)) {
    throw new Error(`Verified scope graph ${graph.graph_id} has an invalid source-owned axis orientation`)
  }
  curve.y_axis = {
    scale: "linear",
    first: { pixel: y_first_pixel, value: y_first_value },
    second: { pixel: y_second_pixel, value: y_second_value },
  }
  curve.y_range = { min: y_first_value, max: y_second_value }
  curve.points = curve.points.map((point) => ({
    ...point,
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
    reviewed_hints: input.observation.reviewed_hints.map((entry) => ({
      ...entry,
    })),
    graphs: input.observation.graphs.map((graph) => {
      const was_candidate =
        graph.response_quantity === "voltage" &&
        graph.public_pin_observable &&
        graph.fixture_reproducible &&
        graph.electrical_binding !== undefined &&
        graph.channels !== undefined &&
        graph.channels.length > 0
      if (!was_candidate) return structuredClone(graph)
      const result = results.get(graph.graph_id)
      if (result?.status === "verified") {
        return result.receipt.algorithm === "canonical_pdf_tesseract_scope_divisions_v2" ||
          result.receipt.algorithm === "canonical_pdf_tesseract_scope_divisions_v3" ||
          result.receipt.algorithm === "canonical_pdf_tesseract_scope_divisions_v4" ||
          result.receipt.algorithm === "canonical_pdf_tesseract_explicit_time_scope_voltage_v1" ||
          result.receipt.algorithm === "canonical_pdf_tesseract_explicit_time_scope_voltage_v2" ||
          result.receipt.algorithm === "canonical_pdf_tesseract_explicit_time_scope_voltage_v3"
          ? applyServerOwnedScopeCalibration(
              graph as ReturnType<typeof eligibleObservedGraphs>[number],
              result.receipt,
            )
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
        channels: undefined,
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
