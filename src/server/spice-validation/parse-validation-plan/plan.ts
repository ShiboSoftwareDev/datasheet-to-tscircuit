import { resolveApplicationFixtureForBinding } from "../../modeling/application-fixture-contract"
import type { ModelRequirement } from "../../modeling/types"
import { IDENTIFIER_PATTERN, SPICE_NODE_PATTERN } from "../identifiers"
import { type ValidationModelDefinition, validateModelDefinition } from "../model-definition"
import { ValidationCollector } from "../parse-helpers"
import type { ValidationContext, ValidationPathError, ValidationPlan } from "../types"
import { validatePlanCoverage } from "../validate-plan-connectivity"
import { applicationPassiveToFixture, exactApplicationNetIds } from "./application-fixture"
import { parseCase } from "./case"

export const MAX_VALIDATION_CASES = 32

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
        context.application_fixture,
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

/**
 * Parses an untrusted agent proposal into the canonical persisted plan.
 *
 * `reference` and `evidence` are server-owned observation fields. Historical
 * prompts and real agent outputs sometimes include guesses for them, so this
 * proposal boundary removes those fields before strict parsing. The strict
 * `parseValidationPlan` function remains unchanged for persisted-plan integrity
 * checks and rejects any canonical field that has been altered.
 */
export function parseAgentValidationPlan(value: unknown, context: ValidationContext): ValidationPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return parseValidationPlan(value, context)
  }

  const proposal = { ...(value as Record<string, unknown>) }
  if (Array.isArray(proposal.cases)) {
    proposal.cases = proposal.cases.map((case_value) => {
      if (typeof case_value !== "object" || case_value === null || Array.isArray(case_value)) {
        return case_value
      }
      const validation_case = { ...(case_value as Record<string, unknown>) }
      const requirement_ids = Array.isArray(validation_case.requirement_ids)
        ? validation_case.requirement_ids.filter(
            (requirement_id): requirement_id is string => typeof requirement_id === "string",
          )
        : []
      const bound_requirements = requirement_ids.flatMap((requirement_id) => {
        const binding = context.model_requirements.find(
          (requirement) => requirement.requirement_id === requirement_id,
        )?.reference_curve?.electrical_binding
        return binding ? [binding] : []
      })
      if (bound_requirements.length === 1 && context.application_fixture?.availability === "documented") {
        const application_fixture = resolveApplicationFixtureForBinding({
          contract: context.application_fixture,
          binding: bound_requirements[0]!,
        })
        validation_case.application_fixture = application_fixture
        const expected_nets = exactApplicationNetIds(application_fixture)
        const proposed_nets = Array.isArray(validation_case.nets) ? validation_case.nets : []
        validation_case.nets = [
          ...expected_nets,
          ...proposed_nets.filter((net) => typeof net !== "string" || !expected_nets.includes(net)),
        ]
        const proposed_fixtures = Array.isArray(validation_case.fixtures) ? validation_case.fixtures : []
        validation_case.fixtures = [
          ...proposed_fixtures,
          ...application_fixture.fixtures.map(applicationPassiveToFixture),
        ]
      }
      if (Array.isArray(validation_case.observations)) {
        validation_case.observations = validation_case.observations.map((observation_value) => {
          if (
            typeof observation_value !== "object" ||
            observation_value === null ||
            Array.isArray(observation_value)
          ) {
            return observation_value
          }
          const observation = { ...(observation_value as Record<string, unknown>) }
          delete observation.reference
          delete observation.evidence
          return observation
        })
      }
      return validation_case
    })
  }
  return parseValidationPlan(proposal, context)
}
