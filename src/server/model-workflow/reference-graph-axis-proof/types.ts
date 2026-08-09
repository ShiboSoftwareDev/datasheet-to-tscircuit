import type { ModelReferenceCropRegion } from "../../modeling/types"
import type { TimeGraphTransientFixtureEvidence } from "../time-graph-hints"

export interface OcrBoundingBox {
  left: number
  top: number
  width: number
  height: number
}

export interface ReferenceAxisSourceTick {
  raw_text: string
  normalized_unit: "s" | "V"
  value_si: number
  confidence: number
  ocr_bbox_px: OcrBoundingBox
  observer_axis_pixel: number
  observer_axis_pixel_error: number
}

export interface ReferenceGraphFigureIdentityReceipt {
  algorithm: "pdftotext_bbox_adjacent_figure_v1"
  normalized_figure: string
  source_text: string
  bbox_pdf_points: { x_min: number; y_min: number; x_max: number; y_max: number }
  crop_edge_gap_pdf_points: number
  bbox_output_sha256: string
}

export interface ExplicitReferenceGraphAxisCalibrationReceipt {
  version: 1
  algorithm: "canonical_pdf_tesseract_explicit_ticks_v1"
  graph_id: string
  source_pdf_sha256: string
  page: number
  canonical_crop: ModelReferenceCropRegion
  canonical_crop_sha256: string
  figure_identity: ReferenceGraphFigureIdentityReceipt
  ocr_render: {
    render_dpi: 600
    observer_to_ocr_scale: 3
    width_px: number
    height_px: number
    png_sha256: string
  }
  ocr: {
    engine: "tesseract"
    engine_version: string
    language: "eng"
    page_segmentation_mode: 11
    tsv_sha256: string
  }
  x_axis: {
    quantity: "time"
    unit: "s"
    first: ReferenceAxisSourceTick
    second: ReferenceAxisSourceTick
    seconds_per_pixel: number
  }
  y_axis: {
    quantity: "voltage"
    unit: "V"
    first: ReferenceAxisSourceTick
    second: ReferenceAxisSourceTick
    volts_per_pixel: number
  }
}

export interface ReferenceDivisionScaleSource {
  raw_text: string
  normalized_unit: "s" | "V"
  value_per_division_si: number
  confidence: number
  ocr_bbox_px: OcrBoundingBox
  normalization?: {
    algorithm:
      | "missing_time_prefix_from_adjacent_measurement_v1"
      | "low_confidence_micro_prefix_from_adjacent_measurement_v1"
    corroborating_raw_text: string
    multiplier: number
  }
}

export interface ReferenceGridCalibrationSource {
  line_pixels: number[]
  median_spacing_px: number
  first_anchor_line_pixel: number
  second_anchor_line_pixel: number
  first_anchor_error_px: number
  second_anchor_error_px: number
}

interface ScopeDivisionReferenceGraphAxisCalibrationReceiptBase {
  version: 1
  graph_id: string
  source_pdf_sha256: string
  page: number
  canonical_crop: ModelReferenceCropRegion
  canonical_crop_sha256: string
  figure_identity: ReferenceGraphFigureIdentityReceipt
  ocr_render: ExplicitReferenceGraphAxisCalibrationReceipt["ocr_render"]
  ocr: ExplicitReferenceGraphAxisCalibrationReceipt["ocr"] & {
    panel_tsv_sha256: string
  }
  x_axis: {
    quantity: "time"
    unit: "s"
    division_scale: ReferenceDivisionScaleSource
    grid: ReferenceGridCalibrationSource
    declared_seconds_per_pixel: number
    source_seconds_per_pixel: number
  }
  y_axis: {
    quantity: "voltage"
    unit: "V"
    division_scale: ReferenceDivisionScaleSource
    grid: ReferenceGridCalibrationSource
    declared_volts_per_pixel: number
    source_volts_per_pixel: number
    nominal_baseline_volts: number
    nominal_source_text: string
    nominal_source_bbox_pdf_points: {
      x_min: number
      y_min: number
      x_max: number
      y_max: number
    }
    nominal_trace_point_indexes: number[]
  }
}

/** Legacy receipt retained so completed jobs remain readable. */
export interface LegacyScopeDivisionReferenceGraphAxisCalibrationReceipt
  extends ScopeDivisionReferenceGraphAxisCalibrationReceiptBase {
  algorithm: "canonical_pdf_tesseract_scope_divisions_v1"
}

/**
 * Scope calibration whose absolute voltage offset is owned by the server. The
 * printed nominal voltage is bound to a stable, independently pixel-verified
 * trace edge; the observer supplies only pixel geometry and relative scale.
 */
export interface ScopeDivisionReferenceGraphAxisCalibrationReceipt
  extends ScopeDivisionReferenceGraphAxisCalibrationReceiptBase {
  algorithm: "canonical_pdf_tesseract_scope_divisions_v2"
  y_axis: ScopeDivisionReferenceGraphAxisCalibrationReceiptBase["y_axis"] & {
    nominal_baseline_pixel: number
  }
}

export interface PrintedExperimentScopeDivisionReferenceGraphAxisCalibrationReceipt
  extends Omit<ScopeDivisionReferenceGraphAxisCalibrationReceiptBase, "y_axis"> {
  algorithm: "canonical_pdf_tesseract_scope_divisions_v3"
  y_axis: Omit<
    ScopeDivisionReferenceGraphAxisCalibrationReceiptBase["y_axis"],
    "nominal_source_text" | "nominal_source_bbox_pdf_points"
  > & {
    nominal_baseline_pixel: number
    nominal_source: {
      algorithm: "printed_experiment_conditions_v3"
      source_excerpts: TimeGraphTransientFixtureEvidence["source_excerpts"]
      signal: string
      nominal_volts: number
    }
  }
}

interface ExplicitTimeScopeVoltageReferenceGraphAxisCalibrationReceiptBase
  extends Omit<ScopeDivisionReferenceGraphAxisCalibrationReceiptBase, "x_axis" | "y_axis"> {
  x_axis: {
    quantity: "time"
    unit: "s"
    first: ReferenceAxisSourceTick
    second: ReferenceAxisSourceTick
    grid: ReferenceGridCalibrationSource
    declared_seconds_per_pixel: number
    source_seconds_per_pixel: number
    supporting_tick_count: number
  }
  y_axis: ScopeDivisionReferenceGraphAxisCalibrationReceipt["y_axis"]
}

/** Explicit printed time ticks combined with a channel-local scope voltage control. */
export interface ExplicitTimeScopeVoltageReferenceGraphAxisCalibrationReceipt
  extends ExplicitTimeScopeVoltageReferenceGraphAxisCalibrationReceiptBase {
  algorithm: "canonical_pdf_tesseract_explicit_time_scope_voltage_v1"
}

export interface PrintedExperimentExplicitTimeScopeVoltageReferenceGraphAxisCalibrationReceipt
  extends Omit<ExplicitTimeScopeVoltageReferenceGraphAxisCalibrationReceiptBase, "y_axis"> {
  algorithm: "canonical_pdf_tesseract_explicit_time_scope_voltage_v2"
  y_axis: PrintedExperimentScopeDivisionReferenceGraphAxisCalibrationReceipt["y_axis"]
}

export type ReferenceGraphAxisCalibrationReceipt =
  | ExplicitReferenceGraphAxisCalibrationReceipt
  | LegacyScopeDivisionReferenceGraphAxisCalibrationReceipt
  | ScopeDivisionReferenceGraphAxisCalibrationReceipt
  | PrintedExperimentScopeDivisionReferenceGraphAxisCalibrationReceipt
  | ExplicitTimeScopeVoltageReferenceGraphAxisCalibrationReceipt
  | PrintedExperimentExplicitTimeScopeVoltageReferenceGraphAxisCalibrationReceipt

export type ReferenceGraphAxisProofResult =
  | {
      status: "verified"
      graph_id: string
      receipt: ReferenceGraphAxisCalibrationReceipt
      receipt_sha256: string
    }
  | {
      status: "ineligible"
      graph_id: string
      code: "axis_calibration_unproven"
      reason: string
      diagnostic: {
        recognized_measurements: string[]
        missing_proofs: string[]
      }
    }

export interface ReferenceGraphSourceProof {
  version: 1
  source_pdf_sha256: string
  results: ReferenceGraphAxisProofResult[]
}

export interface TesseractWord {
  block: number
  paragraph: number
  line: number
  word: number
  confidence: number
  text: string
  bbox: OcrBoundingBox
}

export interface MeasurementCandidate {
  raw_text: string
  unit: "s" | "V"
  value_si: number
  confidence: number
  bbox: OcrBoundingBox
}
