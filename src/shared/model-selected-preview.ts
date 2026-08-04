import type { AnyCircuitElement } from "circuit-json"
import type {
  ModelCircuitPreview,
  ModelCurvePoint,
  ModelPreviewArtifactIdentity,
  ModelReferencePreview,
  ModelReferenceSeriesPreview,
  ModelSelectedPreview,
} from "./job-types"
import { hasCompletedTransientSimulation } from "./model-preview-capabilities"

type JsonRecord = Record<string, unknown>

export interface ModelSelectedPreviewParseOptions {
  /** Version 3 publications must retain the exact fresh waveform UI contract. */
  fresh_accepted?: boolean
  /** When supplied, a present identity must select this exact immutable artifact. */
  expected_artifact_identity?: ModelPreviewArtifactIdentity
  /** New candidate readers can require identity without opting into the full accepted contract. */
  require_artifact_identity?: boolean
}

export const MODEL_PREVIEW_GENERATION_PATTERN = /^[a-zA-Z0-9_-]{16,200}$/
export const MODEL_PREVIEW_REVISION_PATTERN = /^[a-f0-9]{16}$/

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function fail(path: string, message: string): never {
  throw new Error(`${path} ${message}`)
}

function assertExactKeys(value: JsonRecord, allowed: readonly string[], path: string): void {
  const allowed_keys = new Set(allowed)
  const unexpected = Object.keys(value).filter((key) => !allowed_keys.has(key))
  if (unexpected.length > 0) fail(path, `contains unexpected field ${unexpected[0]}`)
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(path, "must be a non-empty string")
  return value
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") fail(path, "must be a string")
  return value
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") fail(path, "must be a boolean")
  return value
}

function optionalFiniteNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number")
  return value
}

function requiredEnum<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    fail(path, `must be one of ${values.join(", ")}`)
  }
  return value as T
}

function optionalEnum<T extends string>(value: unknown, values: readonly T[], path: string): T | undefined {
  if (value === undefined) return undefined
  return requiredEnum(value, values, path)
}

function requiredTimestamp(value: unknown, path: string): string {
  const timestamp = requiredString(value, path)
  if (!Number.isFinite(Date.parse(timestamp))) fail(path, "must be a valid timestamp")
  return timestamp
}

export function parseModelPreviewArtifactIdentity(
  value: unknown,
  path = "artifact_identity",
): ModelPreviewArtifactIdentity {
  if (!isRecord(value)) fail(path, "must be an object")
  assertExactKeys(value, ["preview_generation", "model_revision"], path)
  const preview_generation = requiredString(value.preview_generation, `${path}.preview_generation`)
  const model_revision = requiredString(value.model_revision, `${path}.model_revision`)
  if (!MODEL_PREVIEW_GENERATION_PATTERN.test(preview_generation)) {
    fail(`${path}.preview_generation`, "must be a safe immutable preview generation")
  }
  if (!MODEL_PREVIEW_REVISION_PATTERN.test(model_revision)) {
    fail(`${path}.model_revision`, "must be a 16-character lowercase model revision")
  }
  return value as unknown as ModelPreviewArtifactIdentity
}

export function modelPreviewArtifactIdentitiesEqual(
  first: ModelPreviewArtifactIdentity,
  second: ModelPreviewArtifactIdentity,
): boolean {
  return (
    first.preview_generation === second.preview_generation && first.model_revision === second.model_revision
  )
}

function parseCurvePoint(value: unknown, path: string): ModelCurvePoint {
  if (!isRecord(value)) fail(path, "must be an object")
  assertExactKeys(value, ["x", "y"], path)
  if (typeof value.x !== "number" || !Number.isFinite(value.x)) fail(`${path}.x`, "must be finite")
  if (typeof value.y !== "number" || !Number.isFinite(value.y)) fail(`${path}.y`, "must be finite")
  return value as unknown as ModelCurvePoint
}

function parseCurvePoints(value: unknown, path: string): ModelCurvePoint[] {
  if (!Array.isArray(value)) fail(path, "must be an array")
  value.forEach((point, index) => parseCurvePoint(point, `${path}[${index}]`))
  return value as ModelCurvePoint[]
}

function assertStrictlyIncreasingCurve(points: readonly ModelCurvePoint[], path: string): void {
  for (let index = 1; index < points.length; index += 1) {
    if (points[index]!.x <= points[index - 1]!.x) {
      fail(path, `must have a strictly increasing time axis; sample ${index} does not advance`)
    }
  }
}

function curvePointsEqual(
  first: readonly ModelCurvePoint[] | undefined,
  second: readonly ModelCurvePoint[] | undefined,
): boolean {
  if (!first || !second) return first === second
  return (
    first.length === second.length &&
    first.every((point, index) => point.x === second[index]?.x && point.y === second[index]?.y)
  )
}

function referenceBoundsEqual(
  first: ModelReferencePreview["reference_bounds"],
  second: ModelReferenceSeriesPreview["reference_bounds"],
): boolean {
  return first?.min === second?.min && first?.max === second?.max
}

function assertTimeDomainComparison(preview: ModelReferencePreview, path: string): void {
  if (preview.x_axis_label?.trim().toLowerCase() !== "time" || preview.x_axis_unit?.trim() !== "s") {
    fail(path, "must identify its comparison x-axis as time in seconds")
  }
  if (preview.x_scale !== "linear") {
    fail(`${path}.x_scale`, "must be linear for a tscircuit transient comparison")
  }
  assertStrictlyIncreasingCurve(preview.reference_points, `${path}.reference_points`)
  if (preview.result_points) {
    assertStrictlyIncreasingCurve(preview.result_points, `${path}.result_points`)
  }
  preview.series?.forEach((series, index) => {
    if (series.reference_kind !== "curve") {
      fail(`${path}.series[${index}].reference_kind`, "must be curve for a transient comparison")
    }
    assertStrictlyIncreasingCurve(series.reference_points, `${path}.series[${index}].reference_points`)
    if (series.result_points) {
      assertStrictlyIncreasingCurve(series.result_points, `${path}.series[${index}].result_points`)
    }
  })
}

function assertPrimaryResponseMirror(preview: ModelReferencePreview, path: string): void {
  const primary_response = preview.series?.find(({ role }) => role === "response")
  if (!primary_response) {
    fail(path, "must retain a primary response comparison series")
  }
  const mirrors_primary =
    preview.source_file === primary_response.source_file &&
    preview.result_file === primary_response.result_file &&
    preview.y_axis_unit === primary_response.unit &&
    preview.y_scale === primary_response.y_scale &&
    preview.reference_kind === primary_response.reference_kind &&
    curvePointsEqual(preview.reference_points, primary_response.reference_points) &&
    referenceBoundsEqual(preview.reference_bounds, primary_response.reference_bounds) &&
    curvePointsEqual(preview.result_points, primary_response.result_points)
  if (!mirrors_primary) {
    fail(path, "must exactly mirror its primary response series in the visible comparison fields")
  }
}

function parseReferenceBounds(value: unknown, path: string): { min?: number; max?: number } | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) fail(path, "must be an object")
  assertExactKeys(value, ["min", "max"], path)
  const minimum = optionalFiniteNumber(value.min, `${path}.min`)
  const maximum = optionalFiniteNumber(value.max, `${path}.max`)
  if (minimum === undefined && maximum === undefined) fail(path, "must define min or max")
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    fail(path, "must not have min greater than max")
  }
  return value as { min?: number; max?: number }
}

function parseReferenceSeries(value: unknown, path: string): ModelReferenceSeriesPreview {
  if (!isRecord(value)) fail(path, "must be an object")
  assertExactKeys(
    value,
    [
      "series_id",
      "title",
      "role",
      "quantity",
      "unit",
      "source_file",
      "result_file",
      "y_scale",
      "reference_kind",
      "reference_points",
      "reference_bounds",
      "result_points",
      "normalized_rmse",
      "normalized_max_error",
      "matches_reference",
    ],
    path,
  )
  requiredString(value.series_id, `${path}.series_id`)
  requiredString(value.title, `${path}.title`)
  requiredEnum(value.role, ["response", "stimulus"], `${path}.role`)
  requiredString(value.quantity, `${path}.quantity`)
  requiredString(value.unit, `${path}.unit`)
  requiredString(value.source_file, `${path}.source_file`)
  optionalString(value.result_file, `${path}.result_file`)
  requiredEnum(value.y_scale, ["linear", "log"], `${path}.y_scale`)
  optionalEnum(value.reference_kind, ["curve", "target", "bounds"], `${path}.reference_kind`)
  parseCurvePoints(value.reference_points, `${path}.reference_points`)
  parseReferenceBounds(value.reference_bounds, `${path}.reference_bounds`)
  if (value.result_points !== undefined) parseCurvePoints(value.result_points, `${path}.result_points`)
  optionalFiniteNumber(value.normalized_rmse, `${path}.normalized_rmse`)
  optionalFiniteNumber(value.normalized_max_error, `${path}.normalized_max_error`)
  optionalBoolean(value.matches_reference, `${path}.matches_reference`)
  return value as unknown as ModelReferenceSeriesPreview
}

function parseCircuitJson(value: unknown, path: string): AnyCircuitElement[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) fail(path, "must be a non-empty Circuit JSON array")
  value.forEach((element, index) => {
    if (!isRecord(element) || typeof element.type !== "string" || element.type.length === 0) {
      fail(`${path}[${index}]`, "must be a Circuit JSON object with a non-empty type")
    }
  })
  return value as AnyCircuitElement[]
}

function parseCircuitPreview(value: unknown, path: string): ModelCircuitPreview | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) fail(path, "must be an object")
  assertExactKeys(
    value,
    [
      "source_file",
      "code",
      "build_status",
      "updated_at",
      "circuit_json",
      "analysis_type",
      "analog_simulation_status",
      "snapshot_origin",
      "is_stale",
      "error_message",
    ],
    path,
  )
  requiredString(value.source_file, `${path}.source_file`)
  if (typeof value.code !== "string") fail(`${path}.code`, "must be a string")
  requiredEnum(value.build_status, ["source_ready", "building", "ready", "failed"], `${path}.build_status`)
  requiredTimestamp(value.updated_at, `${path}.updated_at`)
  const circuit_json = parseCircuitJson(value.circuit_json, `${path}.circuit_json`)
  const analysis_type = optionalEnum(
    value.analysis_type,
    ["operating_point", "dc_sweep", "transient"],
    `${path}.analysis_type`,
  )
  const analog_status = optionalEnum(
    value.analog_simulation_status,
    ["available", "unsupported", "failed"],
    `${path}.analog_simulation_status`,
  )
  optionalEnum(value.snapshot_origin, ["workspace", "server_validation"], `${path}.snapshot_origin`)
  optionalBoolean(value.is_stale, `${path}.is_stale`)
  optionalString(value.error_message, `${path}.error_message`)
  if (
    analog_status === "available" &&
    (analysis_type !== "transient" ||
      value.build_status !== "ready" ||
      !circuit_json ||
      !hasCompletedTransientSimulation(circuit_json))
  ) {
    fail(path, "claims an available analog simulation without a completed supported transient waveform")
  }
  return value as unknown as ModelCircuitPreview
}

function parseReferencePreview(value: unknown, path: string): ModelReferencePreview | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) fail(path, "must be an object")
  assertExactKeys(
    value,
    [
      "benchmark_id",
      "title",
      "source_file",
      "result_file",
      "x_axis_label",
      "x_axis_unit",
      "y_axis_label",
      "y_axis_unit",
      "x_scale",
      "y_scale",
      "reference_kind",
      "reference_points",
      "reference_bounds",
      "result_points",
      "series",
      "result_status",
      "result_origin",
      "normalized_rmse",
      "normalized_max_error",
      "matches_reference",
      "is_stale",
      "updated_at",
    ],
    path,
  )
  optionalString(value.benchmark_id, `${path}.benchmark_id`)
  requiredString(value.title, `${path}.title`)
  requiredString(value.source_file, `${path}.source_file`)
  optionalString(value.result_file, `${path}.result_file`)
  optionalString(value.x_axis_label, `${path}.x_axis_label`)
  optionalString(value.x_axis_unit, `${path}.x_axis_unit`)
  optionalString(value.y_axis_label, `${path}.y_axis_label`)
  optionalString(value.y_axis_unit, `${path}.y_axis_unit`)
  requiredEnum(value.x_scale, ["linear", "log"], `${path}.x_scale`)
  requiredEnum(value.y_scale, ["linear", "log"], `${path}.y_scale`)
  optionalEnum(value.reference_kind, ["curve", "target", "bounds"], `${path}.reference_kind`)
  parseCurvePoints(value.reference_points, `${path}.reference_points`)
  parseReferenceBounds(value.reference_bounds, `${path}.reference_bounds`)
  if (value.result_points !== undefined) parseCurvePoints(value.result_points, `${path}.result_points`)
  if (value.series !== undefined) {
    if (!Array.isArray(value.series)) fail(`${path}.series`, "must be an array")
    value.series.forEach((series, index) => parseReferenceSeries(series, `${path}.series[${index}]`))
  }
  optionalEnum(
    value.result_status,
    ["unverified", "partial", "verified", "failed", "cancelled", "deprecated"],
    `${path}.result_status`,
  )
  optionalEnum(
    value.result_origin,
    ["workspace", "server_validation", "tscircuit_viewer"],
    `${path}.result_origin`,
  )
  optionalFiniteNumber(value.normalized_rmse, `${path}.normalized_rmse`)
  optionalFiniteNumber(value.normalized_max_error, `${path}.normalized_max_error`)
  optionalBoolean(value.matches_reference, `${path}.matches_reference`)
  optionalBoolean(value.is_stale, `${path}.is_stale`)
  requiredTimestamp(value.updated_at, `${path}.updated_at`)
  return value as unknown as ModelReferencePreview
}

export function tryParseModelCircuitPreview(value: unknown): ModelCircuitPreview | undefined {
  try {
    return parseCircuitPreview(value, "circuit_preview")
  } catch {
    return undefined
  }
}

export function tryParseModelReferencePreview(value: unknown): ModelReferencePreview | undefined {
  try {
    return parseReferencePreview(value, "reference_preview")
  } catch {
    return undefined
  }
}

/** Parses the versionless preview payload shared by storage, restore, and the web client. */
export function parseModelSelectedPreview(
  value: unknown,
  options: ModelSelectedPreviewParseOptions = {},
): ModelSelectedPreview {
  if (!isRecord(value)) fail("Stored model preview", "must be a JSON object")
  assertExactKeys(
    value,
    ["artifact_identity", "circuit_preview", "reference_preview"],
    "Stored model preview",
  )
  const artifact_identity =
    value.artifact_identity === undefined
      ? undefined
      : parseModelPreviewArtifactIdentity(value.artifact_identity)
  if ((options.fresh_accepted || options.require_artifact_identity) && !artifact_identity) {
    fail("Stored model preview.artifact_identity", "is required for this immutable preview bundle")
  }
  if (
    artifact_identity &&
    options.expected_artifact_identity &&
    !modelPreviewArtifactIdentitiesEqual(artifact_identity, options.expected_artifact_identity)
  ) {
    fail(
      "Stored model preview.artifact_identity",
      `does not match preview generation ${options.expected_artifact_identity.preview_generation} and model revision ${options.expected_artifact_identity.model_revision}`,
    )
  }
  const circuit_preview = parseCircuitPreview(value.circuit_preview, "circuit_preview")
  const reference_preview = parseReferencePreview(value.reference_preview, "reference_preview")
  if (!circuit_preview && !reference_preview) {
    fail("Stored model preview", "must contain circuit_preview or reference_preview")
  }
  const requires_time_domain_reference_integrity =
    reference_preview !== undefined &&
    ((circuit_preview?.analysis_type === "transient" && reference_preview.reference_kind === "curve") ||
      reference_preview.result_origin === "tscircuit_viewer")
  if (requires_time_domain_reference_integrity) {
    if (reference_preview.reference_kind !== "curve") {
      fail("reference_preview.reference_kind", "must be curve for a tscircuit viewer result")
    }
    assertTimeDomainComparison(reference_preview, "reference_preview")
    assertPrimaryResponseMirror(reference_preview, "reference_preview")
  }
  if (circuit_preview?.analog_simulation_status === "available") {
    if (
      circuit_preview.code.trim().length === 0 ||
      circuit_preview.snapshot_origin !== "server_validation" ||
      circuit_preview.is_stale === true
    ) {
      fail(
        "Stored model preview",
        "cannot expose an analog simulation without non-stale server-validated TSX and Circuit JSON",
      )
    }
    if (
      !reference_preview ||
      reference_preview.reference_kind !== "curve" ||
      reference_preview.reference_points.length < 2 ||
      !reference_preview.result_points ||
      reference_preview.result_points.length < 2 ||
      reference_preview.result_origin !== "tscircuit_viewer" ||
      reference_preview.is_stale === true
    ) {
      fail(
        "Stored model preview",
        "cannot expose an analog simulation without its non-stale datasheet curve and viewer result",
      )
    }
    const graph_count =
      circuit_preview.circuit_json?.filter(({ type }) => type === "simulation_transient_voltage_graph")
        .length ?? 0
    const response_series_count =
      reference_preview.series?.filter(
        ({ role, reference_kind }) => role === "response" && reference_kind === "curve",
      ).length ?? 0
    if (graph_count !== response_series_count) {
      fail(
        "Stored model preview",
        `contains ${graph_count} voltage graphs for ${response_series_count} response comparison series`,
      )
    }
  }
  if (options.fresh_accepted) {
    if (
      !circuit_preview ||
      circuit_preview.code.trim().length === 0 ||
      circuit_preview.build_status !== "ready" ||
      circuit_preview.analysis_type !== "transient" ||
      circuit_preview.analog_simulation_status !== "available" ||
      circuit_preview.snapshot_origin !== "server_validation" ||
      circuit_preview.is_stale === true ||
      !circuit_preview.circuit_json ||
      !hasCompletedTransientSimulation(circuit_preview.circuit_json)
    ) {
      fail("Stored model preview", "does not satisfy the fresh accepted transient-viewer contract")
    }
    if (
      !reference_preview ||
      reference_preview.reference_kind !== "curve" ||
      reference_preview.reference_points.length < 2 ||
      !reference_preview.result_points ||
      reference_preview.result_points.length < 2 ||
      reference_preview.result_origin !== "tscircuit_viewer" ||
      reference_preview.result_status !== "verified" ||
      reference_preview.matches_reference !== true ||
      reference_preview.is_stale === true
    ) {
      fail("Stored model preview", "does not satisfy the fresh accepted reference-comparison contract")
    }
    const response_series = reference_preview.series?.filter(
      ({ role, reference_kind }) => role === "response" && reference_kind === "curve",
    )
    if (
      !response_series ||
      response_series.length === 0 ||
      response_series.some(
        (series) =>
          series.reference_points.length < 2 ||
          !series.result_points ||
          series.result_points.length < 2 ||
          series.matches_reference !== true,
      )
    ) {
      fail("Stored model preview", "does not retain every fresh accepted response comparison series")
    }
  }
  return value as ModelSelectedPreview
}

export function tryParseModelSelectedPreview(
  value: unknown,
  options: ModelSelectedPreviewParseOptions = {},
): ModelSelectedPreview | undefined {
  try {
    return parseModelSelectedPreview(value, options)
  } catch {
    return undefined
  }
}
