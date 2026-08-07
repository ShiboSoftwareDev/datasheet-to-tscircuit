import type { ModelReferenceCropRegion } from "../../modeling/types"
import { canonicalJson, sha256 } from "./shared"
import type {
  ReferenceAxisSourceTick,
  ReferenceDivisionScaleSource,
  ReferenceGraphAxisCalibrationReceipt,
  ReferenceGraphAxisProofResult,
  ReferenceGraphFigureIdentityReceipt,
  ReferenceGraphSourceProof,
  ReferenceGridCalibrationSource,
} from "./types"

function proofRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function proofKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key))
  const missing = keys.filter((key) => !(key in value))
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `${path} has invalid fields${unknown.length > 0 ? `; unsupported: ${unknown.join(", ")}` : ""}${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}`,
    )
  }
}

function proofString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`)
  return value
}

function proofNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be finite`)
  return value
}

function proofSha(value: unknown, path: string): string {
  const digest = proofString(value, path)
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${path} must be a lowercase SHA-256 digest`)
  return digest
}

function parseProofCrop(value: unknown, path: string): ModelReferenceCropRegion {
  const record = proofRecord(value, path)
  proofKeys(record, ["page", "render_dpi", "x_px", "y_px", "width_px", "height_px"], path)
  const crop = {
    page: proofNumber(record.page, `${path}.page`),
    render_dpi: proofNumber(record.render_dpi, `${path}.render_dpi`) as 200,
    x_px: proofNumber(record.x_px, `${path}.x_px`),
    y_px: proofNumber(record.y_px, `${path}.y_px`),
    width_px: proofNumber(record.width_px, `${path}.width_px`),
    height_px: proofNumber(record.height_px, `${path}.height_px`),
  }
  if (!Object.values(crop).every(Number.isSafeInteger) || crop.page < 1 || crop.render_dpi !== 200) {
    throw new Error(`${path} must be a positive integer 200-DPI crop`)
  }
  if (crop.x_px < 0 || crop.y_px < 0 || crop.width_px < 1 || crop.height_px < 1) {
    throw new Error(`${path} must have non-negative offsets and positive dimensions`)
  }
  return crop
}

function parseProofTick(value: unknown, path: string): ReferenceAxisSourceTick {
  const record = proofRecord(value, path)
  proofKeys(
    record,
    [
      "raw_text",
      "normalized_unit",
      "value_si",
      "confidence",
      "ocr_bbox_px",
      "observer_axis_pixel",
      "observer_axis_pixel_error",
    ],
    path,
  )
  if (record.normalized_unit !== "s" && record.normalized_unit !== "V") {
    throw new Error(`${path}.normalized_unit is unsupported`)
  }
  const bbox_record = proofRecord(record.ocr_bbox_px, `${path}.ocr_bbox_px`)
  proofKeys(bbox_record, ["left", "top", "width", "height"], `${path}.ocr_bbox_px`)
  return {
    raw_text: proofString(record.raw_text, `${path}.raw_text`),
    normalized_unit: record.normalized_unit,
    value_si: proofNumber(record.value_si, `${path}.value_si`),
    confidence: proofNumber(record.confidence, `${path}.confidence`),
    ocr_bbox_px: {
      left: proofNumber(bbox_record.left, `${path}.ocr_bbox_px.left`),
      top: proofNumber(bbox_record.top, `${path}.ocr_bbox_px.top`),
      width: proofNumber(bbox_record.width, `${path}.ocr_bbox_px.width`),
      height: proofNumber(bbox_record.height, `${path}.ocr_bbox_px.height`),
    },
    observer_axis_pixel: proofNumber(record.observer_axis_pixel, `${path}.observer_axis_pixel`),
    observer_axis_pixel_error: proofNumber(
      record.observer_axis_pixel_error,
      `${path}.observer_axis_pixel_error`,
    ),
  }
}

function parsePointBox(value: unknown, path: string) {
  const record = proofRecord(value, path)
  proofKeys(record, ["x_min", "y_min", "x_max", "y_max"], path)
  return {
    x_min: proofNumber(record.x_min, `${path}.x_min`),
    y_min: proofNumber(record.y_min, `${path}.y_min`),
    x_max: proofNumber(record.x_max, `${path}.x_max`),
    y_max: proofNumber(record.y_max, `${path}.y_max`),
  }
}

function parsePrintedExperimentNominalSource(value: unknown, path: string) {
  const record = proofRecord(value, path)
  proofKeys(record, ["algorithm", "source_excerpts", "signal", "nominal_volts"], path)
  if (record.algorithm !== "printed_experiment_conditions_v3" || !Array.isArray(record.source_excerpts)) {
    throw new Error(`${path} must retain printed_experiment_conditions_v3 source excerpts`)
  }
  return {
    algorithm: "printed_experiment_conditions_v3" as const,
    source_excerpts: record.source_excerpts.map((value, index) => {
      const excerpt_path = `${path}.source_excerpts[${index}]`
      const excerpt = proofRecord(value, excerpt_path)
      proofKeys(excerpt, ["scope", "text"], excerpt_path)
      if (excerpt.scope !== "summary_row" && excerpt.scope !== "graph_caption") {
        throw new Error(`${excerpt_path}.scope is unsupported`)
      }
      return {
        scope: excerpt.scope === "summary_row" ? ("summary_row" as const) : ("graph_caption" as const),
        text: proofString(excerpt.text, `${excerpt_path}.text`),
      }
    }),
    signal: proofString(record.signal, `${path}.signal`),
    nominal_volts: proofNumber(record.nominal_volts, `${path}.nominal_volts`),
  }
}

function parseFigureIdentity(value: unknown, path: string): ReferenceGraphFigureIdentityReceipt {
  const record = proofRecord(value, path)
  proofKeys(
    record,
    [
      "algorithm",
      "normalized_figure",
      "source_text",
      "bbox_pdf_points",
      "crop_edge_gap_pdf_points",
      "bbox_output_sha256",
    ],
    path,
  )
  if (record.algorithm !== "pdftotext_bbox_adjacent_figure_v1") {
    throw new Error(`${path}.algorithm is unsupported`)
  }
  return {
    algorithm: "pdftotext_bbox_adjacent_figure_v1",
    normalized_figure: proofString(record.normalized_figure, `${path}.normalized_figure`),
    source_text: proofString(record.source_text, `${path}.source_text`),
    bbox_pdf_points: parsePointBox(record.bbox_pdf_points, `${path}.bbox_pdf_points`),
    crop_edge_gap_pdf_points: proofNumber(
      record.crop_edge_gap_pdf_points,
      `${path}.crop_edge_gap_pdf_points`,
    ),
    bbox_output_sha256: proofSha(record.bbox_output_sha256, `${path}.bbox_output_sha256`),
  }
}

function parseDivisionSource(value: unknown, path: string): ReferenceDivisionScaleSource {
  const record = proofRecord(value, path)
  proofKeys(
    record,
    [
      "raw_text",
      "normalized_unit",
      "value_per_division_si",
      "confidence",
      "ocr_bbox_px",
      ...(record.normalization !== undefined ? ["normalization"] : []),
    ],
    path,
  )
  if (record.normalized_unit !== "s" && record.normalized_unit !== "V") {
    throw new Error(`${path}.normalized_unit is unsupported`)
  }
  const bbox = proofRecord(record.ocr_bbox_px, `${path}.ocr_bbox_px`)
  proofKeys(bbox, ["left", "top", "width", "height"], `${path}.ocr_bbox_px`)
  let normalization: ReferenceDivisionScaleSource["normalization"]
  if (record.normalization !== undefined) {
    const value = proofRecord(record.normalization, `${path}.normalization`)
    proofKeys(value, ["algorithm", "corroborating_raw_text", "multiplier"], `${path}.normalization`)
    if (value.algorithm !== "missing_time_prefix_from_adjacent_measurement_v1") {
      throw new Error(`${path}.normalization.algorithm is unsupported`)
    }
    normalization = {
      algorithm: "missing_time_prefix_from_adjacent_measurement_v1",
      corroborating_raw_text: proofString(
        value.corroborating_raw_text,
        `${path}.normalization.corroborating_raw_text`,
      ),
      multiplier: proofNumber(value.multiplier, `${path}.normalization.multiplier`),
    }
  }
  return {
    raw_text: proofString(record.raw_text, `${path}.raw_text`),
    normalized_unit: record.normalized_unit,
    value_per_division_si: proofNumber(record.value_per_division_si, `${path}.value_per_division_si`),
    confidence: proofNumber(record.confidence, `${path}.confidence`),
    ocr_bbox_px: {
      left: proofNumber(bbox.left, `${path}.ocr_bbox_px.left`),
      top: proofNumber(bbox.top, `${path}.ocr_bbox_px.top`),
      width: proofNumber(bbox.width, `${path}.ocr_bbox_px.width`),
      height: proofNumber(bbox.height, `${path}.ocr_bbox_px.height`),
    },
    ...(normalization ? { normalization } : {}),
  }
}

function parseGridSource(value: unknown, path: string): ReferenceGridCalibrationSource {
  const record = proofRecord(value, path)
  proofKeys(
    record,
    [
      "line_pixels",
      "median_spacing_px",
      "first_anchor_line_pixel",
      "second_anchor_line_pixel",
      "first_anchor_error_px",
      "second_anchor_error_px",
    ],
    path,
  )
  if (!Array.isArray(record.line_pixels) || record.line_pixels.length < 3) {
    throw new Error(`${path}.line_pixels must contain at least three grid lines`)
  }
  return {
    line_pixels: record.line_pixels.map((line, index) => proofNumber(line, `${path}.line_pixels[${index}]`)),
    median_spacing_px: proofNumber(record.median_spacing_px, `${path}.median_spacing_px`),
    first_anchor_line_pixel: proofNumber(record.first_anchor_line_pixel, `${path}.first_anchor_line_pixel`),
    second_anchor_line_pixel: proofNumber(
      record.second_anchor_line_pixel,
      `${path}.second_anchor_line_pixel`,
    ),
    first_anchor_error_px: proofNumber(record.first_anchor_error_px, `${path}.first_anchor_error_px`),
    second_anchor_error_px: proofNumber(record.second_anchor_error_px, `${path}.second_anchor_error_px`),
  }
}

function parseAxisReceipt(value: unknown, path: string): ReferenceGraphAxisCalibrationReceipt {
  const receipt = proofRecord(value, path)
  proofKeys(
    receipt,
    [
      "version",
      "algorithm",
      "graph_id",
      "source_pdf_sha256",
      "page",
      "canonical_crop",
      "canonical_crop_sha256",
      "figure_identity",
      "ocr_render",
      "ocr",
      "x_axis",
      "y_axis",
    ],
    path,
  )
  if (
    receipt.version !== 1 ||
    (receipt.algorithm !== "canonical_pdf_tesseract_explicit_ticks_v1" &&
      receipt.algorithm !== "canonical_pdf_tesseract_scope_divisions_v1" &&
      receipt.algorithm !== "canonical_pdf_tesseract_scope_divisions_v2" &&
      receipt.algorithm !== "canonical_pdf_tesseract_scope_divisions_v3" &&
      receipt.algorithm !== "canonical_pdf_tesseract_explicit_time_scope_voltage_v1" &&
      receipt.algorithm !== "canonical_pdf_tesseract_explicit_time_scope_voltage_v2")
  ) {
    throw new Error(`${path} uses an unsupported receipt version or algorithm`)
  }
  const ocr_render = proofRecord(receipt.ocr_render, `${path}.ocr_render`)
  proofKeys(
    ocr_render,
    ["render_dpi", "observer_to_ocr_scale", "width_px", "height_px", "png_sha256"],
    `${path}.ocr_render`,
  )
  if (ocr_render.render_dpi !== 600 || ocr_render.observer_to_ocr_scale !== 3) {
    throw new Error(`${path}.ocr_render must retain the canonical 600-DPI transform`)
  }
  const ocr = proofRecord(receipt.ocr, `${path}.ocr`)
  const is_scope =
    receipt.algorithm === "canonical_pdf_tesseract_scope_divisions_v1" ||
    receipt.algorithm === "canonical_pdf_tesseract_scope_divisions_v2" ||
    receipt.algorithm === "canonical_pdf_tesseract_scope_divisions_v3" ||
    receipt.algorithm === "canonical_pdf_tesseract_explicit_time_scope_voltage_v1" ||
    receipt.algorithm === "canonical_pdf_tesseract_explicit_time_scope_voltage_v2"
  const has_explicit_time =
    receipt.algorithm === "canonical_pdf_tesseract_explicit_time_scope_voltage_v1" ||
    receipt.algorithm === "canonical_pdf_tesseract_explicit_time_scope_voltage_v2"
  const is_server_calibrated_scope =
    receipt.algorithm === "canonical_pdf_tesseract_scope_divisions_v2" ||
    receipt.algorithm === "canonical_pdf_tesseract_scope_divisions_v3" ||
    has_explicit_time
  const is_printed_experiment_scope =
    receipt.algorithm === "canonical_pdf_tesseract_scope_divisions_v3" ||
    receipt.algorithm === "canonical_pdf_tesseract_explicit_time_scope_voltage_v2"
  proofKeys(
    ocr,
    [
      "engine",
      "engine_version",
      "language",
      "page_segmentation_mode",
      "tsv_sha256",
      ...(is_scope ? ["panel_tsv_sha256"] : []),
    ],
    `${path}.ocr`,
  )
  if (ocr.engine !== "tesseract" || ocr.language !== "eng" || ocr.page_segmentation_mode !== 11) {
    throw new Error(`${path}.ocr has unsupported settings`)
  }
  const common = {
    version: 1 as const,
    graph_id: proofString(receipt.graph_id, `${path}.graph_id`),
    source_pdf_sha256: proofSha(receipt.source_pdf_sha256, `${path}.source_pdf_sha256`),
    page: proofNumber(receipt.page, `${path}.page`),
    canonical_crop: parseProofCrop(receipt.canonical_crop, `${path}.canonical_crop`),
    canonical_crop_sha256: proofSha(receipt.canonical_crop_sha256, `${path}.canonical_crop_sha256`),
    figure_identity: parseFigureIdentity(receipt.figure_identity, `${path}.figure_identity`),
    ocr_render: {
      render_dpi: 600 as const,
      observer_to_ocr_scale: 3 as const,
      width_px: proofNumber(ocr_render.width_px, `${path}.ocr_render.width_px`),
      height_px: proofNumber(ocr_render.height_px, `${path}.ocr_render.height_px`),
      png_sha256: proofSha(ocr_render.png_sha256, `${path}.ocr_render.png_sha256`),
    },
  }
  const common_ocr = {
    engine: "tesseract" as const,
    engine_version: proofString(ocr.engine_version, `${path}.ocr.engine_version`),
    language: "eng" as const,
    page_segmentation_mode: 11 as const,
    tsv_sha256: proofSha(ocr.tsv_sha256, `${path}.ocr.tsv_sha256`),
  }
  if (!is_scope) {
    const parse_axis = (axis_value: unknown, axis: "x" | "y") => {
      const axis_record = proofRecord(axis_value, `${path}.${axis}_axis`)
      const rate_key = axis === "x" ? "seconds_per_pixel" : "volts_per_pixel"
      proofKeys(axis_record, ["quantity", "unit", "first", "second", rate_key], `${path}.${axis}_axis`)
      const expected_quantity = axis === "x" ? "time" : "voltage"
      const expected_unit = axis === "x" ? "s" : "V"
      if (axis_record.quantity !== expected_quantity || axis_record.unit !== expected_unit) {
        throw new Error(`${path}.${axis}_axis must retain ${expected_quantity} in ${expected_unit}`)
      }
      const first = parseProofTick(axis_record.first, `${path}.${axis}_axis.first`)
      const second = parseProofTick(axis_record.second, `${path}.${axis}_axis.second`)
      if (first.normalized_unit !== expected_unit || second.normalized_unit !== expected_unit) {
        throw new Error(`${path}.${axis}_axis ticks must retain normalized unit ${expected_unit}`)
      }
      return {
        first,
        second,
        rate: proofNumber(axis_record[rate_key], `${path}.${axis}_axis.${rate_key}`),
      }
    }
    const x_axis = parse_axis(receipt.x_axis, "x")
    const y_axis = parse_axis(receipt.y_axis, "y")
    return {
      ...common,
      algorithm: "canonical_pdf_tesseract_explicit_ticks_v1",
      ocr: common_ocr,
      x_axis: {
        quantity: "time",
        unit: "s",
        first: x_axis.first,
        second: x_axis.second,
        seconds_per_pixel: x_axis.rate,
      },
      y_axis: {
        quantity: "voltage",
        unit: "V",
        first: y_axis.first,
        second: y_axis.second,
        volts_per_pixel: y_axis.rate,
      },
    }
  }
  const x = proofRecord(receipt.x_axis, `${path}.x_axis`)
  proofKeys(
    x,
    has_explicit_time
      ? [
          "quantity",
          "unit",
          "first",
          "second",
          "grid",
          "declared_seconds_per_pixel",
          "source_seconds_per_pixel",
          "supporting_tick_count",
        ]
      : [
          "quantity",
          "unit",
          "division_scale",
          "grid",
          "declared_seconds_per_pixel",
          "source_seconds_per_pixel",
        ],
    `${path}.x_axis`,
  )
  const y = proofRecord(receipt.y_axis, `${path}.y_axis`)
  proofKeys(
    y,
    [
      "quantity",
      "unit",
      "division_scale",
      "grid",
      "declared_volts_per_pixel",
      "source_volts_per_pixel",
      "nominal_baseline_volts",
      ...(is_printed_experiment_scope
        ? ["nominal_source"]
        : ["nominal_source_text", "nominal_source_bbox_pdf_points"]),
      ...(is_server_calibrated_scope ? ["nominal_baseline_pixel"] : []),
      "nominal_trace_point_indexes",
    ],
    `${path}.y_axis`,
  )
  if (!Array.isArray(y.nominal_trace_point_indexes)) {
    throw new Error(`${path}.y_axis.nominal_trace_point_indexes must be an array`)
  }
  if (x.quantity !== "time" || x.unit !== "s") {
    throw new Error(`${path}.x_axis must retain time in s`)
  }
  if (y.quantity !== "voltage" || y.unit !== "V") {
    throw new Error(`${path}.y_axis must retain voltage in V`)
  }
  const x_division_scale = has_explicit_time
    ? undefined
    : parseDivisionSource(x.division_scale, `${path}.x_axis.division_scale`)
  const y_division_scale = parseDivisionSource(y.division_scale, `${path}.y_axis.division_scale`)
  if (
    (!has_explicit_time && x_division_scale?.normalized_unit !== "s") ||
    y_division_scale.normalized_unit !== "V"
  ) {
    throw new Error(`${path} division scales do not match their axes`)
  }
  const x_grid = parseGridSource(x.grid, `${path}.x_axis.grid`)
  const explicit_x_axis = has_explicit_time
    ? {
        quantity: "time" as const,
        unit: "s" as const,
        first: parseProofTick(x.first, `${path}.x_axis.first`),
        second: parseProofTick(x.second, `${path}.x_axis.second`),
        grid: x_grid,
        declared_seconds_per_pixel: proofNumber(
          x.declared_seconds_per_pixel,
          `${path}.x_axis.declared_seconds_per_pixel`,
        ),
        source_seconds_per_pixel: proofNumber(
          x.source_seconds_per_pixel,
          `${path}.x_axis.source_seconds_per_pixel`,
        ),
        supporting_tick_count: proofNumber(x.supporting_tick_count, `${path}.x_axis.supporting_tick_count`),
      }
    : undefined
  if (explicit_x_axis) {
    if (explicit_x_axis.first.normalized_unit !== "s" || explicit_x_axis.second.normalized_unit !== "s") {
      throw new Error(`${path}.x_axis explicit ticks must retain normalized unit s`)
    }
    if (
      !Number.isSafeInteger(explicit_x_axis.supporting_tick_count) ||
      explicit_x_axis.supporting_tick_count < 3
    ) {
      throw new Error(`${path}.x_axis.supporting_tick_count must be an integer of at least three`)
    }
    const tick_pixel_span = Math.abs(
      explicit_x_axis.second.observer_axis_pixel - explicit_x_axis.first.observer_axis_pixel,
    )
    const tick_value_span = Math.abs(explicit_x_axis.second.value_si - explicit_x_axis.first.value_si)
    const tick_seconds_per_pixel = tick_value_span / tick_pixel_span
    if (
      !Number.isFinite(tick_seconds_per_pixel) ||
      tick_seconds_per_pixel <= 0 ||
      Math.abs(explicit_x_axis.source_seconds_per_pixel - tick_seconds_per_pixel) >
        tick_seconds_per_pixel * 0.04 ||
      Math.abs(explicit_x_axis.declared_seconds_per_pixel - explicit_x_axis.source_seconds_per_pixel) >
        explicit_x_axis.source_seconds_per_pixel * 0.04
    ) {
      throw new Error(`${path}.x_axis explicit tick scale is internally inconsistent`)
    }
  }
  const division_x_axis = !has_explicit_time
    ? {
        quantity: "time" as const,
        unit: "s" as const,
        division_scale: x_division_scale!,
        grid: x_grid,
        declared_seconds_per_pixel: proofNumber(
          x.declared_seconds_per_pixel,
          `${path}.x_axis.declared_seconds_per_pixel`,
        ),
        source_seconds_per_pixel: proofNumber(
          x.source_seconds_per_pixel,
          `${path}.x_axis.source_seconds_per_pixel`,
        ),
      }
    : undefined
  const scope_common = {
    ...common,
    ocr: {
      ...common_ocr,
      panel_tsv_sha256: proofSha(ocr.panel_tsv_sha256, `${path}.ocr.panel_tsv_sha256`),
    },
    y_axis: {
      quantity: "voltage" as const,
      unit: "V" as const,
      division_scale: y_division_scale,
      grid: parseGridSource(y.grid, `${path}.y_axis.grid`),
      declared_volts_per_pixel: proofNumber(
        y.declared_volts_per_pixel,
        `${path}.y_axis.declared_volts_per_pixel`,
      ),
      source_volts_per_pixel: proofNumber(y.source_volts_per_pixel, `${path}.y_axis.source_volts_per_pixel`),
      nominal_baseline_volts: proofNumber(y.nominal_baseline_volts, `${path}.y_axis.nominal_baseline_volts`),
      nominal_trace_point_indexes: y.nominal_trace_point_indexes.map((index, item_index) =>
        proofNumber(index, `${path}.y_axis.nominal_trace_point_indexes[${item_index}]`),
      ),
    },
  }
  if (is_printed_experiment_scope) {
    const y_axis = {
      ...scope_common.y_axis,
      nominal_source: parsePrintedExperimentNominalSource(y.nominal_source, `${path}.y_axis.nominal_source`),
      nominal_baseline_pixel: proofNumber(y.nominal_baseline_pixel, `${path}.y_axis.nominal_baseline_pixel`),
    }
    if (has_explicit_time) {
      return {
        ...scope_common,
        algorithm: "canonical_pdf_tesseract_explicit_time_scope_voltage_v2",
        x_axis: explicit_x_axis!,
        y_axis,
      }
    }
    return {
      ...scope_common,
      algorithm: "canonical_pdf_tesseract_scope_divisions_v3",
      x_axis: division_x_axis!,
      y_axis,
    }
  }
  const pdf_nominal_source = {
    nominal_source_text: proofString(y.nominal_source_text, `${path}.y_axis.nominal_source_text`),
    nominal_source_bbox_pdf_points: parsePointBox(
      y.nominal_source_bbox_pdf_points,
      `${path}.y_axis.nominal_source_bbox_pdf_points`,
    ),
  }
  if (is_server_calibrated_scope) {
    const y_axis = {
      ...scope_common.y_axis,
      ...pdf_nominal_source,
      nominal_baseline_pixel: proofNumber(y.nominal_baseline_pixel, `${path}.y_axis.nominal_baseline_pixel`),
    }
    if (has_explicit_time) {
      return {
        ...scope_common,
        algorithm: "canonical_pdf_tesseract_explicit_time_scope_voltage_v1",
        x_axis: explicit_x_axis!,
        y_axis,
      }
    }
    return {
      ...scope_common,
      algorithm: "canonical_pdf_tesseract_scope_divisions_v2",
      x_axis: division_x_axis!,
      y_axis,
    }
  }
  return {
    ...scope_common,
    algorithm: "canonical_pdf_tesseract_scope_divisions_v1",
    x_axis: division_x_axis!,
    y_axis: {
      ...scope_common.y_axis,
      ...pdf_nominal_source,
    },
  }
}

export function parseReferenceGraphSourceProof(
  value: unknown,
  expected_source_pdf_sha256?: string,
): ReferenceGraphSourceProof {
  const proof = proofRecord(value, "model-reference-source-proof.json")
  proofKeys(proof, ["version", "source_pdf_sha256", "results"], "model-reference-source-proof.json")
  if (proof.version !== 1 || !Array.isArray(proof.results)) {
    throw new Error("model-reference-source-proof.json has an unsupported version or results list")
  }
  const source_pdf_sha256 = proofSha(
    proof.source_pdf_sha256,
    "model-reference-source-proof.json.source_pdf_sha256",
  )
  if (expected_source_pdf_sha256 && source_pdf_sha256 !== expected_source_pdf_sha256) {
    throw new Error("model-reference-source-proof.json does not belong to canonical datasheet.pdf")
  }
  const results = proof.results.map((value, index): ReferenceGraphAxisProofResult => {
    const path = `model-reference-source-proof.json.results[${index}]`
    const result = proofRecord(value, path)
    if (result.status === "ineligible") {
      proofKeys(result, ["status", "graph_id", "code", "reason", "diagnostic"], path)
      if (result.code !== "axis_calibration_unproven") throw new Error(`${path}.code is unsupported`)
      const diagnostic = proofRecord(result.diagnostic, `${path}.diagnostic`)
      proofKeys(diagnostic, ["recognized_measurements", "missing_proofs"], `${path}.diagnostic`)
      if (!Array.isArray(diagnostic.recognized_measurements) || !Array.isArray(diagnostic.missing_proofs)) {
        throw new Error(`${path}.diagnostic fields must be arrays`)
      }
      return {
        status: "ineligible",
        graph_id: proofString(result.graph_id, `${path}.graph_id`),
        code: "axis_calibration_unproven",
        reason: proofString(result.reason, `${path}.reason`),
        diagnostic: {
          recognized_measurements: diagnostic.recognized_measurements.map((entry, item_index) =>
            proofString(entry, `${path}.diagnostic.recognized_measurements[${item_index}]`),
          ),
          missing_proofs: diagnostic.missing_proofs.map((entry, item_index) =>
            proofString(entry, `${path}.diagnostic.missing_proofs[${item_index}]`),
          ),
        },
      }
    }
    proofKeys(result, ["status", "graph_id", "receipt", "receipt_sha256"], path)
    if (result.status !== "verified") throw new Error(`${path}.status is unsupported`)
    const receipt = parseAxisReceipt(result.receipt, `${path}.receipt`)
    const receipt_sha256 = proofSha(result.receipt_sha256, `${path}.receipt_sha256`)
    if (receipt_sha256 !== sha256(canonicalJson(receipt))) {
      throw new Error(`${path}.receipt_sha256 does not match its canonical receipt`)
    }
    const graph_id = proofString(result.graph_id, `${path}.graph_id`)
    if (receipt.graph_id !== graph_id || receipt.source_pdf_sha256 !== source_pdf_sha256) {
      throw new Error(`${path} receipt identity does not match its enclosing proof`)
    }
    return { status: "verified", graph_id, receipt, receipt_sha256 }
  })
  if (new Set(results.map(({ graph_id }) => graph_id)).size !== results.length) {
    throw new Error("model-reference-source-proof.json contains duplicate graph results")
  }
  return { version: 1, source_pdf_sha256, results }
}
