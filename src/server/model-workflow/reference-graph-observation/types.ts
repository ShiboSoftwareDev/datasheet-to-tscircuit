import type {
  ModelReferenceCropRegion,
  ModelReferenceChannelMeasurement,
  ModelReferenceChannelRole,
  ModelReferenceElectricalBinding,
  ModelReferencePoint,
} from "../../modeling/types"
import type { CanonicalReferenceCropProof } from "../reference-graph-crop-proof"

export type ReferenceGraphClassification = "voltage" | "current" | "other"

export interface ReferenceGraphAxisRange {
  min: number
  max: number
}

export interface ReferenceGraphAxisAnchor {
  pixel: number
  value: number
}

export interface ReferenceGraphAxisCalibration {
  scale: "linear"
  first: ReferenceGraphAxisAnchor
  second: ReferenceGraphAxisAnchor
}

export interface ReferenceGraphTraceColor {
  r: number
  g: number
  b: number
  tolerance: number
}

export interface ObservedReferencePoint extends ModelReferencePoint {
  pixel_x: number
  pixel_y: number
}

/**
 * Source-observer-owned numeric trace. Pixel coordinates are relative to the
 * exact 200-DPI graph crop, so the numeric values are not free assertions: the
 * parser recomputes them from two independent axis anchors.
 */
export interface ObservedTimeCurve {
  method: "manual_pixel_trace" | "image_color_trace"
  x_quantity: "time"
  x_unit: "s"
  y_quantity: "voltage" | "current"
  y_unit: "V" | "A"
  x_range: ReferenceGraphAxisRange
  y_range: ReferenceGraphAxisRange
  x_axis: ReferenceGraphAxisCalibration
  y_axis: ReferenceGraphAxisCalibration
  trace_color: ReferenceGraphTraceColor
  points: ObservedReferencePoint[]
}

export interface ObservedReferenceChannel {
  channel_id: string
  label: string
  role: ModelReferenceChannelRole
  measurement: ModelReferenceChannelMeasurement
  digitized_curve: ObservedTimeCurve
}

export interface ObservedReferenceGraph {
  graph_id: string
  page: number
  locator: string
  x_axis: "time"
  time_axis_evidence: string
  response_quantity: ReferenceGraphClassification
  public_pin_observable: boolean
  fixture_reproducible: boolean
  reason: string
  crop: ModelReferenceCropRegion
  /** Required experiment identity for every eligible source graph. */
  electrical_binding?: ModelReferenceElectricalBinding
  /** One independently traced comparison for every simulatable plotted channel. */
  channels?: ObservedReferenceChannel[]
}

export interface ReferenceGraphObservation {
  version: 1
  source_pdf_sha256: string
  reviewed_hints: Array<{
    hint_id: string
    disposition: "graph" | "not_time_graph"
    graph_id?: string
    reason: string
  }>
  graphs: ObservedReferenceGraph[]
}

export interface ModelReferenceNumericVerification {
  version: 2
  source_pdf_sha256: string
  matches: Array<{
    requirement_id: string
    graph_id: string
    crop_proof: CanonicalReferenceCropProof
    axis_calibration_receipt_sha256: string
    curve_fidelity: {
      algorithm: "linear_interpolation_axis_normalized_v1"
      observer_curve_sha256: string
      candidate_curve_sha256: string
      compared_sample_count: number
      x_coverage_ratio: number
      normalized_rmse: number
      max_normalized_error: number
      thresholds: {
        min_x_coverage_ratio: number
        max_normalized_rmse: number
        max_normalized_error: number
      }
    }
  }>
}

export interface ModelReferenceVerification {
  version: 2
  source_pdf_sha256: string
  matches: Array<
    ModelReferenceNumericVerification["matches"][number] & {
      pixel_trace: {
        source_image_sha256: string
        verified_point_count: number
        total_point_count: number
        trace_color_coverage: number
        search_radius_px: 4
        segment_support_ratio: number
        minimum_segment_support_ratio: 0.85
        segment_search_radius_px: 6
      }
    }
  >
}

export interface CharacterizerReferenceGraphObservation {
  version: 1
  source_pdf_sha256: string
  reviewed_hints: ReferenceGraphObservation["reviewed_hints"]
  graphs: Array<
    Omit<ObservedReferenceGraph, "channels"> & {
      server_verified_reference_channels?: Array<{
        channel_id: string
        label: string
        role: ModelReferenceChannelRole
        measurement: ModelReferenceChannelMeasurement
        provenance: "canonical_pdf_axis_and_pixel_trace_v1"
        x_quantity: "time"
        x_unit: "s"
        y_quantity: "voltage" | "current"
        y_unit: "V" | "A"
        points: ModelReferencePoint[]
      }>
    }
  >
}
