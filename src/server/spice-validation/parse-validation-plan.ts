import type { ModelRequirement } from "../modeling/types"
import { CASE_ID_PATTERN, IDENTIFIER_PATTERN, SPICE_NODE_PATTERN } from "./identifiers"
import { type ValidationModelDefinition, validateModelDefinition } from "./model-definition"
import { parseAnalysis } from "./parse-analysis"
import { parseFixtureElement } from "./parse-fixtures"
import { ValidationCollector } from "./parse-helpers"
import { parseObservation } from "./parse-observations"
import type { ValidationCase, ValidationContext, ValidationPathError, ValidationPlan } from "./types"
import { validateCaseConnectivity, validatePlanCoverage } from "./validate-plan-connectivity"

export const MAX_VALIDATION_CASES = 16

function analysisCoversRequirement(
  requirement_analysis: ModelRequirement["analysis"],
  validation_analysis: ValidationCase["analysis"]["type"],
): boolean {
  if (requirement_analysis === validation_analysis) return true
  // A DC sweep is a sequence of operating points. It is a valid strengthening
  // of a scalar operating-point requirement because the immutable target or
  // bounds are checked at every sweep sample.
  return requirement_analysis === "operating_point" && validation_analysis === "dc_sweep"
}

export class ValidationPlanError extends Error {
  readonly errors: ValidationPathError[]

  constructor(errors: ValidationPathError[]) {
    super(
      `ValidationPlan has ${errors.length} contract error${errors.length === 1 ? "" : "s"}:\n${errors
        .map((error) => `${error.path}: ${error.message} [${error.code}]`)
        .join("\n")}`,
    )
    this.name = "ValidationPlanError"
    this.errors = errors
  }
}

function parsePlanModel(
  value: unknown,
  model_definition: ValidationModelDefinition,
  collector: ValidationCollector,
): ValidationPlan["model"] {
  const record = collector.record(value, "model")
  collector.rejectUnknownKeys(record, ["entry_name", "pins"], "model")
  const entry_name = collector.string(record.entry_name, "model.entry_name")
  if (entry_name && !IDENTIFIER_PATTERN.test(entry_name)) {
    collector.add("model.entry_name", "unsafe_identifier", "must be an executable-safe SPICE identifier")
  }
  if (entry_name && entry_name !== model_definition.entry_name) {
    collector.add(
      "model.entry_name",
      "manifest_mismatch",
      `must exactly match the server-owned entry_name (${JSON.stringify(model_definition.entry_name)})`,
    )
  }
  const pin_values = collector.array(record.pins, "model.pins")
  const pins = pin_values.map((pin, index) => collector.string(pin, `model.pins[${index}]`))
  const manifest_pins = model_definition.pins.map((pin) => pin.spice_node)
  if (pins.length !== manifest_pins.length) {
    collector.add(
      "model.pins",
      "manifest_mismatch",
      `must contain ${manifest_pins.length} pins in manifest order`,
    )
  }
  pins.forEach((pin, index) => {
    if (pin && !SPICE_NODE_PATTERN.test(pin)) {
      collector.add(`model.pins[${index}]`, "unsafe_identifier", "must be a safe SPICE node identifier")
    }
    const expected = manifest_pins[index]
    if (expected !== undefined && pin !== expected) {
      collector.add(
        `model.pins[${index}]`,
        "manifest_mismatch",
        `must be ${JSON.stringify(expected)} to preserve manifest pin order`,
      )
    }
  })
  return { entry_name, pins }
}

function parseCase(
  value: unknown,
  index: number,
  model_definition: ValidationModelDefinition,
  requirement_by_id: ReadonlyMap<string, ModelRequirement>,
  modeled_requirement_ids: Set<string>,
  covered_requirement_ids: Set<string>,
  covered_dut_pins: Set<string>,
  collector: ValidationCollector,
): ValidationCase {
  const path = `cases[${index}]`
  const record = collector.record(value, path)
  collector.rejectUnknownKeys(
    record,
    ["id", "title", "requirement_ids", "nets", "fixtures", "analysis", "observations"],
    path,
  )
  const id = collector.string(record.id, `${path}.id`)
  if (id && !CASE_ID_PATTERN.test(id)) {
    collector.add(
      `${path}.id`,
      "invalid_case_id",
      "must start with a lowercase letter and contain only lowercase letters, digits, underscores, and hyphens",
    )
  }
  const title = collector.optionalString(record.title, `${path}.title`)
  const requirement_values = collector.array(record.requirement_ids, `${path}.requirement_ids`)
  if (requirement_values.length === 0) {
    collector.add(
      `${path}.requirement_ids`,
      "missing_requirements",
      "must cover at least one modeled requirement",
    )
  }
  const requirement_ids = requirement_values.map((requirement_id, requirement_index) => {
    const requirement_path = `${path}.requirement_ids[${requirement_index}]`
    const parsed = collector.string(requirement_id, requirement_path)
    if (parsed && !IDENTIFIER_PATTERN.test(parsed)) {
      collector.add(requirement_path, "invalid_identifier", "must be a stable requirement identifier")
    } else if (parsed && !modeled_requirement_ids.has(parsed)) {
      collector.add(
        requirement_path,
        "unknown_requirement",
        `does not name a modeled requirement (${JSON.stringify(parsed)})`,
      )
    }
    return parsed
  })
  const first_requirement_index = new Map<string, number>()
  requirement_ids.forEach((requirement_id, requirement_index) => {
    const existing = first_requirement_index.get(requirement_id)
    if (existing === undefined) first_requirement_index.set(requirement_id, requirement_index)
    else {
      collector.add(
        `${path}.requirement_ids[${requirement_index}]`,
        "duplicate_id",
        `duplicates ${path}.requirement_ids[${existing}]`,
      )
    }
  })
  const net_values = collector.array(record.nets, `${path}.nets`)
  const nets = net_values.map((net, net_index) => {
    const parsed = collector.string(net, `${path}.nets[${net_index}]`)
    if (parsed && !IDENTIFIER_PATTERN.test(parsed)) {
      collector.add(`${path}.nets[${net_index}]`, "invalid_identifier", "must be a stable net identifier")
    }
    return parsed
  })
  const fixture_values = collector.array(record.fixtures, `${path}.fixtures`)
  if (fixture_values.length === 0) {
    collector.add(`${path}.fixtures`, "missing_fixtures", "must contain at least one fixture element")
  }
  const fixtures = fixture_values.map((fixture, fixture_index) =>
    parseFixtureElement(fixture, `${path}.fixtures[${fixture_index}]`, collector),
  )
  const analysis = parseAnalysis(record.analysis, `${path}.analysis`, collector)
  requirement_ids.forEach((requirement_id, requirement_index) => {
    const requirement = requirement_by_id.get(requirement_id)
    if (requirement && !analysisCoversRequirement(requirement.analysis, analysis.type)) {
      collector.add(
        `${path}.requirement_ids[${requirement_index}]`,
        "requirement_analysis_mismatch",
        `requirement ${JSON.stringify(requirement_id)} requires ${requirement.analysis}, not ${analysis.type}`,
      )
    }
  })
  const observation_values = collector.array(record.observations, `${path}.observations`)
  if (observation_values.length === 0) {
    collector.add(`${path}.observations`, "missing_observations", "must contain at least one observation")
  }
  const observations = observation_values.map((observation, observation_index) =>
    parseObservation(
      observation,
      `${path}.observations[${observation_index}]`,
      collector,
      requirement_by_id,
      new Set(requirement_ids),
    ),
  )
  const evidence_sources = new Set(
    observations.map((observation) =>
      JSON.stringify({
        page: observation.evidence?.page,
        image: observation.evidence?.image,
      }),
    ),
  )
  if (evidence_sources.size > 1) {
    collector.add(
      `${path}.observations`,
      "mixed_case_evidence",
      "all observations in one case must use the same datasheet page/image; split differently sourced requirements into separate cases",
    )
  }
  const observed_requirement_ids = new Set(observations.map(({ requirement_id }) => requirement_id))
  requirement_ids.forEach((requirement_id, requirement_index) => {
    if (!observed_requirement_ids.has(requirement_id)) {
      collector.add(
        `${path}.requirement_ids[${requirement_index}]`,
        "unobserved_requirement",
        `must be bound to at least one observation (${JSON.stringify(requirement_id)})`,
      )
    } else if (modeled_requirement_ids.has(requirement_id)) {
      covered_requirement_ids.add(requirement_id)
    }
  })
  const validation_case: ValidationCase = {
    id,
    ...(title === undefined ? {} : { title }),
    requirement_ids,
    nets,
    fixtures,
    analysis,
    observations,
  }
  validateCaseConnectivity({
    validation_case,
    case_index: index,
    model: model_definition,
    covered_dut_pins,
    collector,
  })
  return validation_case
}

export function parseValidationPlan(value: unknown, context: ValidationContext): ValidationPlan {
  const collector = new ValidationCollector()
  const model_definition = validateModelDefinition(context, collector)
  const requirement_by_id = new Map<string, ModelRequirement>()
  const modeled_requirement_ids = new Set<string>()
  context.model_requirements.forEach((requirement, index) => {
    const requirement_id = requirement.requirement_id
    if (!IDENTIFIER_PATTERN.test(requirement_id)) {
      collector.add(
        `model_requirements[${index}].requirement_id`,
        "invalid_identifier",
        "must be a stable requirement identifier",
      )
    } else if (requirement_by_id.has(requirement_id)) {
      collector.add(`model_requirements[${index}].requirement_id`, "duplicate_id", "must be unique")
    }
    requirement_by_id.set(requirement_id, requirement)
    if (requirement.support.status === "modeled") modeled_requirement_ids.add(requirement_id)
  })
  if (modeled_requirement_ids.size === 0) {
    collector.add(
      "model_requirements",
      "missing_requirements",
      "must contain at least one modeled requirement",
    )
  }
  const root = collector.record(value, "$plan")
  collector.rejectUnknownKeys(root, ["version", "model", "cases"], "$plan")
  if (root.version !== 1) collector.add("version", "unsupported_version", "must be 1")
  const model = parsePlanModel(root.model, model_definition, collector)
  const case_values = collector.array(root.cases, "cases")
  if (case_values.length === 0) collector.add("cases", "missing_cases", "must contain at least one case")
  if (case_values.length > MAX_VALIDATION_CASES) {
    collector.add(
      "cases",
      "validation_case_limit_exceeded",
      `must contain no more than ${MAX_VALIDATION_CASES} cases; received ${case_values.length}`,
    )
  }
  const covered_dut_pins = new Set<string>()
  const covered_requirement_ids = new Set<string>()
  const cases = case_values
    .slice(0, MAX_VALIDATION_CASES)
    .map((validation_case, index) =>
      parseCase(
        validation_case,
        index,
        model_definition,
        requirement_by_id,
        modeled_requirement_ids,
        covered_requirement_ids,
        covered_dut_pins,
        collector,
      ),
    )
  if (
    (context.model_family === "regulator" || context.model_family === "power_converter") &&
    !cases.some(({ analysis }) => analysis.type === "dc_sweep" || analysis.type === "transient")
  ) {
    collector.add(
      "cases",
      "insufficient_operating_range_coverage",
      `${context.model_family} validation must exercise at least one modeled behavior with a DC sweep or transient analysis; isolated operating points are insufficient`,
    )
  }
  const first_case_index = new Map<string, number>()
  cases.forEach((validation_case, index) => {
    const existing = first_case_index.get(validation_case.id)
    if (existing === undefined) first_case_index.set(validation_case.id, index)
    else {
      collector.add(
        `cases[${index}].id`,
        "duplicate_id",
        `duplicates cases[${existing}].id (${JSON.stringify(validation_case.id)})`,
      )
    }
  })
  validatePlanCoverage({
    model: model_definition,
    covered_dut_pins,
    modeled_requirement_ids: [...modeled_requirement_ids],
    covered_requirement_ids,
    collector,
  })
  if (collector.errors.length > 0) throw new ValidationPlanError(collector.errors)
  return { version: 1, model, cases }
}
