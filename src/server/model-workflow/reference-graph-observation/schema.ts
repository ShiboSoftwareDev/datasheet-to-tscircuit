import type {
  ModelInterface,
  ModelReferenceChannelMeasurement,
  ModelReferenceCropRegion,
} from "../../modeling/types"
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
  ObservedReferenceChannel,
  ObservedReferencePoint,
  ObservedTimeCurve,
  ReferenceGraphAxisAnchor,
  ReferenceGraphAxisCalibration,
  ReferenceGraphAxisRange,
  ReferenceGraphClassification,
  ReferenceGraphTraceColor,
} from "./types"

export type ReferencePointFieldPolicy = "pixels_only" | "canonical"
export type ReferenceGraphArtifactPhase = "find" | "comparison"

export const MIN_TRACE_POINTS = 8
export const MAX_TRACE_POINTS = 96
const MAX_HORIZONTAL_PIXELS_PER_TRACE_POINT = 14
export const AXIS_CALIBRATION_TOLERANCE = 0.015
export const MIN_X_COVERAGE_RATIO = 0.98
export const MAX_NORMALIZED_RMSE = 0.05
export const MAX_NORMALIZED_ERROR = 0.1
export const MAX_OBSERVED_GRAPHS = 64
export const MAX_ELIGIBLE_GRAPHS = 32
export const MAX_CHANNELS_PER_GRAPH = 12

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

function rangeFromAxis(axis: ReferenceGraphAxisCalibration): ReferenceGraphAxisRange {
  return {
    min: Math.min(axis.first.value, axis.second.value),
    max: Math.max(axis.first.value, axis.second.value),
  }
}

function parseDigitizedCurve(
  value: unknown,
  path: string,
  crop: ModelReferenceCropRegion,
  point_field_policy: ReferencePointFieldPolicy,
): ObservedTimeCurve {
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
  if (value.y_quantity !== "voltage" && value.y_quantity !== "current") {
    throw new Error(`${path}.y_quantity must be voltage or current`)
  }
  const expected_y_unit = value.y_quantity === "voltage" ? "V" : "A"
  if (value.y_unit !== expected_y_unit) {
    throw new Error(`${path}.y_unit must be ${expected_y_unit} for ${value.y_quantity}`)
  }
  // x_range/y_range are accepted as redundant observer hints. The calibrated
  // anchors are the single source of truth, and the server derives canonical
  // ranges from them instead of asking an agent to keep duplicate numbers in
  // exact lockstep.
  parseAxisRange(value.x_range, `${path}.x_range`)
  parseAxisRange(value.y_range, `${path}.y_range`)
  const x_axis = parseAxisCalibration(value.x_axis, `${path}.x_axis`, "x_axis")
  const y_axis = parseAxisCalibration(value.y_axis, `${path}.y_axis`, "y_axis")
  const x_range = rangeFromAxis(x_axis)
  const y_range = rangeFromAxis(y_axis)
  if (x_range.min < 0) {
    throw new Error(
      `${path}.x_axis cannot contain negative elapsed time; translate pre-trigger time so the earliest calibrated time is 0 s`,
    )
  }
  if (!(x_axis.second.value > x_axis.first.value)) {
    throw new Error(`${path}.x_axis anchors must progress from minimum to maximum time`)
  }
  if (!(y_axis.second.value > y_axis.first.value)) {
    throw new Error(`${path}.y_axis anchors must progress from minimum to maximum value`)
  }
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
  if (points.some(({ x }) => x < 0)) {
    throw new Error(
      `${path}.points cannot contain negative elapsed time derived from the pixel-axis calibration; move the zero-time anchor to or before the earliest valid traced point. If source proof requires a later grid-line anchor, remove or retrace only earlier points that do not follow the rendered waveform before moving the anchor`,
    )
  }
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
    (largest, position, index) => {
      if (index === 0) return largest
      const prior = bounded_positions[index - 1]!
      const gap = position - prior
      return gap > largest.gap ? { gap, start: prior, end: position } : largest
    },
    { gap: 0, start: 0, end: 0 },
  )
  if (largest_gap.gap > 0.2) {
    const pixelAtPosition = (position: number) =>
      x_axis.first.pixel + position * x_pixel_span * x_pixel_direction
    throw new Error(
      `${path}.points cannot leave more than 20% of the calibrated time axis unsampled; largest gap is ${(largest_gap.gap * 100).toFixed(1)}% between crop-local x pixels ${pixelAtPosition(largest_gap.start).toFixed(1)} and ${pixelAtPosition(largest_gap.end).toFixed(1)}. Add one or more strictly increasing points on the rendered response trace inside this interval without changing accepted points outside it`,
    )
  }
  return {
    method: value.method,
    x_quantity: "time",
    x_unit: "s",
    y_quantity: value.y_quantity,
    y_unit: expected_y_unit,
    x_range,
    y_range,
    x_axis,
    y_axis,
    trace_color: parseTraceColor(value.trace_color, `${path}.trace_color`),
    points,
  }
}

function parseChannelMeasurement(
  value: unknown,
  path: string,
  model_interface: ModelInterface,
): ModelReferenceChannelMeasurement {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  if (value.type === "voltage") {
    rejectUnknownKeys(value, ["type", "positive", "negative"], path)
    const positive = nonEmptyString(value.positive, `${path}.positive`)
    const negative = nonEmptyString(value.negative, `${path}.negative`)
    const valid_endpoints = new Set([
      "gnd",
      ...model_interface.pins.map(({ spice_node }) => `dut.${spice_node}`),
    ])
    if (!valid_endpoints.has(positive)) throw new Error(`${path}.positive must name gnd or a public DUT pin`)
    if (!valid_endpoints.has(negative)) throw new Error(`${path}.negative must name gnd or a public DUT pin`)
    if (positive === negative) throw new Error(`${path} voltage endpoints must be distinct`)
    return {
      type: "voltage",
      positive: positive as Extract<ModelReferenceChannelMeasurement, { type: "voltage" }>["positive"],
      negative: negative as Extract<ModelReferenceChannelMeasurement, { type: "voltage" }>["negative"],
    }
  }
  if (value.type === "current") {
    rejectUnknownKeys(value, ["type", "element_id", "direction"], path)
    const element_id = nonEmptyString(value.element_id, `${path}.element_id`)
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(element_id)) {
      throw new Error(`${path}.element_id must be a stable fixture identifier`)
    }
    if (value.direction !== "positive_to_negative" && value.direction !== "negative_to_positive") {
      throw new Error(`${path}.direction must be positive_to_negative or negative_to_positive`)
    }
    return { type: "current", element_id, direction: value.direction }
  }
  throw new Error(`${path}.type must be voltage or current`)
}

function measurementsEqual(
  left: ModelReferenceChannelMeasurement,
  right: ModelReferenceChannelMeasurement,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function parseReferenceChannels(input: {
  value: unknown
  path: string
  crop: ModelReferenceCropRegion
  model_interface: ModelInterface
  point_field_policy: ReferencePointFieldPolicy
  electrical_binding: ReturnType<typeof parseModelReferenceElectricalBinding>
}): ObservedReferenceChannel[] {
  if (!Array.isArray(input.value)) throw new Error(`${input.path} must be an array`)
  if (input.value.length < 1 || input.value.length > MAX_CHANNELS_PER_GRAPH) {
    throw new Error(`${input.path} must contain 1 through ${MAX_CHANNELS_PER_GRAPH} plotted channels`)
  }
  const channel_results = input.value.map((value, index) => {
    const path = `${input.path}[${index}]`
    try {
      if (!isRecord(value)) throw new Error(`${path} must be an object`)
      rejectUnknownKeys(value, ["channel_id", "label", "role", "measurement", "digitized_curve"], path)
      const channel_id = nonEmptyString(value.channel_id, `${path}.channel_id`)
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(channel_id)) {
        throw new Error(`${path}.channel_id must use snake_case`)
      }
      if (value.role !== "response" && value.role !== "stimulus") {
        throw new Error(`${path}.role must be response or stimulus`)
      }
      const measurement = parseChannelMeasurement(
        value.measurement,
        `${path}.measurement`,
        input.model_interface,
      )
      const digitized_curve = parseDigitizedCurve(
        value.digitized_curve,
        `${path}.digitized_curve`,
        input.crop,
        input.point_field_policy,
      )
      if (digitized_curve.y_quantity !== measurement.type) {
        throw new Error(`${path}.digitized_curve quantity must match its ${measurement.type} measurement`)
      }
      return {
        channel: {
          channel_id,
          label: nonEmptyString(value.label, `${path}.label`),
          role: value.role,
          measurement,
          digitized_curve,
        } satisfies ObservedReferenceChannel,
      }
    } catch (error) {
      return { error: error instanceof Error ? error : new Error(String(error)) }
    }
  })
  const channel_errors = channel_results.flatMap((result) => (result.error ? [result.error] : []))
  if (channel_errors.length > 0) {
    const details = [...new Set(channel_errors.map((error) => error.message))]
    throw new AggregateError(
      channel_errors,
      `${input.path} contains ${channel_errors.length} invalid plotted channel${channel_errors.length === 1 ? "" : "s"}:\n${details.map((detail) => `- ${detail}`).join("\n")}`,
    )
  }
  const channels = channel_results.flatMap((result) => (result.channel ? [result.channel] : []))
  if (new Set(channels.map(({ channel_id }) => channel_id)).size !== channels.length) {
    throw new Error(`${input.path} channel ids must be unique within the source graph`)
  }
  const measurement_keys = channels.map(({ measurement }) => JSON.stringify(measurement))
  if (new Set(measurement_keys).size !== measurement_keys.length) {
    throw new Error(`${input.path} must not compare the same simulation measurement more than once`)
  }
  const time_calibrations = channels.map(({ digitized_curve }) =>
    JSON.stringify({ x_range: digitized_curve.x_range, x_axis: digitized_curve.x_axis }),
  )
  if (new Set(time_calibrations).size !== 1) {
    throw new Error(`${input.path} channels from one plotted graph must share one exact time calibration`)
  }
  const response_measurement: ModelReferenceChannelMeasurement = {
    type: "voltage",
    positive: input.electrical_binding.response.positive,
    negative: input.electrical_binding.response.negative,
  }
  const response_channels = channels.filter(
    ({ role, measurement }) => role === "response" && measurementsEqual(measurement, response_measurement),
  )
  if (response_channels.length !== 1) {
    throw new Error(`${input.path} must contain exactly one response channel bound to the printed response`)
  }
  if (input.electrical_binding.stimulus.type !== "steady_state") {
    const stimulus = input.electrical_binding.stimulus
    const expected_measurement: ModelReferenceChannelMeasurement =
      stimulus.type === "voltage_step"
        ? { type: "voltage", positive: stimulus.positive, negative: stimulus.negative }
        : { type: "current", element_id: "stimulus", direction: "positive_to_negative" }
    const stimulus_channels = channels.filter(
      ({ role, measurement }) => role === "stimulus" && measurementsEqual(measurement, expected_measurement),
    )
    const all_stimulus_channels = channels.filter(({ role }) => role === "stimulus")
    if (stimulus_channels.length !== all_stimulus_channels.length || all_stimulus_channels.length > 1) {
      throw new Error(
        `${input.path} may assign stimulus role only to the one plotted channel matching the bound step`,
      )
    }
  }
  return channels
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
  phase: ReferenceGraphArtifactPhase = "comparison",
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
      "channels",
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
  const is_eligible =
    response_quantity === "voltage" && value.public_pin_observable && value.fixture_reproducible
  const electrical_binding =
    value.electrical_binding === undefined
      ? undefined
      : parseModelReferenceElectricalBinding(value.electrical_binding, `${path}.electrical_binding`)
  if (phase === "find" && electrical_binding) {
    throw new Error(`${path}.electrical_binding belongs to Create Comparison Graphs and must be omitted`)
  }
  if (phase === "comparison" && is_eligible && !electrical_binding) {
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
  const channels =
    value.channels === undefined || !electrical_binding
      ? undefined
      : parseReferenceChannels({
          value: value.channels,
          path: `${path}.channels`,
          crop,
          model_interface,
          point_field_policy,
          electrical_binding,
        })
  if (phase === "find" && value.channels !== undefined) {
    throw new Error(`${path}.channels belongs to Create Comparison Graphs and must be omitted`)
  }
  if (phase === "comparison" && is_eligible && !channels) {
    throw new Error(`${path}.channels is required for every eligible source graph`)
  }
  if (!is_eligible && value.channels !== undefined) {
    throw new Error(`${path}.channels is supported only for eligible source graphs`)
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
    ...(channels ? { channels } : {}),
  }
}
