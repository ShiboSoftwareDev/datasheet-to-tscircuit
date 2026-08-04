import type {
  ModelAnalysis,
  ModelCharacterization,
  ModelFamily,
  ModelReferenceCropRegion,
  ModelReferenceElectricalBinding,
  ModelReferencePoint,
  ModelRequirement,
  ModelSourceReference,
  ModelStrategyId,
} from "./types"
import {
  MODEL_REFERENCE_CROP_DPI,
  MODEL_REFERENCE_CROP_MIN_HEIGHT,
  MODEL_REFERENCE_CROP_MIN_WIDTH,
} from "./types"
import { MIN_FRESH_REFERENCE_CURVE_POINTS } from "./model-training-contract"
import { parseModelReferenceElectricalBinding } from "./reference-electrical-binding"

const MODEL_FAMILIES = new Set<ModelFamily>([
  "passive",
  "diode",
  "bjt",
  "mosfet",
  "opamp",
  "comparator",
  "regulator",
  "power_converter",
  "sensor",
  "digital_mixed_signal",
  "other",
])
// `vendor` remains parseable for backward-compatible reads of immutable
// publications. It is intentionally absent from ModelStrategyRegistry, which
// rejects new characterization proposals before they can reach generation.
const MODEL_STRATEGIES = new Set<ModelStrategyId>(["vendor", "equation", "behavioral", "hybrid"])
const MODEL_ANALYSES = new Set<ModelAnalysis>(["operating_point", "dc_sweep", "transient"])
const BASE_OBSERVATION_UNITS = new Set(["V", "A"])
const MAX_NORMALIZED_CURVE_TOLERANCE = 0.1

function maximumModeledExpectedTolerance(expected: ModelRequirement["expected"]): number | undefined {
  const absolute_floor = expected.unit === "V" ? 1e-3 : expected.unit === "A" ? 1e-6 : undefined
  if (absolute_floor === undefined) return undefined
  const declared_magnitude = Math.max(
    0,
    ...[expected.target, expected.min, expected.max].flatMap((value) =>
      value === undefined ? [] : [Math.abs(value)],
    ),
  )
  return Math.max(declared_magnitude * 0.5, absolute_floor)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

class CharacterizationReader {
  readonly errors: string[] = []

  onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, enabled: boolean): void {
    if (!enabled) return
    const allowed_keys = new Set(allowed)
    const unexpected = Object.keys(value)
      .filter((key) => !allowed_keys.has(key))
      .sort()
    if (unexpected.length > 0) {
      this.errors.push(`${path} contains unsupported fields: ${unexpected.join(", ")}`)
    }
  }

  string(value: unknown, path: string): string {
    if (typeof value !== "string" || !value.trim()) {
      this.errors.push(`${path} must be a non-empty string`)
      return ""
    }
    return value.trim()
  }

  finite(value: unknown, path: string): number | undefined {
    if (value === undefined) return undefined
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.errors.push(`${path} must be a finite number`)
      return undefined
    }
    return value
  }

  integer(value: unknown, path: string, minimum: number): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
      this.errors.push(`${path} must be a safe integer greater than or equal to ${minimum}`)
      return minimum
    }
    return value as number
  }

  stringArray(value: unknown, path: string): string[] {
    if (!Array.isArray(value)) {
      this.errors.push(`${path} must be an array`)
      return []
    }
    return value.map((item, index) => this.string(item, `${path}[${index}]`)).filter(Boolean)
  }
}

function readCropRegion(
  reader: CharacterizationReader,
  value: unknown,
  path: string,
  reject_unknown_fields: boolean,
): ModelReferenceCropRegion | undefined {
  if (!isRecord(value)) {
    reader.errors.push(`${path} must be an object`)
    return undefined
  }
  reader.onlyKeys(
    value,
    ["page", "render_dpi", "x_px", "y_px", "width_px", "height_px"],
    path,
    reject_unknown_fields,
  )
  if (value.render_dpi !== MODEL_REFERENCE_CROP_DPI) {
    reader.errors.push(`${path}.render_dpi must be ${MODEL_REFERENCE_CROP_DPI}`)
  }
  return {
    page: reader.integer(value.page, `${path}.page`, 1),
    render_dpi: MODEL_REFERENCE_CROP_DPI,
    x_px: reader.integer(value.x_px, `${path}.x_px`, 0),
    y_px: reader.integer(value.y_px, `${path}.y_px`, 0),
    width_px: reader.integer(value.width_px, `${path}.width_px`, 1),
    height_px: reader.integer(value.height_px, `${path}.height_px`, 1),
  }
}

function readSource(
  reader: CharacterizationReader,
  value: unknown,
  path: string,
  reject_unknown_fields: boolean,
): ModelSourceReference {
  if (!isRecord(value)) {
    reader.errors.push(`${path} must be an object`)
    return { page: 0, locator: "", statement: "" }
  }
  reader.onlyKeys(value, ["page", "locator", "statement", "image"], path, reject_unknown_fields)
  const page = reader.finite(value.page, `${path}.page`) ?? 0
  if (!Number.isInteger(page) || page < 1) reader.errors.push(`${path}.page must be a positive PDF page`)
  const image = value.image === undefined ? undefined : reader.string(value.image, `${path}.image`)
  if (image && (image.startsWith("/") || image.split(/[\\/]/).includes(".."))) {
    reader.errors.push(`${path}.image must be a workspace-relative path`)
  }
  return {
    page,
    locator: reader.string(value.locator, `${path}.locator`),
    statement: reader.string(value.statement, `${path}.statement`),
    image,
  }
}

function readPoint(
  reader: CharacterizationReader,
  value: unknown,
  path: string,
  reject_unknown_fields: boolean,
): ModelReferencePoint {
  if (!isRecord(value)) {
    reader.errors.push(`${path} must be an object`)
    return { x: 0, y: 0 }
  }
  reader.onlyKeys(value, ["x", "y"], path, reject_unknown_fields)
  return {
    x: reader.finite(value.x, `${path}.x`) ?? 0,
    y: reader.finite(value.y, `${path}.y`) ?? 0,
  }
}

function readRequirement(
  reader: CharacterizationReader,
  value: unknown,
  index: number,
  enforce_fresh_policy: boolean,
  reject_unknown_fields: boolean,
): ModelRequirement {
  const path = `model-characterization.json.requirements[${index}]`
  const record = isRecord(value) ? value : {}
  if (!isRecord(value)) {
    reader.errors.push(`${path} must be an object`)
  }
  reader.onlyKeys(
    record,
    [
      "requirement_id",
      "title",
      "behavior",
      "analysis",
      "support",
      "conditions",
      "expected",
      "reference_curve",
      "sources",
    ],
    path,
    reject_unknown_fields,
  )
  const requirement_id = reader.string(record.requirement_id, `${path}.requirement_id`)
  if (requirement_id && !/^[a-z][a-z0-9_]*$/.test(requirement_id)) {
    reader.errors.push(`${path}.requirement_id must use snake_case`)
  }
  const analysis = reader.string(record.analysis, `${path}.analysis`) as ModelAnalysis
  if (!MODEL_ANALYSES.has(analysis)) reader.errors.push(`${path}.analysis is unsupported`)

  let support: ModelRequirement["support"] = { status: "modeled" }
  if (!isRecord(record.support)) {
    reader.errors.push(`${path}.support must be an object`)
  } else if (record.support.status === "documented_only") {
    reader.onlyKeys(record.support, ["status", "reason"], `${path}.support`, reject_unknown_fields)
    support = {
      status: "documented_only",
      reason: reader.string(record.support.reason, `${path}.support.reason`),
    }
  } else if (record.support.status !== "modeled") {
    reader.onlyKeys(record.support, ["status"], `${path}.support`, reject_unknown_fields)
    reader.errors.push(`${path}.support.status must be modeled or documented_only`)
  } else {
    reader.onlyKeys(record.support, ["status"], `${path}.support`, reject_unknown_fields)
  }

  const conditions: Record<string, string | number | boolean> = {}
  if (!isRecord(record.conditions)) {
    reader.errors.push(`${path}.conditions must be an object`)
  } else {
    for (const [key, condition] of Object.entries(record.conditions)) {
      if (typeof condition !== "string" && typeof condition !== "number" && typeof condition !== "boolean") {
        reader.errors.push(`${path}.conditions.${key} must be a string, number, or boolean`)
      } else if (typeof condition === "number" && !Number.isFinite(condition)) {
        reader.errors.push(`${path}.conditions.${key} must be finite`)
      } else {
        conditions[key] = condition
      }
    }
  }

  let expected: ModelRequirement["expected"] = { unit: "" }
  if (!isRecord(record.expected)) {
    reader.errors.push(`${path}.expected must be an object`)
  } else {
    reader.onlyKeys(
      record.expected,
      ["unit", "target", "min", "max", "tolerance"],
      `${path}.expected`,
      reject_unknown_fields,
    )
    expected = {
      unit: reader.string(record.expected.unit, `${path}.expected.unit`),
      target: reader.finite(record.expected.target, `${path}.expected.target`),
      min: reader.finite(record.expected.min, `${path}.expected.min`),
      max: reader.finite(record.expected.max, `${path}.expected.max`),
      tolerance: reader.finite(record.expected.tolerance, `${path}.expected.tolerance`),
    }
    if (expected.tolerance !== undefined && expected.tolerance <= 0) {
      reader.errors.push(`${path}.expected.tolerance must be positive`)
    }
    if (
      enforce_fresh_policy &&
      support.status === "modeled" &&
      expected.tolerance !== undefined &&
      expected.tolerance > 0
    ) {
      const maximum_tolerance = maximumModeledExpectedTolerance(expected)
      if (maximum_tolerance !== undefined && expected.tolerance > maximum_tolerance) {
        reader.errors.push(
          `${path}.expected.tolerance must not exceed ${maximum_tolerance} ${expected.unit} for the declared expected scale`,
        )
      }
    }
    if (expected.target === undefined && expected.min === undefined && expected.max === undefined) {
      reader.errors.push(`${path}.expected must declare target, min, or max`)
    }
    if (expected.min !== undefined && expected.max !== undefined && expected.min > expected.max) {
      reader.errors.push(`${path}.expected.min cannot exceed max`)
    }
    if (
      enforce_fresh_policy &&
      expected.target !== undefined &&
      expected.min !== undefined &&
      expected.target < expected.min
    ) {
      reader.errors.push(`${path}.expected.target cannot be less than min when both are declared`)
    }
    if (
      enforce_fresh_policy &&
      expected.target !== undefined &&
      expected.max !== undefined &&
      expected.target > expected.max
    ) {
      reader.errors.push(`${path}.expected.target cannot exceed max when both are declared`)
    }
  }

  let reference_curve: ModelRequirement["reference_curve"]
  if (record.reference_curve !== undefined) {
    if (!isRecord(record.reference_curve)) {
      reader.errors.push(`${path}.reference_curve must be an object`)
    } else {
      reader.onlyKeys(
        record.reference_curve,
        [
          "x_quantity",
          "x_unit",
          "y_quantity",
          "y_unit",
          "points",
          "tolerance",
          "crop",
          "image",
          "electrical_binding",
        ],
        `${path}.reference_curve`,
        reject_unknown_fields,
      )
      const crop =
        record.reference_curve.crop === undefined
          ? undefined
          : readCropRegion(
              reader,
              record.reference_curve.crop,
              `${path}.reference_curve.crop`,
              reject_unknown_fields,
            )
      const points = Array.isArray(record.reference_curve.points)
        ? record.reference_curve.points.map((point, point_index) =>
            readPoint(reader, point, `${path}.reference_curve.points[${point_index}]`, reject_unknown_fields),
          )
        : []
      if (points.length < 2) reader.errors.push(`${path}.reference_curve.points needs at least two points`)
      const fresh_point_minimum = MIN_FRESH_REFERENCE_CURVE_POINTS
      if (enforce_fresh_policy && support.status === "modeled" && points.length < fresh_point_minimum) {
        reader.errors.push(
          `${path}.reference_curve.points needs at least ${fresh_point_minimum} points so server validation can withhold interior samples from model generation`,
        )
      }
      if (
        enforce_fresh_policy &&
        support.status === "modeled" &&
        crop &&
        (crop.width_px < MODEL_REFERENCE_CROP_MIN_WIDTH || crop.height_px < MODEL_REFERENCE_CROP_MIN_HEIGHT)
      ) {
        reader.errors.push(
          `${path}.reference_curve.crop must be at least ${MODEL_REFERENCE_CROP_MIN_WIDTH}x${MODEL_REFERENCE_CROP_MIN_HEIGHT} pixels at ${MODEL_REFERENCE_CROP_DPI} DPI`,
        )
      }
      for (let point_index = 1; point_index < points.length; point_index += 1) {
        const current = points[point_index]
        const previous = points[point_index - 1]
        if (current && previous && current.x <= previous.x) {
          reader.errors.push(`${path}.reference_curve.points must have strictly increasing x values`)
          break
        }
      }
      if (enforce_fresh_policy && support.status === "modeled" && points.some(({ x }) => x < 0)) {
        reader.errors.push(`${path}.reference_curve.points cannot contain negative elapsed time`)
      }
      let electrical_binding: ModelReferenceElectricalBinding | undefined
      if (record.reference_curve.electrical_binding !== undefined) {
        try {
          electrical_binding = parseModelReferenceElectricalBinding(
            record.reference_curve.electrical_binding,
            `${path}.reference_curve.electrical_binding`,
          )
        } catch (error) {
          reader.errors.push(error instanceof Error ? error.message : String(error))
        }
      }
      reference_curve = {
        x_quantity: reader.string(record.reference_curve.x_quantity, `${path}.reference_curve.x_quantity`),
        x_unit: reader.string(record.reference_curve.x_unit, `${path}.reference_curve.x_unit`),
        y_quantity: reader.string(record.reference_curve.y_quantity, `${path}.reference_curve.y_quantity`),
        y_unit: reader.string(record.reference_curve.y_unit, `${path}.reference_curve.y_unit`),
        points,
        tolerance: reader.finite(record.reference_curve.tolerance, `${path}.reference_curve.tolerance`),
        crop,
        image:
          record.reference_curve.image === undefined
            ? undefined
            : reader.string(record.reference_curve.image, `${path}.reference_curve.image`),
        electrical_binding,
      }
      if (reference_curve.tolerance !== undefined && reference_curve.tolerance <= 0) {
        reader.errors.push(`${path}.reference_curve.tolerance must be positive`)
      }
      if (
        enforce_fresh_policy &&
        reference_curve.tolerance !== undefined &&
        reference_curve.tolerance > MAX_NORMALIZED_CURVE_TOLERANCE
      ) {
        reader.errors.push(
          `${path}.reference_curve.tolerance must not exceed ${MAX_NORMALIZED_CURVE_TOLERANCE}`,
        )
      }
    }
  }

  if (support.status === "modeled") {
    if (enforce_fresh_policy && analysis !== "transient") {
      reader.errors.push(
        `${path}.analysis must be transient for fresh modeled requirements; operating_point and dc_sweep may only be documented_only`,
      )
    }
    if (enforce_fresh_policy && !reference_curve) {
      reader.errors.push(
        `${path}.reference_curve is required for fresh modeled requirements; executable models must be grounded in a printed elapsed-time graph`,
      )
    }
    if (expected.unit && !BASE_OBSERVATION_UNITS.has(expected.unit)) {
      reader.errors.push(
        `${path}.expected.unit must be V or A for modeled behavior; express ratios and other quantities as an observable base-unit response`,
      )
    }
    if (enforce_fresh_policy && expected.unit !== "V") {
      reader.errors.push(
        `${path}.expected.unit must be V for fresh modeled requirements; the current tscircuit runtime does not emit transient current graphs`,
      )
    }
    if (reference_curve) {
      if (!BASE_OBSERVATION_UNITS.has(reference_curve.y_unit)) {
        reader.errors.push(`${path}.reference_curve.y_unit must be V or A for modeled behavior`)
      }
      if (enforce_fresh_policy && !reference_curve.electrical_binding) {
        reader.errors.push(
          `${path}.reference_curve.electrical_binding is required for fresh modeled requirements so the datasheet response and pulsed stimulus cannot be reassigned to different DUT pins`,
        )
      }
      if (enforce_fresh_policy && reference_curve.y_unit !== "V") {
        reader.errors.push(
          `${path}.reference_curve.y_unit must be V for fresh modeled requirements; the current tscircuit runtime does not emit transient current graphs`,
        )
      }
      if (enforce_fresh_policy && reference_curve.y_quantity !== "voltage") {
        reader.errors.push(
          `${path}.reference_curve.y_quantity must be voltage for fresh modeled requirements`,
        )
      }
      if (analysis === "operating_point") {
        reader.errors.push(`${path}.reference_curve is incompatible with operating_point analysis`)
      } else if (analysis === "dc_sweep" && !BASE_OBSERVATION_UNITS.has(reference_curve.x_unit)) {
        reader.errors.push(`${path}.reference_curve.x_unit must be V or A for dc_sweep analysis`)
      } else if (analysis === "transient" && reference_curve.x_unit !== "s") {
        reader.errors.push(`${path}.reference_curve.x_unit must be s for transient analysis`)
      }
      if (enforce_fresh_policy && reference_curve.x_unit !== "s") {
        reader.errors.push(`${path}.reference_curve.x_unit must be s for fresh modeled requirements`)
      }
      if (enforce_fresh_policy && reference_curve.x_quantity !== "time") {
        reader.errors.push(`${path}.reference_curve.x_quantity must be time for fresh modeled requirements`)
      }
      if (enforce_fresh_policy && !reference_curve.crop) {
        reader.errors.push(
          `${path}.reference_curve.crop is required for fresh modeled requirements and must identify the exact printed graph at 200 DPI`,
        )
      }
    }
  }

  const sources = Array.isArray(record.sources)
    ? record.sources.map((source, source_index) =>
        readSource(reader, source, `${path}.sources[${source_index}]`, reject_unknown_fields),
      )
    : []
  if (sources.length === 0) reader.errors.push(`${path}.sources must cite at least one datasheet source`)
  if (reference_curve?.crop && sources[0]?.page !== reference_curve.crop.page) {
    reader.errors.push(
      `${path}.reference_curve.crop.page must match the primary PDF page at ${path}.sources[0]`,
    )
  }

  return {
    requirement_id,
    title: reader.string(record.title, `${path}.title`),
    behavior: reader.string(record.behavior, `${path}.behavior`),
    analysis,
    support,
    conditions,
    expected,
    reference_curve,
    sources,
  }
}

export function parseModelCharacterization(
  value: unknown,
  options: {
    policy?: "compatibility" | "fresh"
    reject_unknown_fields?: boolean
  } = {},
): ModelCharacterization {
  const reader = new CharacterizationReader()
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("model-characterization.json must be a version 1 object")
  }
  reader.onlyKeys(
    value,
    ["version", "family", "strategy", "requirements", "assumptions", "limitations"],
    "model-characterization.json",
    options.reject_unknown_fields === true,
  )
  const family = reader.string(value.family, "model-characterization.json.family") as ModelFamily
  const strategy = reader.string(value.strategy, "model-characterization.json.strategy") as ModelStrategyId
  if (!MODEL_FAMILIES.has(family)) reader.errors.push("model-characterization.json.family is unsupported")
  if (!MODEL_STRATEGIES.has(strategy)) {
    reader.errors.push("model-characterization.json.strategy is unsupported")
  }
  const requirements = Array.isArray(value.requirements)
    ? value.requirements.map((requirement, index) =>
        readRequirement(
          reader,
          requirement,
          index,
          options.policy === "fresh",
          options.reject_unknown_fields === true,
        ),
      )
    : []
  if (requirements.length === 0) {
    reader.errors.push("model-characterization.json.requirements must not be empty")
  }
  const ids = requirements.map(({ requirement_id }) => requirement_id)
  if (new Set(ids).size !== ids.length) {
    reader.errors.push("model-characterization.json requirement ids must be unique")
  }
  if (options.policy !== "fresh" && !requirements.some(({ support }) => support.status === "modeled")) {
    reader.errors.push("model-characterization.json must contain at least one modeled requirement")
  }
  const assumptions = reader.stringArray(value.assumptions, "model-characterization.json.assumptions")
  const limitations = reader.stringArray(value.limitations, "model-characterization.json.limitations")
  if (reader.errors.length > 0) {
    throw new AggregateError(
      reader.errors,
      `Model characterization has ${reader.errors.length} error(s):\n${reader.errors.join("\n")}`,
    )
  }
  return { version: 1, family, strategy, requirements, assumptions, limitations }
}
