import { readFile } from "node:fs/promises"
import sharp from "sharp"
import { resolveWorkspaceFile } from "./parse-benchmark-manifest"

export interface TraceColor {
  r: number
  g: number
  b: number
  tolerance: number
}

interface TraceAxisAnchor {
  pixel: number
  value: number
}

interface TraceAxisCalibration {
  scale: "linear" | "log"
  first: TraceAxisAnchor
  second: TraceAxisAnchor
}

interface TracePoint {
  pixel_x: number
  pixel_y: number
  x: number
  y: number
}

interface TraceProvenance {
  version: 1
  method: "manual_pixel_trace" | "image_color_trace"
  source_image: string
  trace_color: TraceColor
  x_axis: TraceAxisCalibration
  y_axis: TraceAxisCalibration
  points: TracePoint[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`)
  return value
}

function parseAnchor(value: unknown, label: string): TraceAxisAnchor {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  return {
    pixel: finiteNumber(value.pixel, `${label}.pixel`),
    value: finiteNumber(value.value, `${label}.value`),
  }
}

function parseAxis(value: unknown, label: string, expected_scale: "linear" | "log"): TraceAxisCalibration {
  if (!isRecord(value) || (value.scale !== "linear" && value.scale !== "log")) {
    throw new Error(`${label} must declare a linear or log calibration`)
  }
  if (value.scale !== expected_scale) {
    throw new Error(`${label}.scale must match the benchmark ${expected_scale} scale`)
  }
  const first = parseAnchor(value.first, `${label}.first`)
  const second = parseAnchor(value.second, `${label}.second`)
  if (first.pixel === second.pixel) throw new Error(`${label} calibration pixels must be distinct`)
  if (expected_scale === "log" && (first.value <= 0 || second.value <= 0)) {
    throw new Error(`${label} log calibration values must be positive`)
  }
  return { scale: expected_scale, first, second }
}

function parseColor(value: unknown, label: string): TraceColor {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  const color = {
    r: finiteNumber(value.r, `${label}.r`),
    g: finiteNumber(value.g, `${label}.g`),
    b: finiteNumber(value.b, `${label}.b`),
    tolerance: finiteNumber(value.tolerance, `${label}.tolerance`),
  }
  if (
    !Number.isInteger(color.r) ||
    !Number.isInteger(color.g) ||
    !Number.isInteger(color.b) ||
    color.r < 0 ||
    color.r > 255 ||
    color.g < 0 ||
    color.g > 255 ||
    color.b < 0 ||
    color.b > 255
  ) {
    throw new Error(`${label} RGB values must be integers from 0 through 255`)
  }
  if (color.tolerance < 4 || color.tolerance > 120) {
    throw new Error(`${label}.tolerance must be from 4 through 120`)
  }
  return color
}

function parseProvenance(
  value: unknown,
  input: {
    benchmark_id: string
    series_id: string
    source_image: string
    x_scale: "linear" | "log"
    y_scale: "linear" | "log"
  },
): TraceProvenance {
  const label = `${input.benchmark_id}/${input.series_id} trace provenance`
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.method !== "manual_pixel_trace" && value.method !== "image_color_trace")
  ) {
    throw new Error(`${label} must use version 1 manual_pixel_trace or image_color_trace`)
  }
  if (value.source_image !== input.source_image) {
    throw new Error(`${label} source_image must be ${input.source_image}`)
  }
  if (!Array.isArray(value.points) || value.points.length < 8) {
    throw new Error(`${label} must contain at least 8 traced pixel points`)
  }
  const points = value.points.map((point, index): TracePoint => {
    if (!isRecord(point)) throw new Error(`${label} point ${index + 1} must be an object`)
    return {
      pixel_x: finiteNumber(point.pixel_x, `${label} point ${index + 1}.pixel_x`),
      pixel_y: finiteNumber(point.pixel_y, `${label} point ${index + 1}.pixel_y`),
      x: finiteNumber(point.x, `${label} point ${index + 1}.x`),
      y: finiteNumber(point.y, `${label} point ${index + 1}.y`),
    }
  })
  return {
    version: 1,
    method: value.method,
    source_image: input.source_image,
    trace_color: parseColor(value.trace_color, `${label}.trace_color`),
    x_axis: parseAxis(value.x_axis, `${label}.x_axis`, input.x_scale),
    y_axis: parseAxis(value.y_axis, `${label}.y_axis`, input.y_scale),
    points,
  }
}

function valueAtPixel(axis: TraceAxisCalibration, pixel: number): number {
  const ratio = (pixel - axis.first.pixel) / (axis.second.pixel - axis.first.pixel)
  if (axis.scale === "log") {
    return Math.exp(
      Math.log(axis.first.value) + ratio * (Math.log(axis.second.value) - Math.log(axis.first.value)),
    )
  }
  return axis.first.value + ratio * (axis.second.value - axis.first.value)
}

function valuesAgree(actual: number, expected: number, span: number): boolean {
  return Math.abs(actual - expected) <= Math.max(1e-8, Math.abs(span) * 0.015, Math.abs(expected) * 1e-6)
}

function colorDistance(data: Buffer, offset: number, color: TraceColor): number {
  return Math.hypot(data[offset]! - color.r, data[offset + 1]! - color.g, data[offset + 2]! - color.b)
}

function pointTouchesTrace(input: {
  data: Buffer
  width: number
  height: number
  channels: number
  pixel_x: number
  pixel_y: number
  color: TraceColor
}): boolean {
  const center_x = Math.round(input.pixel_x)
  const center_y = Math.round(input.pixel_y)
  for (let y = Math.max(0, center_y - 4); y <= Math.min(input.height - 1, center_y + 4); y += 1) {
    for (let x = Math.max(0, center_x - 4); x <= Math.min(input.width - 1, center_x + 4); x += 1) {
      const offset = (y * input.width + x) * input.channels
      if (colorDistance(input.data, offset, input.color) <= input.color.tolerance) return true
    }
  }
  return false
}

function getColorCoverage(input: {
  data: Buffer
  width: number
  height: number
  channels: number
  color: TraceColor
}): number {
  let matching = 0
  let sampled = 0
  const pixel_count = input.width * input.height
  const stride = Math.max(1, Math.floor(pixel_count / 300_000))
  for (let pixel = 0; pixel < pixel_count; pixel += stride) {
    sampled += 1
    if (colorDistance(input.data, pixel * input.channels, input.color) <= input.color.tolerance) matching += 1
  }
  return sampled === 0 ? 0 : matching / sampled
}

export async function validateTraceProvenance(input: {
  model_dir: string
  benchmark_id: string
  series_id: string
  role?: "response" | "stimulus"
  source_image: string
  trace_file: string
  points: Array<{ x: number; y: number }>
  x_scale: "linear" | "log"
  y_scale: "linear" | "log"
}): Promise<TraceColor> {
  const provenance_value: unknown = JSON.parse(
    await readFile(resolveWorkspaceFile(input.model_dir, input.trace_file), "utf8"),
  )
  const provenance = parseProvenance(provenance_value, input)
  if (provenance.points.length !== input.points.length) {
    throw new Error(
      `${input.benchmark_id}/${input.series_id} trace provenance has ${provenance.points.length} points but its reference CSV has ${input.points.length}`,
    )
  }

  const image_path = resolveWorkspaceFile(input.model_dir, input.source_image)
  const decoded = await sharp(image_path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = decoded.info
  const x_span = provenance.x_axis.second.value - provenance.x_axis.first.value
  const y_span = provenance.y_axis.second.value - provenance.y_axis.first.value
  const x_pixel_span = Math.abs(provenance.x_axis.second.pixel - provenance.x_axis.first.pixel)
  const y_pixel_span = Math.abs(provenance.y_axis.second.pixel - provenance.y_axis.first.pixel)
  if (
    provenance.x_axis.first.pixel < 0 ||
    provenance.x_axis.first.pixel >= width ||
    provenance.x_axis.second.pixel < 0 ||
    provenance.x_axis.second.pixel >= width
  ) {
    throw new Error(
      `${input.benchmark_id}/${input.series_id} x-axis calibration anchors must be inside its source image`,
    )
  }
  if (
    provenance.y_axis.first.pixel < 0 ||
    provenance.y_axis.first.pixel >= height ||
    provenance.y_axis.second.pixel < 0 ||
    provenance.y_axis.second.pixel >= height
  ) {
    throw new Error(
      `${input.benchmark_id}/${input.series_id} y-axis calibration anchors must be inside its source image`,
    )
  }
  const minimum_point_count = Math.min(48, Math.max(8, Math.ceil(x_pixel_span / 12)))
  if (provenance.points.length < minimum_point_count) {
    throw new Error(
      `${input.benchmark_id}/${input.series_id} trace provenance has only ${provenance.points.length} points across a ${Math.round(
        x_pixel_span,
      )}-pixel time axis; at least ${minimum_point_count} distributed points are required to preserve the complete waveform`,
    )
  }
  if (!(x_pixel_span > 0) || !(y_pixel_span > 0)) {
    throw new Error(
      `${input.benchmark_id}/${input.series_id} trace provenance must calibrate non-zero plotted axis spans`,
    )
  }
  if (input.role === "stimulus") {
    for (let index = 1; index < provenance.points.length; index += 1) {
      const previous = provenance.points[index - 1]!
      const current = provenance.points[index]!
      const horizontal_gap = Math.abs(current.pixel_x - previous.pixel_x) / x_pixel_span
      const vertical_jump = Math.abs(current.pixel_y - previous.pixel_y) / y_pixel_span
      if (horizontal_gap > 0.025 && vertical_jump > 0.1) {
        throw new Error(
          `${input.benchmark_id}/${input.series_id} stimulus trace jumps ${(vertical_jump * 100).toFixed(
            1,
          )}% of the vertical span between points ${index} and ${index + 1} while leaving ${(
            horizontal_gap * 100
          ).toFixed(
            1,
          )}% of the time axis unsampled; trace the actual waveform centerline, not labels or markers, and place neighboring points tightly around each real edge`,
        )
      }
    }
  }
  const x_pixel_direction = Math.sign(provenance.x_axis.second.pixel - provenance.x_axis.first.pixel)
  const normalized_x_positions = provenance.points.map(
    (point) => ((point.pixel_x - provenance.x_axis.first.pixel) * x_pixel_direction) / x_pixel_span,
  )
  for (let index = 1; index < normalized_x_positions.length; index += 1) {
    if (normalized_x_positions[index]! <= normalized_x_positions[index - 1]!) {
      throw new Error(
        `${input.benchmark_id}/${input.series_id} trace pixels must progress strictly across the time axis without reused or backward x positions`,
      )
    }
  }
  const first_x_position = normalized_x_positions[0]!
  const last_x_position = normalized_x_positions.at(-1)!
  if (first_x_position > 0.1 || last_x_position < 0.9) {
    throw new Error(
      `${input.benchmark_id}/${input.series_id} traced points cover only ${(
        Math.max(0, last_x_position - first_x_position) * 100
      ).toFixed(
        1,
      )}% of the calibrated time axis; trace the complete waveform from its left edge through its right edge`,
    )
  }
  const bounded_x_positions = [
    0,
    ...normalized_x_positions.filter((position) => position > 0 && position < 1),
    1,
  ]
  const largest_x_gap = bounded_x_positions.reduce(
    (largest, position, index) =>
      index === 0 ? largest : Math.max(largest, position - bounded_x_positions[index - 1]!),
    0,
  )
  if (largest_x_gap > 0.2) {
    throw new Error(
      `${input.benchmark_id}/${input.series_id} trace provenance leaves ${(largest_x_gap * 100).toFixed(
        1,
      )}% of the time axis unsampled in one gap; distribute points across the complete waveform`,
    )
  }
  const off_trace_points: number[] = []

  for (let index = 0; index < provenance.points.length; index += 1) {
    const traced = provenance.points[index]!
    const csv = input.points[index]!
    if (traced.pixel_x < 0 || traced.pixel_x >= width || traced.pixel_y < 0 || traced.pixel_y >= height) {
      throw new Error(
        `${input.benchmark_id}/${input.series_id} trace point ${index + 1} is outside its source image`,
      )
    }
    if (!valuesAgree(traced.x, csv.x, x_span) || !valuesAgree(traced.y, csv.y, y_span)) {
      throw new Error(
        `${input.benchmark_id}/${input.series_id} trace point ${index + 1} does not match its reference CSV`,
      )
    }
    const calibrated_x = valueAtPixel(provenance.x_axis, traced.pixel_x)
    const calibrated_y = valueAtPixel(provenance.y_axis, traced.pixel_y)
    if (!valuesAgree(traced.x, calibrated_x, x_span) || !valuesAgree(traced.y, calibrated_y, y_span)) {
      throw new Error(
        `${input.benchmark_id}/${input.series_id} trace point ${index + 1} is inconsistent with its pixel-axis calibration`,
      )
    }
    if (
      !pointTouchesTrace({
        data: decoded.data,
        width,
        height,
        channels,
        pixel_x: traced.pixel_x,
        pixel_y: traced.pixel_y,
        color: provenance.trace_color,
      })
    ) {
      off_trace_points.push(index + 1)
    }
  }

  const coverage = getColorCoverage({
    data: decoded.data,
    width,
    height,
    channels,
    color: provenance.trace_color,
  })
  if (coverage < 0.000005) {
    throw new Error(
      `${input.benchmark_id}/${input.series_id} declared trace color is absent from its source image`,
    )
  }
  if (coverage > 0.2) {
    throw new Error(
      `${input.benchmark_id}/${input.series_id} declared trace color covers ${(coverage * 100).toFixed(1)}% of its source image and appears to be the background rather than a waveform`,
    )
  }
  if (off_trace_points.length > Math.max(1, Math.floor(provenance.points.length * 0.05))) {
    throw new Error(
      `${input.benchmark_id}/${input.series_id} has ${off_trace_points.length} traced points that do not touch the declared waveform color`,
    )
  }
  return provenance.trace_color
}

function rgbToHue(color: Pick<TraceColor, "r" | "g" | "b">): number | undefined {
  const r = color.r / 255
  const g = color.g / 255
  const b = color.b / 255
  const maximum = Math.max(r, g, b)
  const minimum = Math.min(r, g, b)
  const delta = maximum - minimum
  if (delta < 0.12 || maximum < 0.18) return undefined
  let hue = 0
  if (maximum === r) hue = ((g - b) / delta) % 6
  else if (maximum === g) hue = (b - r) / delta + 2
  else hue = (r - g) / delta + 4
  return ((hue * 60 + 360) % 360) / 30
}

function countHueClusters(buckets: Set<number>): number {
  if (buckets.size === 0) return 0
  let clusters = 0
  for (let bucket = 0; bucket < 12; bucket += 1) {
    if (buckets.has(bucket) && !buckets.has((bucket + 11) % 12)) clusters += 1
  }
  return clusters === 0 ? 1 : clusters
}

const HUE_BUCKET_LABELS = [
  "red",
  "orange",
  "yellow",
  "yellow-green",
  "green",
  "cyan-green",
  "cyan",
  "blue-cyan",
  "blue",
  "violet",
  "magenta",
  "red-magenta",
] as const

function describeHueBuckets(buckets: Set<number>): string {
  return [...buckets]
    .sort((a, b) => a - b)
    .map((bucket) => HUE_BUCKET_LABELS[bucket] ?? `hue-${bucket}`)
    .join(", ")
}

export async function validateFigureTraceColorCoverage(input: {
  model_dir: string
  benchmark_id: string
  source_image: string
  trace_colors: TraceColor[]
}): Promise<void> {
  const decoded = await sharp(resolveWorkspaceFile(input.model_dir, input.source_image))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height, channels } = decoded.info
  const counts = Array.from({ length: 12 }, () => 0)
  const occupied_x_bins = Array.from({ length: 12 }, () => new Set<number>())
  const x_bin_count = 40
  const pixel_count = width * height
  const stride = Math.max(1, Math.floor(pixel_count / 400_000))
  let sampled = 0
  for (let pixel = 0; pixel < pixel_count; pixel += stride) {
    sampled += 1
    const offset = pixel * channels
    const hue = rgbToHue({
      r: decoded.data[offset]!,
      g: decoded.data[offset + 1]!,
      b: decoded.data[offset + 2]!,
    })
    if (hue !== undefined) {
      const bucket = Math.floor(hue) % 12
      counts[bucket] += 1
      const x = pixel % width
      occupied_x_bins[bucket]!.add(Math.min(x_bin_count - 1, Math.floor((x / width) * x_bin_count)))
    }
  }
  const visible_buckets = new Set(
    counts.flatMap((count, bucket) =>
      count >= Math.max(4, sampled * 0.00002) &&
      count <= sampled * 0.12 &&
      occupied_x_bins[bucket]!.size >= Math.ceil(x_bin_count * 0.2)
        ? [bucket]
        : [],
    ),
  )
  const visible_clusters = countHueClusters(visible_buckets)
  const declared_buckets = new Set(
    input.trace_colors.flatMap((color) => {
      const hue = rgbToHue(color)
      return hue === undefined ? [] : [Math.floor(hue) % 12]
    }),
  )
  const declared_clusters = countHueClusters(declared_buckets)
  if (visible_clusters >= 3 && declared_clusters < visible_clusters) {
    throw new Error(
      `Benchmark ${input.benchmark_id} source image contains at least ${visible_clusters} distinct colored waveform traces but only ${declared_clusters} are represented by trace provenance. Visible hue buckets: [${describeHueBuckets(
        visible_buckets,
      )}]; declared trace hue buckets: [${describeHueBuckets(
        declared_buckets,
      )}]. Add independently traced series for the missing waveform colors, or recrop the exact graph more tightly if legends or unrelated graphics were included.`,
    )
  }
}
