import type { ApplicationFixtureContract } from "../../modeling/application-fixture-contract"
import type { ModelRequirement } from "../../modeling/types"
import { CASE_ID_PATTERN, IDENTIFIER_PATTERN } from "../identifiers"
import type { ValidationModelDefinition } from "../model-definition"
import { parseAnalysis } from "../parse-analysis"
import { parseFixtureElement } from "../parse-fixtures"
import type { ValidationCollector } from "../parse-helpers"
import { parseObservation } from "../parse-observations"
import type { ValidationCase } from "../types"
import { validateCaseConnectivity } from "../validate-plan-connectivity"
import {
  expectedApplicationFixture,
  validateExactApplicationCase,
  validateRequirementElectricalBindings,
} from "./application-fixture"
import { deterministicDutPinBiases } from "../dut-pin-bias"

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

export function parseCase(
  value: unknown,
  index: number,
  model_definition: ValidationModelDefinition,
  requirement_by_id: ReadonlyMap<string, ModelRequirement>,
  modeled_requirement_ids: Set<string>,
  covered_requirement_ids: Set<string>,
  covered_dut_pins: Set<string>,
  collector: ValidationCollector,
  application_contract: ApplicationFixtureContract | undefined,
): ValidationCase {
  const path = `cases[${index}]`
  const record = collector.record(value, path)
  collector.rejectUnknownKeys(
    record,
    ["id", "title", "requirement_ids", "nets", "fixtures", "analysis", "observations", "application_fixture"],
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
  const bound_requirements = requirement_ids.flatMap((requirement_id, requirement_index) => {
    const binding = requirement_by_id.get(requirement_id)?.reference_curve?.electrical_binding
    return binding ? [{ binding, requirement_index }] : []
  })
  const shared_binding = bound_requirements[0]?.binding
  const application_fixture =
    shared_binding &&
    bound_requirements.every(({ binding }) => JSON.stringify(binding) === JSON.stringify(shared_binding))
      ? expectedApplicationFixture({
          binding: shared_binding,
          contract: application_contract,
          path: `${path}.requirement_ids[${bound_requirements[0]!.requirement_index}]`,
          collector,
        })
      : undefined
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
  const bound_requirement_id = validateRequirementElectricalBindings({
    requirement_ids,
    requirement_by_id,
    fixtures,
    analysis,
    path,
    collector,
    application_fixture,
  })
  if (application_fixture) {
    const binding = bound_requirement_id
      ? requirement_by_id.get(bound_requirement_id)?.reference_curve?.electrical_binding
      : undefined
    const allowed_extra_passive_ids = new Set(
      (binding?.auxiliary_fixtures ?? []).flatMap((fixture, index) =>
        fixture.type === "resistor" ? [`condition_${index + 1}`] : [],
      ),
    )
    validateExactApplicationCase({
      raw_application_fixture: record.application_fixture,
      application_fixture,
      nets,
      fixtures,
      path,
      collector,
      allowed_extra_passive_ids,
      required_extra_passives: binding
        ? deterministicDutPinBiases({
            model_interface: model_definition,
            binding,
            application_fixture,
          })
        : [],
    })
  } else if (record.application_fixture !== undefined) {
    collector.add(
      `${path}.application_fixture`,
      "unexpected_application_fixture",
      "server-resolved application topology is supported only when all case requirements share one documented graph experiment",
    )
  }
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
    ...(application_fixture ? { application_fixture } : {}),
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
