import type {
  EligibleObservedReferenceChannel,
  ReferenceGraphAxisAnchor,
} from "../reference-graph-observation"
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

function candidateAxisPixel(candidate: MeasurementCandidate, axis: "x" | "y"): number {
  return (
    (axis === "x"
      ? candidate.bbox.left + candidate.bbox.width / 2
      : candidate.bbox.top + candidate.bbox.height / 2) / OCR_SCALE
  )
}

function candidateOrthogonalPixel(candidate: MeasurementCandidate, axis: "x" | "y"): number {
  return (
    (axis === "x"
      ? candidate.bbox.top + candidate.bbox.height / 2
      : candidate.bbox.left + candidate.bbox.width / 2) / OCR_SCALE
  )
}

function calibrationTick(input: {
  candidate: MeasurementCandidate
  axis: "x" | "y"
  slope: number
  intercept: number
}): ReferenceAxisSourceTick {
  const observer_axis_pixel = candidateAxisPixel(input.candidate, input.axis)
  return {
    raw_text: input.candidate.raw_text,
    normalized_unit: input.candidate.unit,
    value_si: input.candidate.value_si,
    confidence: input.candidate.confidence,
    ocr_bbox_px: input.candidate.bbox,
    observer_axis_pixel,
    observer_axis_pixel_error: Math.abs(
      (input.candidate.value_si - input.intercept) / input.slope - observer_axis_pixel,
    ),
  }
}

/**
 * Derives a source-owned linear scale from a row or column of printed ticks.
 * At least three labels must agree with one line, so a lone nearby
 * measurement cannot masquerade as an axis. The maximum-consensus fit also
 * rejects isolated OCR unit mistakes without silently correcting their text.
 */
export function alignedExplicitAxisCalibration(input: {
  axis: "x" | "y"
  unit: "s" | "V"
  candidates: readonly MeasurementCandidate[]
}):
  | {
      first: ReferenceAxisSourceTick
      second: ReferenceAxisSourceTick
      units_per_pixel: number
      supporting_tick_count: number
    }
  | undefined {
  const candidates = input.candidates
    .filter(
      (candidate) =>
        candidate.unit === input.unit && candidate.confidence >= 35 && Number.isFinite(candidate.value_si),
    )
    .filter(
      (candidate, index, all) =>
        all.findIndex(
          (other) =>
            valuesAgree(other.value_si, candidate.value_si) &&
            Math.abs(candidateAxisPixel(other, input.axis) - candidateAxisPixel(candidate, input.axis)) <=
              0.5,
        ) === index,
    )
  const fits: Array<{
    slope: number
    intercept: number
    support: MeasurementCandidate[]
    pixel_span: number
    confidence: number
  }> = []
  for (let first_index = 0; first_index < candidates.length; first_index += 1) {
    for (let second_index = first_index + 1; second_index < candidates.length; second_index += 1) {
      const first = candidates[first_index]!
      const second = candidates[second_index]!
      if (
        Math.abs(candidateOrthogonalPixel(first, input.axis) - candidateOrthogonalPixel(second, input.axis)) >
        ORTHOGONAL_ALIGNMENT_TOLERANCE
      ) {
        continue
      }
      const first_pixel = candidateAxisPixel(first, input.axis)
      const second_pixel = candidateAxisPixel(second, input.axis)
      const pixel_delta = second_pixel - first_pixel
      if (Math.abs(pixel_delta) < 8) continue
      const slope = (second.value_si - first.value_si) / pixel_delta
      if (!Number.isFinite(slope) || slope === 0 || (input.axis === "x" && slope < 0)) continue
      const intercept = first.value_si - slope * first_pixel
      const support = candidates.filter((candidate) => {
        if (
          Math.abs(
            candidateOrthogonalPixel(candidate, input.axis) - candidateOrthogonalPixel(first, input.axis),
          ) > ORTHOGONAL_ALIGNMENT_TOLERANCE
        ) {
          return false
        }
        const predicted = intercept + slope * candidateAxisPixel(candidate, input.axis)
        return Math.abs(predicted - candidate.value_si) <= Math.max(1e-12, Math.abs(slope) * 2.5)
      })
      if (support.length < 3) continue
      const support_pixels = support.map((candidate) => candidateAxisPixel(candidate, input.axis))
      fits.push({
        slope,
        intercept,
        support,
        pixel_span: Math.max(...support_pixels) - Math.min(...support_pixels),
        confidence: support.reduce((sum, candidate) => sum + candidate.confidence, 0),
      })
    }
  }
  fits.sort(
    (left, right) =>
      right.support.length - left.support.length ||
      right.pixel_span - left.pixel_span ||
      right.confidence - left.confidence ||
      Math.abs(left.slope) - Math.abs(right.slope),
  )
  const best = fits[0]
  if (!best) return undefined
  const mean_pixel =
    best.support.reduce((sum, candidate) => sum + candidateAxisPixel(candidate, input.axis), 0) /
    best.support.length
  const mean_value =
    best.support.reduce((sum, candidate) => sum + candidate.value_si, 0) / best.support.length
  const covariance = best.support.reduce((sum, candidate) => {
    const pixel_delta = candidateAxisPixel(candidate, input.axis) - mean_pixel
    return sum + pixel_delta * (candidate.value_si - mean_value)
  }, 0)
  const variance = best.support.reduce((sum, candidate) => {
    const pixel_delta = candidateAxisPixel(candidate, input.axis) - mean_pixel
    return sum + pixel_delta * pixel_delta
  }, 0)
  if (!(variance > 0)) return undefined
  const fitted_slope = covariance / variance
  const fitted_intercept = mean_value - fitted_slope * mean_pixel
  const ordered = [...best.support].sort(
    (left, right) => candidateAxisPixel(left, input.axis) - candidateAxisPixel(right, input.axis),
  )
  const first = ordered[0]!
  const second = ordered.at(-1)!
  return {
    first: calibrationTick({
      candidate: first,
      axis: input.axis,
      slope: fitted_slope,
      intercept: fitted_intercept,
    }),
    second: calibrationTick({
      candidate: second,
      axis: input.axis,
      slope: fitted_slope,
      intercept: fitted_intercept,
    }),
    units_per_pixel: Math.abs(fitted_slope),
    supporting_tick_count: best.support.length,
  }
}

export function axisTicks(input: {
  graph: EligibleObservedReferenceChannel
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
