import type { ObservedReferenceGraph, ReferenceGraphAxisAnchor } from "../reference-graph-observation"
import { ANCHOR_PIXEL_TOLERANCE, OCR_SCALE, ORTHOGONAL_ALIGNMENT_TOLERANCE, valuesAgree } from "./shared"
import type { MeasurementCandidate, ReferenceAxisSourceTick } from "./types"

function sourceTick(input: {
  anchor: ReferenceGraphAxisAnchor
  axis: "x" | "y"
  unit: "s" | "V"
  candidates: readonly MeasurementCandidate[]
}): ReferenceAxisSourceTick | undefined {
  return input.candidates
    .filter(
      (candidate) =>
        candidate.unit === input.unit &&
        candidate.confidence >= 35 &&
        valuesAgree(candidate.value_si, input.anchor.value),
    )
    .map((candidate) => {
      const center_ocr =
        input.axis === "x"
          ? candidate.bbox.left + candidate.bbox.width / 2
          : candidate.bbox.top + candidate.bbox.height / 2
      const observer_axis_pixel = center_ocr / OCR_SCALE
      return {
        candidate,
        observer_axis_pixel,
        observer_axis_pixel_error: Math.abs(observer_axis_pixel - input.anchor.pixel),
      }
    })
    .filter(({ observer_axis_pixel_error }) => observer_axis_pixel_error <= ANCHOR_PIXEL_TOLERANCE)
    .sort(
      (left, right) =>
        left.observer_axis_pixel_error - right.observer_axis_pixel_error ||
        right.candidate.confidence - left.candidate.confidence,
    )
    .map(({ candidate, observer_axis_pixel, observer_axis_pixel_error }) => ({
      raw_text: candidate.raw_text,
      normalized_unit: candidate.unit,
      value_si: candidate.value_si,
      confidence: candidate.confidence,
      ocr_bbox_px: candidate.bbox,
      observer_axis_pixel,
      observer_axis_pixel_error,
    }))[0]
}

function orthogonalCenter(tick: ReferenceAxisSourceTick, axis: "x" | "y"): number {
  return axis === "x"
    ? (tick.ocr_bbox_px.top + tick.ocr_bbox_px.height / 2) / OCR_SCALE
    : (tick.ocr_bbox_px.left + tick.ocr_bbox_px.width / 2) / OCR_SCALE
}

export function axisTicks(input: {
  graph: ObservedReferenceGraph & {
    digitized_curve: NonNullable<ObservedReferenceGraph["digitized_curve"]>
  }
  candidates: readonly MeasurementCandidate[]
}):
  | {
      x_first: ReferenceAxisSourceTick
      x_second: ReferenceAxisSourceTick
      y_first: ReferenceAxisSourceTick
      y_second: ReferenceAxisSourceTick
    }
  | undefined {
  const x_first = sourceTick({
    anchor: input.graph.digitized_curve.x_axis.first,
    axis: "x",
    unit: "s",
    candidates: input.candidates,
  })
  const x_second = sourceTick({
    anchor: input.graph.digitized_curve.x_axis.second,
    axis: "x",
    unit: "s",
    candidates: input.candidates,
  })
  const y_first = sourceTick({
    anchor: input.graph.digitized_curve.y_axis.first,
    axis: "y",
    unit: "V",
    candidates: input.candidates,
  })
  const y_second = sourceTick({
    anchor: input.graph.digitized_curve.y_axis.second,
    axis: "y",
    unit: "V",
    candidates: input.candidates,
  })
  if (!x_first || !x_second || !y_first || !y_second) return undefined
  if (
    Math.abs(orthogonalCenter(x_first, "x") - orthogonalCenter(x_second, "x")) >
      ORTHOGONAL_ALIGNMENT_TOLERANCE ||
    Math.abs(orthogonalCenter(y_first, "y") - orthogonalCenter(y_second, "y")) >
      ORTHOGONAL_ALIGNMENT_TOLERANCE
  ) {
    return undefined
  }
  if (
    x_first.ocr_bbox_px.left === x_second.ocr_bbox_px.left &&
    x_first.ocr_bbox_px.top === x_second.ocr_bbox_px.top
  ) {
    return undefined
  }
  if (
    y_first.ocr_bbox_px.left === y_second.ocr_bbox_px.left &&
    y_first.ocr_bbox_px.top === y_second.ocr_bbox_px.top
  ) {
    return undefined
  }
  return { x_first, x_second, y_first, y_second }
}
