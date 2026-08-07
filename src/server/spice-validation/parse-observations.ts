import type { ModelRequirement } from "../modeling/types"
import { IDENTIFIER_PATTERN } from "./identifiers"
import { parseEndpoint } from "./parse-fixtures"
import { isRecord, type ValidationCollector } from "./parse-helpers"
import type { ReferenceContract, ValidationEvidence, ValidationObservation } from "./types"

const DEFAULT_CURVE_TOLERANCE = 0.05

function normalizedUnit(value: string): string {
  const unit = value.trim().toLowerCase()
  if (unit === "v" || unit === "volt" || unit === "volts") return "V"
  if (unit === "a" || unit === "amp" || unit === "amps" || unit === "ampere" || unit === "amperes") {
    return "A"
  }
  return value.trim()
}

function scalarTargetTolerance(target: number, unit: "V" | "A", tolerance?: number): number {
  const absolute_floor = unit === "V" ? 1e-3 : 1e-6
  return tolerance ?? Math.max(Math.abs(target) * DEFAULT_CURVE_TOLERANCE, absolute_floor)
}

function canonicalRequirementReference(input: {
  requirement: ModelRequirement
  observation_unit: "V" | "A"
  path: string
  collector: ValidationCollector
}): ReferenceContract {
  const { requirement, observation_unit, path, collector } = input
  if (requirement.reference_curve) {
    if (normalizedUnit(requirement.reference_curve.y_unit) !== observation_unit) {
      collector.add(
        `${path}.unit`,
        "requirement_unit_mismatch",
        `requirement ${JSON.stringify(requirement.requirement_id)} curve uses ${JSON.stringify(requirement.reference_curve.y_unit)}, not ${observation_unit}`,
      )
    }
    return {
      type: "curve",
      tolerance: requirement.reference_curve.tolerance ?? DEFAULT_CURVE_TOLERANCE,
      points: requirement.reference_curve.points.map(({ x, y }) => ({ x, y })),
    }
  }

  if (normalizedUnit(requirement.expected.unit) !== observation_unit) {
    collector.add(
      `${path}.unit`,
      "requirement_unit_mismatch",
      `requirement ${JSON.stringify(requirement.requirement_id)} expects ${JSON.stringify(requirement.expected.unit)}, not ${observation_unit}`,
    )
  }
  const { target, min, max, tolerance } = requirement.expected
  if (target !== undefined) {
    const target_tolerance = scalarTargetTolerance(target, observation_unit, tolerance)
    if (min === undefined && max === undefined) {
      return { type: "target", target, tolerance: target_tolerance }
    }

    const effective_min = Math.max(target - target_tolerance, min ?? Number.NEGATIVE_INFINITY)
    const effective_max = Math.min(target + target_tolerance, max ?? Number.POSITIVE_INFINITY)
    if (effective_min > effective_max) {
      collector.add(
        `${path}.reference`,
        "contradictory_requirement_reference",
        `requirement ${JSON.stringify(requirement.requirement_id)} target tolerance band [${target - target_tolerance}, ${target + target_tolerance}] does not intersect its hard bounds`,
      )
    }
    return { type: "bounds", min: effective_min, max: effective_max }
  }

  if (min !== undefined || max !== undefined) {
    return {
      type: "bounds",
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
    }
  }
  return {
    type: "target",
    target: 0,
    tolerance: scalarTargetTolerance(0, observation_unit, tolerance),
  }
}

function referencesEqual(left: ReferenceContract, right: ReferenceContract): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Evidence shown beside a validation result belongs to the immutable model
 * requirement, not to the agent-authored electrical fixture. Keeping this
 * binding here mirrors the server-owned reference binding above and prevents a
 * plan from pointing an otherwise valid comparison at unrelated datasheet
 * evidence.
 */
function canonicalRequirementEvidence(requirement: ModelRequirement): ValidationEvidence | undefined {
  const curve_image = requirement.reference_curve?.image
  const source =
    (curve_image ? requirement.sources.find(({ image }) => image === curve_image) : undefined) ??
    requirement.sources[0]
  const image = curve_image ?? source?.image
  const metadata: Record<string, string> = {}

  if (source?.locator.trim()) metadata.figure = source.locator
  if (requirement.reference_curve) {
    metadata.x_quantity = requirement.reference_curve.x_quantity
    metadata.x_unit = requirement.reference_curve.x_unit
    metadata.y_quantity = requirement.reference_curve.y_quantity
    metadata.y_unit = requirement.reference_curve.y_unit
    if (requirement.reference_curve.channel_id) metadata.channel_id = requirement.reference_curve.channel_id
    if (requirement.reference_curve.channel_role) metadata.role = requirement.reference_curve.channel_role
  }

  const page = source && Number.isInteger(source.page) && source.page > 0 ? source.page : undefined
  const has_metadata = Object.keys(metadata).length > 0
  if (page === undefined && image === undefined && !has_metadata) return undefined

  return {
    ...(page === undefined ? {} : { page }),
    ...(image === undefined ? {} : { image }),
    ...(has_metadata ? { metadata } : {}),
  }
}

function evidenceEqual(left: ValidationEvidence | undefined, right: ValidationEvidence | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  if (left.page !== right.page || left.image !== right.image) return false
  const left_metadata = left.metadata ?? {}
  const right_metadata = right.metadata ?? {}
  const keys = [...new Set([...Object.keys(left_metadata), ...Object.keys(right_metadata)])].sort()
  return keys.every((key) => left_metadata[key] === right_metadata[key])
}

function parseEvidence(
  value: unknown,
  path: string,
  collector: ValidationCollector,
): ValidationEvidence | undefined {
  if (value === undefined) return undefined
  const record = collector.record(value, path)
  collector.rejectUnknownKeys(record, ["page", "image", "metadata"], path)
  const page = record.page === undefined ? undefined : collector.positive(record.page, `${path}.page`)
  if (page !== undefined && Number.isFinite(page) && !Number.isInteger(page)) {
    collector.add(`${path}.page`, "invalid_page", "must be a positive integer")
  }
  const image = collector.optionalString(record.image, `${path}.image`)
  let metadata: Record<string, string> | undefined
  if (record.metadata !== undefined) {
    if (!isRecord(record.metadata)) {
      collector.add(`${path}.metadata`, "invalid_type", "must be an object of string values")
    } else {
      metadata = {}
      for (const [key, metadata_value] of Object.entries(record.metadata).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        metadata[key] = collector.string(metadata_value, `${path}.metadata.${key}`)
      }
    }
  }
  return {
    ...(page === undefined ? {} : { page }),
    ...(image === undefined ? {} : { image }),
    ...(metadata === undefined ? {} : { metadata }),
  }
}

function parseReference(value: unknown, path: string, collector: ValidationCollector): ReferenceContract {
  const record = collector.record(value, path)
  const type = collector.string(record.type, `${path}.type`)
  if (type === "target") {
    collector.rejectUnknownKeys(record, ["type", "target", "tolerance"], path)
    return {
      type,
      target: collector.finite(record.target, `${path}.target`),
      tolerance: collector.positive(record.tolerance, `${path}.tolerance`),
    }
  }
  if (type === "bounds") {
    collector.rejectUnknownKeys(record, ["type", "min", "max"], path)
    if (record.min === undefined && record.max === undefined) {
      collector.add(path, "empty_bounds", "must define min, max, or both")
    }
    const min = record.min === undefined ? undefined : collector.finite(record.min, `${path}.min`)
    const max = record.max === undefined ? undefined : collector.finite(record.max, `${path}.max`)
    if (min !== undefined && max !== undefined && min > max) {
      collector.add(path, "invalid_bounds", "min must be less than or equal to max")
    }
    return { type, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) }
  }
  if (type === "curve") {
    collector.rejectUnknownKeys(record, ["type", "tolerance", "points"], path)
    const tolerance = collector.positive(record.tolerance, `${path}.tolerance`)
    const point_values = collector.array(record.points, `${path}.points`)
    if (point_values.length < 2) {
      collector.add(`${path}.points`, "insufficient_points", "must contain at least two points")
    }
    const points = point_values.map((point_value, index) => {
      const point_path = `${path}.points[${index}]`
      const point = collector.record(point_value, point_path)
      collector.rejectUnknownKeys(point, ["x", "y"], point_path)
      return {
        x: collector.finite(point.x, `${point_path}.x`),
        y: collector.finite(point.y, `${point_path}.y`),
      }
    })
    for (let index = 1; index < points.length; index += 1) {
      const current = points[index]
      const previous = points[index - 1]
      if (current && previous && current.x <= previous.x) {
        collector.add(
          `${path}.points[${index}].x`,
          "unordered_curve",
          "curve x values must be strictly increasing",
        )
      }
    }
    return { type, tolerance, points }
  }
  collector.add(`${path}.type`, "unsupported_reference", "must be target, bounds, or curve")
  return { type: "target", target: 0, tolerance: 1 }
}

export function parseObservation(
  value: unknown,
  path: string,
  collector: ValidationCollector,
  requirement_by_id: ReadonlyMap<string, ModelRequirement>,
  case_requirement_ids: ReadonlySet<string>,
): ValidationObservation {
  const record = collector.record(value, path)
  const type = collector.string(record.type, `${path}.type`)
  const id = collector.string(record.id, `${path}.id`)
  if (id && !IDENTIFIER_PATTERN.test(id)) {
    collector.add(`${path}.id`, "invalid_identifier", "must be a stable observation identifier")
  }
  const requirement_id = collector.string(record.requirement_id, `${path}.requirement_id`)
  const requirement = requirement_by_id.get(requirement_id)
  if (requirement_id && !case_requirement_ids.has(requirement_id)) {
    collector.add(
      `${path}.requirement_id`,
      "requirement_not_in_case",
      `must name one of this case's requirement_ids (${JSON.stringify(requirement_id)})`,
    )
  } else if (requirement_id && !requirement) {
    collector.add(
      `${path}.requirement_id`,
      "unknown_requirement",
      `does not name a modeled requirement (${JSON.stringify(requirement_id)})`,
    )
  }
  const scale_value = collector.string(record.scale, `${path}.scale`)
  const scale = scale_value === "log" ? "log" : "linear"
  if (scale_value && scale_value !== "linear" && scale_value !== "log") {
    collector.add(`${path}.scale`, "unsupported_scale", 'must be "linear" or "log"')
  }
  const role_value = record.role === undefined ? "response" : collector.string(record.role, `${path}.role`)
  const role = role_value === "stimulus" ? "stimulus" : "response"
  if (role_value !== "response" && role_value !== "stimulus") {
    collector.add(`${path}.role`, "unsupported_role", "must be response or stimulus")
  }
  const expected_measurement = requirement?.reference_curve?.measurement
  const expected_role = requirement?.reference_curve?.channel_role
  if (expected_role && role !== expected_role) {
    collector.add(
      `${path}.role`,
      "requirement_channel_role_mismatch",
      `must match requirement ${JSON.stringify(requirement_id)} channel role ${expected_role}`,
    )
  }
  const supplied_evidence = parseEvidence(record.evidence, `${path}.evidence`, collector)
  const evidence = requirement ? canonicalRequirementEvidence(requirement) : supplied_evidence
  if (requirement && record.evidence !== undefined && !evidenceEqual(evidence, supplied_evidence)) {
    collector.add(
      `${path}.evidence`,
      "requirement_evidence_mismatch",
      `must exactly match the server-owned evidence for requirement ${JSON.stringify(requirement_id)}`,
    )
  }

  if (type === "voltage") {
    collector.rejectUnknownKeys(
      record,
      [
        "type",
        "id",
        "role",
        "requirement_id",
        "positive",
        "negative",
        "unit",
        "scale",
        "reference",
        "evidence",
      ],
      path,
    )
    if (record.unit !== "V") collector.add(`${path}.unit`, "invalid_unit", 'must be "V"')
    const reference = requirement
      ? canonicalRequirementReference({ requirement, observation_unit: "V", path, collector })
      : parseReference(record.reference, `${path}.reference`, collector)
    if (requirement && record.reference !== undefined) {
      const supplied = parseReference(record.reference, `${path}.reference`, collector)
      if (!referencesEqual(reference, supplied)) {
        collector.add(
          `${path}.reference`,
          "requirement_reference_mismatch",
          `must exactly match the server-owned reference for requirement ${JSON.stringify(requirement_id)}`,
        )
      }
    }
    const positive = parseEndpoint(record.positive, `${path}.positive`, collector)
    const negative = parseEndpoint(record.negative, `${path}.negative`, collector)
    if (expected_measurement && expected_measurement.type !== "voltage") {
      collector.add(
        `${path}.type`,
        "requirement_channel_type_mismatch",
        `requirement ${JSON.stringify(requirement_id)} is bound to a current channel`,
      )
    }
    if (expected_measurement?.type === "voltage" && positive !== expected_measurement.positive) {
      collector.add(
        `${path}.positive`,
        "requirement_response_endpoint_mismatch",
        `must exactly match requirement ${JSON.stringify(requirement_id)} measurement.positive (${JSON.stringify(expected_measurement.positive)})`,
      )
    }
    if (expected_measurement?.type === "voltage" && negative !== expected_measurement.negative) {
      collector.add(
        `${path}.negative`,
        "requirement_response_endpoint_mismatch",
        `must exactly match requirement ${JSON.stringify(requirement_id)} measurement.negative (${JSON.stringify(expected_measurement.negative)})`,
      )
    }
    return {
      type,
      id,
      role,
      requirement_id,
      positive,
      negative,
      unit: "V",
      scale,
      reference,
      ...(evidence === undefined ? {} : { evidence }),
    }
  }
  if (type === "current") {
    collector.rejectUnknownKeys(
      record,
      [
        "type",
        "id",
        "role",
        "requirement_id",
        "element_id",
        "direction",
        "unit",
        "scale",
        "reference",
        "evidence",
      ],
      path,
    )
    const element_id = collector.string(record.element_id, `${path}.element_id`)
    if (element_id && !IDENTIFIER_PATTERN.test(element_id)) {
      collector.add(`${path}.element_id`, "invalid_identifier", "must be a stable fixture identifier")
    }
    if (record.unit !== "A") collector.add(`${path}.unit`, "invalid_unit", 'must be "A"')
    const direction_value =
      record.direction === undefined
        ? "positive_to_negative"
        : collector.string(record.direction, `${path}.direction`)
    const direction =
      direction_value === "negative_to_positive" ? "negative_to_positive" : "positive_to_negative"
    if (direction_value !== "positive_to_negative" && direction_value !== "negative_to_positive") {
      collector.add(
        `${path}.direction`,
        "unsupported_current_direction",
        "must be positive_to_negative or negative_to_positive",
      )
    }
    if (expected_measurement && expected_measurement.type !== "current") {
      collector.add(
        `${path}.type`,
        "requirement_response_type_mismatch",
        `requirement ${JSON.stringify(requirement_id)} is bound to a voltage channel`,
      )
    }
    if (expected_measurement?.type === "current" && element_id !== expected_measurement.element_id) {
      collector.add(
        `${path}.element_id`,
        "requirement_current_element_mismatch",
        `must exactly match requirement ${JSON.stringify(requirement_id)} measurement element ${JSON.stringify(expected_measurement.element_id)}`,
      )
    }
    if (expected_measurement?.type === "current" && direction !== expected_measurement.direction) {
      collector.add(
        `${path}.direction`,
        "requirement_current_direction_mismatch",
        `must exactly match requirement ${JSON.stringify(requirement_id)} current direction ${expected_measurement.direction}`,
      )
    }
    const reference = requirement
      ? canonicalRequirementReference({ requirement, observation_unit: "A", path, collector })
      : parseReference(record.reference, `${path}.reference`, collector)
    if (requirement && record.reference !== undefined) {
      const supplied = parseReference(record.reference, `${path}.reference`, collector)
      if (!referencesEqual(reference, supplied)) {
        collector.add(
          `${path}.reference`,
          "requirement_reference_mismatch",
          `must exactly match the server-owned reference for requirement ${JSON.stringify(requirement_id)}`,
        )
      }
    }
    return {
      type,
      id,
      role,
      requirement_id,
      element_id,
      direction,
      unit: "A",
      scale,
      reference,
      ...(evidence === undefined ? {} : { evidence }),
    }
  }
  collector.add(`${path}.type`, "unsupported_observation", "must be voltage or current")
  return {
    type: "voltage",
    id,
    role,
    requirement_id,
    positive: "gnd",
    negative: "gnd",
    unit: "V",
    scale,
    reference: requirement
      ? canonicalRequirementReference({ requirement, observation_unit: "V", path, collector })
      : parseReference(record.reference, `${path}.reference`, collector),
    ...(evidence === undefined ? {} : { evidence }),
  }
}
