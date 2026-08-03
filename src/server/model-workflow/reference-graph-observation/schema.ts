import type { ModelInterface, ModelReferenceCropRegion } from "../../modeling/types"
import {
  MODEL_REFERENCE_CROP_DPI,
  MODEL_REFERENCE_CROP_MIN_HEIGHT,
  MODEL_REFERENCE_CROP_MIN_WIDTH,
} from "../../modeling/types"
import {
  assertModelReferenceElectricalBindingInterface,
  parseModelReferenceElectricalBinding,
} from "../../modeling/reference-electrical-binding"
import type {
  ObservedReferenceGraph,
  ObservedReferencePoint,
  ObservedVoltageTimeCurve,
  ReferenceGraphAxisAnchor,
  ReferenceGraphAxisCalibration,
  ReferenceGraphAxisRange,
  ReferenceGraphClassification,
  ReferenceGraphTraceColor,
} from "./types"

export type ReferencePointFieldPolicy = "pixels_only" | "canonical"

export const MIN_TRACE_POINTS = 8
export const MAX_TRACE_POINTS = 48
const MAX_HORIZONTAL_PIXELS_PER_TRACE_POINT = 14
export const AXIS_CALIBRATION_TOLERANCE = 0.015
export const MIN_X_COVERAGE_RATIO = 0.98
export const MAX_NORMALIZED_RMSE = 0.05
export const MAX_NORMALIZED_ERROR = 0.1
export const MAX_OBSERVED_GRAPHS = 64
export const MAX_ELIGIBLE_GRAPHS = 32

export function minimumTracePointCount(horizontal_axis_pixel_span: number): number {
  return Math.min(
    MAX_TRACE_POINTS,
    Math.max(
      MIN_TRACE_POINTS,
      Math.ceil(Math.abs(horizontal_axis_pixel_span) / MAX_HORIZONTAL_PIXELS_PER_TRACE_POINT),
    ),
  )
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new Error(
      `${path} contains unsupported fields: ${unknown.join(", ")}. Allowed fields: ${allowed.join(", ")}`,
    )
  }
}

export function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`)
  return value.trim()
}

function safeInteger(value: unknown, path: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${path} must be a safe integer greater than or equal to ${minimum}`)
  }
  return value as number
}

export function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`)
  }
  return Object.is(value, -0) ? 0 : value
}

function parseAxisRange(value: unknown, path: string): ReferenceGraphAxisRange {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  rejectUnknownKeys(value, ["min", "max"], path)
  const min = finiteNumber(value.min, `${path}.min`)
  const max = finiteNumber(value.max, `${path}.max`)
  if (!(max > min)) throw new Error(`${path}.max must be greater than ${path}.min`)
  return { min, max }
}

function parseAxisPixel(value: unknown, path: string, axis_name: "x_axis" | "y_axis"): number {
  if (!isRecord(value)) return finiteNumber(value, path)
  rejectUnknownKeys(value, ["x", "y"], path)
  const coordinate = {
    x: finiteNumber(value.x, `${path}.x`),
    y: finiteNumber(value.y, `${path}.y`),
  }
  return axis_name === "x_axis" ? coordinate.x : coordinate.y
}

function parseAxisAnchor(
  value: unknown,
  path: string,
  axis_name: "x_axis" | "y_axis",
): ReferenceGraphAxisAnchor {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  rejectUnknownKeys(value, ["pixel", "value"], path)
  return {
    pixel: parseAxisPixel(value.pixel, `${path}.pixel`, axis_name),
    value: finiteNumber(value.value, `${path}.value`),
  }
}

function parseAxisCalibration(
  value: unknown,
  path: string,
  axis_name: "x_axis" | "y_axis",
): ReferenceGraphAxisCalibration {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  rejectUnknownKeys(value, ["scale", "first", "second"], path)
  if (value.scale !== "linear") throw new Error(`${path}.scale must be linear`)
  const first = parseAxisAnchor(value.first, `${path}.first`, axis_name)
  const second = parseAxisAnchor(value.second, `${path}.second`, axis_name)
  if (first.pixel === second.pixel) throw new Error(`${path} calibration pixels must be distinct`)
  if (first.value === second.value) throw new Error(`${path} calibration values must be distinct`)
  return { scale: "linear", first, second }
}

function parseTraceColor(value: unknown, path: string): ReferenceGraphTraceColor {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  rejectUnknownKeys(value, ["r", "g", "b", "tolerance"], path)
  const color = {
    r: safeInteger(value.r, `${path}.r`, 0),
    g: safeInteger(value.g, `${path}.g`, 0),
    b: safeInteger(value.b, `${path}.b`, 0),
    tolerance: finiteNumber(value.tolerance, `${path}.tolerance`),
  }
  if (color.r > 255 || color.g > 255 || color.b > 255) {
    throw new Error(`${path} RGB values must be integers from 0 through 255`)
  }
  if (color.tolerance < 4 || color.tolerance > 120) {
    throw new Error(`${path}.tolerance must be from 4 through 120`)
  }
  return color
}

function valueAtPixel(axis: ReferenceGraphAxisCalibration, pixel: number): number {
  const ratio = (pixel - axis.first.pixel) / (axis.second.pixel - axis.first.pixel)
  return axis.first.value + ratio * (axis.second.value - axis.first.value)
}

function valuesAgree(actual: number, expected: number, span: number): boolean {
  return (
    Math.abs(actual - expected) <=
    Math.max(1e-12, Math.abs(span) * AXIS_CALIBRATION_TOLERANCE, Math.abs(expected) * 1e-8)
  )
}

function assertAnchorRangeAgreement(input: {
  range: ReferenceGraphAxisRange
  axis: ReferenceGraphAxisCalibration
  path: string
}): void {
  const anchor_min = Math.min(input.axis.first.value, input.axis.second.value)
  const anchor_max = Math.max(input.axis.first.value, input.axis.second.value)
  const span = input.range.max - input.range.min
  if (!valuesAgree(anchor_min, input.range.min, span) || !valuesAgree(anchor_max, input.range.max, span)) {
    throw new Error(`${input.path} must equal the calibrated axis-anchor range`)
  }
}

function parseDigitizedCurve(
  value: unknown,
  path: string,
  crop: ModelReferenceCropRegion,
  point_field_policy: ReferencePointFieldPolicy,
): ObservedVoltageTimeCurve {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  rejectUnknownKeys(
    value,
    [
      "method",
      "x_quantity",
      "x_unit",
      "y_quantity",
      "y_unit",
      "x_range",
      "y_range",
      "x_axis",
      "y_axis",
      "trace_color",
      "points",
    ],
    path,
  )
  if (value.method !== "manual_pixel_trace" && value.method !== "image_color_trace") {
    throw new Error(`${path}.method must be manual_pixel_trace or image_color_trace`)
  }
  if (value.x_quantity !== "time") throw new Error(`${path}.x_quantity must be time`)
  if (value.x_unit !== "s") throw new Error(`${path}.x_unit must be s`)
  if (value.y_quantity !== "voltage") throw new Error(`${path}.y_quantity must be voltage`)
  if (value.y_unit !== "V") throw new Error(`${path}.y_unit must be V`)
  const x_range = parseAxisRange(value.x_range, `${path}.x_range`)
  const y_range = parseAxisRange(value.y_range, `${path}.y_range`)
  const x_axis = parseAxisCalibration(value.x_axis, `${path}.x_axis`, "x_axis")
  const y_axis = parseAxisCalibration(value.y_axis, `${path}.y_axis`, "y_axis")
  if (!(x_axis.second.value > x_axis.first.value)) {
    throw new Error(`${path}.x_axis anchors must progress from minimum to maximum time`)
  }
  if (!(y_axis.second.value > y_axis.first.value)) {
    throw new Error(`${path}.y_axis anchors must progress from minimum to maximum voltage`)
  }
  assertAnchorRangeAgreement({ range: x_range, axis: x_axis, path: `${path}.x_range` })
  assertAnchorRangeAgreement({ range: y_range, axis: y_axis, path: `${path}.y_range` })
  for (const [axis_name, axis, limit] of [
    ["x_axis", x_axis, crop.width_px],
    ["y_axis", y_axis, crop.height_px],
  ] as const) {
    for (const [anchor_name, anchor] of [
      ["first", axis.first],
      ["second", axis.second],
    ] as const) {
      if (anchor.pixel < 0 || anchor.pixel >= limit) {
        throw new Error(`${path}.${axis_name}.${anchor_name}.pixel must be inside the exact graph crop`)
      }
    }
  }
  if (!Array.isArray(value.points)) throw new Error(`${path}.points must be an array`)
  const x_pixel_span = Math.abs(x_axis.second.pixel - x_axis.first.pixel)
  const minimum_points = minimumTracePointCount(x_pixel_span)
  if (value.points.length < minimum_points || value.points.length > MAX_TRACE_POINTS) {
    throw new Error(
      `${path}.points must contain ${minimum_points} through ${MAX_TRACE_POINTS} distributed traced points`,
    )
  }
  const points = value.points.map((point, index): ObservedReferencePoint => {
    const point_path = `${path}.points[${index}]`
    if (!isRecord(point)) throw new Error(`${point_path} must be an object`)
    rejectUnknownKeys(
      point,
      point_field_policy === "pixels_only" ? ["pixel_x", "pixel_y"] : ["pixel_x", "pixel_y", "x", "y"],
      point_path,
    )
    const parsed = {
      pixel_x: finiteNumber(point.pixel_x, `${point_path}.pixel_x`),
      pixel_y: finiteNumber(point.pixel_y, `${point_path}.pixel_y`),
    }
    if (
      parsed.pixel_x < 0 ||
      parsed.pixel_x >= crop.width_px ||
      parsed.pixel_y < 0 ||
      parsed.pixel_y >= crop.height_px
    ) {
      throw new Error(`${point_path} pixel coordinates must be inside the exact graph crop`)
    }
    const x = valueAtPixel(x_axis, parsed.pixel_x)
    const y = valueAtPixel(y_axis, parsed.pixel_y)
    if (point_field_policy === "canonical") {
      const supplied_x = finiteNumber(point.x, `${point_path}.x`)
      const supplied_y = finiteNumber(point.y, `${point_path}.y`)
      if (
        !valuesAgree(supplied_x, x, x_range.max - x_range.min) ||
        !valuesAgree(supplied_y, y, y_range.max - y_range.min)
      ) {
        throw new Error(`${point_path}.x/y must match the server-derived pixel-axis calibration`)
      }
    }
    return {
      ...parsed,
      x,
      y,
    }
  })
  const x_pixel_direction = Math.sign(x_axis.second.pixel - x_axis.first.pixel)
  const normalized_x_positions = points.map(
    ({ pixel_x }) => ((pixel_x - x_axis.first.pixel) * x_pixel_direction) / x_pixel_span,
  )
  for (let index = 1; index < points.length; index += 1) {
    if (points[index]!.x <= points[index - 1]!.x) {
      throw new Error(`${path}.points x values must increase strictly`)
    }
    if (normalized_x_positions[index]! <= normalized_x_positions[index - 1]!) {
      throw new Error(`${path}.points pixels must progress strictly across the time axis`)
    }
  }
  const first_position = normalized_x_positions[0]!
  const last_position = normalized_x_positions.at(-1)!
  if (first_position > 0.1 || last_position < 0.9) {
    throw new Error(`${path}.points must cover at least 90% of the calibrated time axis`)
  }
  const bounded_positions = [
    0,
    ...normalized_x_positions.filter((position) => position > 0 && position < 1),
    1,
  ]
  const largest_gap = bounded_positions.reduce(
    (largest, position, index) =>
      index === 0 ? largest : Math.max(largest, position - bounded_positions[index - 1]!),
    0,
  )
  if (largest_gap > 0.2) {
    throw new Error(`${path}.points cannot leave more than 20% of the calibrated time axis unsampled`)
  }
  return {
    method: value.method,
    x_quantity: "time",
    x_unit: "s",
    y_quantity: "voltage",
    y_unit: "V",
    x_range,
    y_range,
    x_axis,
    y_axis,
    trace_color: parseTraceColor(value.trace_color, `${path}.trace_color`),
    points,
  }
}

function parseCrop(value: unknown, path: string): ModelReferenceCropRegion {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  rejectUnknownKeys(value, ["page", "render_dpi", "x_px", "y_px", "width_px", "height_px"], path)
  if (value.render_dpi !== MODEL_REFERENCE_CROP_DPI) {
    throw new Error(`${path}.render_dpi must be ${MODEL_REFERENCE_CROP_DPI}`)
  }
  return {
    page: safeInteger(value.page, `${path}.page`, 1),
    render_dpi: MODEL_REFERENCE_CROP_DPI,
    x_px: safeInteger(value.x_px, `${path}.x_px`, 0),
    y_px: safeInteger(value.y_px, `${path}.y_px`, 0),
    width_px: safeInteger(value.width_px, `${path}.width_px`, MODEL_REFERENCE_CROP_MIN_WIDTH),
    height_px: safeInteger(value.height_px, `${path}.height_px`, MODEL_REFERENCE_CROP_MIN_HEIGHT),
  }
}

export function parseGraph(
  value: unknown,
  index: number,
  model_interface: ModelInterface,
  point_field_policy: ReferencePointFieldPolicy,
): ObservedReferenceGraph {
  const path = `model-reference-observation.json.graphs[${index}]`
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  rejectUnknownKeys(
    value,
    [
      "graph_id",
      "page",
      "locator",
      "x_axis",
      "time_axis_evidence",
      "response_quantity",
      "public_pin_observable",
      "fixture_reproducible",
      "reason",
      "crop",
      "electrical_binding",
      "digitized_curve",
    ],
    path,
  )
  const graph_id = nonEmptyString(value.graph_id, `${path}.graph_id`)
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(graph_id)) throw new Error(`${path}.graph_id must use snake_case`)
  const response_quantity = nonEmptyString(
    value.response_quantity,
    `${path}.response_quantity`,
  ) as ReferenceGraphClassification
  if (!new Set<ReferenceGraphClassification>(["voltage", "current", "other"]).has(response_quantity)) {
    throw new Error(`${path}.response_quantity must be voltage, current, or other`)
  }
  if (typeof value.public_pin_observable !== "boolean") {
    throw new Error(`${path}.public_pin_observable must be boolean`)
  }
  if (typeof value.fixture_reproducible !== "boolean") {
    throw new Error(`${path}.fixture_reproducible must be boolean`)
  }
  if (value.x_axis !== "time") throw new Error(`${path}.x_axis must be time`)
  const crop = parseCrop(value.crop, `${path}.crop`)
  const page = safeInteger(value.page, `${path}.page`, 1)
  if (crop.page !== page) throw new Error(`${path}.crop.page must match ${path}.page`)
  const digitized_curve =
    value.digitized_curve === undefined
      ? undefined
      : parseDigitizedCurve(value.digitized_curve, `${path}.digitized_curve`, crop, point_field_policy)
  const is_eligible =
    response_quantity === "voltage" && value.public_pin_observable && value.fixture_reproducible
  if (is_eligible && !digitized_curve) {
    throw new Error(`${path}.digitized_curve is required for every eligible voltage graph`)
  }
  if (response_quantity !== "voltage" && digitized_curve) {
    throw new Error(
      `${path}.digitized_curve is supported only for voltage-versus-time graphs in the current runtime`,
    )
  }
  const electrical_binding =
    value.electrical_binding === undefined
      ? undefined
      : parseModelReferenceElectricalBinding(value.electrical_binding, `${path}.electrical_binding`)
  if (is_eligible && !electrical_binding) {
    throw new Error(`${path}.electrical_binding is required for every eligible voltage graph`)
  }
  if (!is_eligible && electrical_binding) {
    throw new Error(`${path}.electrical_binding is supported only for eligible voltage graphs`)
  }
  if (electrical_binding) {
    assertModelReferenceElectricalBindingInterface({
      binding: electrical_binding,
      model_interface,
      path: `${path}.electrical_binding`,
    })
  }
  return {
    graph_id,
    page,
    locator: nonEmptyString(value.locator, `${path}.locator`),
    x_axis: "time",
    time_axis_evidence: nonEmptyString(value.time_axis_evidence, `${path}.time_axis_evidence`),
    response_quantity,
    public_pin_observable: value.public_pin_observable,
    fixture_reproducible: value.fixture_reproducible,
    reason: nonEmptyString(value.reason, `${path}.reason`),
    crop,
    ...(electrical_binding ? { electrical_binding } : {}),
    ...(digitized_curve ? { digitized_curve } : {}),
  }
}
