import type {
  ModelAnalysis,
  ModelCharacterization,
  ModelFamily,
  ModelReferencePoint,
  ModelRequirement,
  ModelSourceReference,
  ModelStrategyId,
} from "./types"

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
const MODEL_STRATEGIES = new Set<ModelStrategyId>(["vendor", "equation", "behavioral", "hybrid"])
const MODEL_ANALYSES = new Set<ModelAnalysis>(["operating_point", "dc_sweep", "transient"])
const BASE_OBSERVATION_UNITS = new Set(["V", "A"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

class CharacterizationReader {
  readonly errors: string[] = []

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

  stringArray(value: unknown, path: string): string[] {
    if (!Array.isArray(value)) {
      this.errors.push(`${path} must be an array`)
      return []
    }
    return value.map((item, index) => this.string(item, `${path}[${index}]`)).filter(Boolean)
  }
}

function readSource(reader: CharacterizationReader, value: unknown, path: string): ModelSourceReference {
  if (!isRecord(value)) {
    reader.errors.push(`${path} must be an object`)
    return { page: 0, locator: "", statement: "" }
  }
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

function readPoint(reader: CharacterizationReader, value: unknown, path: string): ModelReferencePoint {
  if (!isRecord(value)) {
    reader.errors.push(`${path} must be an object`)
    return { x: 0, y: 0 }
  }
  return {
    x: reader.finite(value.x, `${path}.x`) ?? 0,
    y: reader.finite(value.y, `${path}.y`) ?? 0,
  }
}

function readRequirement(reader: CharacterizationReader, value: unknown, index: number): ModelRequirement {
  const path = `model-characterization.json.requirements[${index}]`
  const record = isRecord(value) ? value : {}
  if (!isRecord(value)) {
    reader.errors.push(`${path} must be an object`)
  }
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
    support = {
      status: "documented_only",
      reason: reader.string(record.support.reason, `${path}.support.reason`),
    }
  } else if (record.support.status !== "modeled") {
    reader.errors.push(`${path}.support.status must be modeled or documented_only`)
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
    if (expected.target === undefined && expected.min === undefined && expected.max === undefined) {
      reader.errors.push(`${path}.expected must declare target, min, or max`)
    }
    if (expected.min !== undefined && expected.max !== undefined && expected.min > expected.max) {
      reader.errors.push(`${path}.expected.min cannot exceed max`)
    }
  }

  let reference_curve: ModelRequirement["reference_curve"]
  if (record.reference_curve !== undefined) {
    if (!isRecord(record.reference_curve)) {
      reader.errors.push(`${path}.reference_curve must be an object`)
    } else {
      const points = Array.isArray(record.reference_curve.points)
        ? record.reference_curve.points.map((point, point_index) =>
            readPoint(reader, point, `${path}.reference_curve.points[${point_index}]`),
          )
        : []
      if (points.length < 2) reader.errors.push(`${path}.reference_curve.points needs at least two points`)
      for (let point_index = 1; point_index < points.length; point_index += 1) {
        const current = points[point_index]
        const previous = points[point_index - 1]
        if (current && previous && current.x <= previous.x) {
          reader.errors.push(`${path}.reference_curve.points must have strictly increasing x values`)
          break
        }
      }
      reference_curve = {
        x_quantity: reader.string(record.reference_curve.x_quantity, `${path}.reference_curve.x_quantity`),
        x_unit: reader.string(record.reference_curve.x_unit, `${path}.reference_curve.x_unit`),
        y_quantity: reader.string(record.reference_curve.y_quantity, `${path}.reference_curve.y_quantity`),
        y_unit: reader.string(record.reference_curve.y_unit, `${path}.reference_curve.y_unit`),
        points,
        tolerance: reader.finite(record.reference_curve.tolerance, `${path}.reference_curve.tolerance`),
        image:
          record.reference_curve.image === undefined
            ? undefined
            : reader.string(record.reference_curve.image, `${path}.reference_curve.image`),
      }
      if (reference_curve.tolerance !== undefined && reference_curve.tolerance <= 0) {
        reader.errors.push(`${path}.reference_curve.tolerance must be positive`)
      }
    }
  }

  if (support.status === "modeled") {
    if (expected.unit && !BASE_OBSERVATION_UNITS.has(expected.unit)) {
      reader.errors.push(
        `${path}.expected.unit must be V or A for modeled behavior; express ratios and other quantities as an observable base-unit response`,
      )
    }
    if (reference_curve) {
      if (!BASE_OBSERVATION_UNITS.has(reference_curve.y_unit)) {
        reader.errors.push(`${path}.reference_curve.y_unit must be V or A for modeled behavior`)
      }
      if (analysis === "operating_point") {
        reader.errors.push(`${path}.reference_curve is incompatible with operating_point analysis`)
      } else if (analysis === "dc_sweep" && !BASE_OBSERVATION_UNITS.has(reference_curve.x_unit)) {
        reader.errors.push(`${path}.reference_curve.x_unit must be V or A for dc_sweep analysis`)
      } else if (analysis === "transient" && reference_curve.x_unit !== "s") {
        reader.errors.push(`${path}.reference_curve.x_unit must be s for transient analysis`)
      }
    }
  }

  const sources = Array.isArray(record.sources)
    ? record.sources.map((source, source_index) =>
        readSource(reader, source, `${path}.sources[${source_index}]`),
      )
    : []
  if (sources.length === 0) reader.errors.push(`${path}.sources must cite at least one datasheet source`)

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

export function parseModelCharacterization(value: unknown): ModelCharacterization {
  const reader = new CharacterizationReader()
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("model-characterization.json must be a version 1 object")
  }
  const family = reader.string(value.family, "model-characterization.json.family") as ModelFamily
  const strategy = reader.string(value.strategy, "model-characterization.json.strategy") as ModelStrategyId
  if (!MODEL_FAMILIES.has(family)) reader.errors.push("model-characterization.json.family is unsupported")
  if (!MODEL_STRATEGIES.has(strategy)) {
    reader.errors.push("model-characterization.json.strategy is unsupported")
  }
  const requirements = Array.isArray(value.requirements)
    ? value.requirements.map((requirement, index) => readRequirement(reader, requirement, index))
    : []
  if (requirements.length === 0) {
    reader.errors.push("model-characterization.json.requirements must not be empty")
  }
  const ids = requirements.map(({ requirement_id }) => requirement_id)
  if (new Set(ids).size !== ids.length) {
    reader.errors.push("model-characterization.json requirement ids must be unique")
  }
  if (!requirements.some(({ support }) => support.status === "modeled")) {
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
