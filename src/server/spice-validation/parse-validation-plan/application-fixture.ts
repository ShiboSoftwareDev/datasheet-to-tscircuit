import {
  type ApplicationFixtureContract,
  type ApplicationPassiveFixture,
  type ResolvedApplicationFixture,
  resolveApplicationFixtureForBinding,
} from "../../modeling/application-fixture-contract"
import type { ModelReferenceElectricalBinding, ModelRequirement } from "../../modeling/types"
import { stableStringify } from "../hashing"
import type { ValidationCollector } from "../parse-helpers"
import type { FixtureElement, ValidationCase } from "../types"

export function applicationPassiveToFixture(fixture: ApplicationPassiveFixture): FixtureElement {
  if (fixture.type === "diode") {
    return { id: fixture.id, type: fixture.type, anode: fixture.anode, cathode: fixture.cathode }
  }
  if (fixture.type === "resistor") {
    return {
      id: fixture.id,
      type: fixture.type,
      positive: fixture.positive,
      negative: fixture.negative,
      resistance_ohms: fixture.resistance_ohms,
    }
  }
  if (fixture.type === "capacitor") {
    return {
      id: fixture.id,
      type: fixture.type,
      positive: fixture.positive,
      negative: fixture.negative,
      capacitance_farads: fixture.capacitance_farads,
    }
  }
  return {
    id: fixture.id,
    type: fixture.type,
    positive: fixture.positive,
    negative: fixture.negative,
    inductance_henries: fixture.inductance_henries,
  }
}

export function expectedApplicationFixture(input: {
  binding: ModelReferenceElectricalBinding
  contract: ApplicationFixtureContract | undefined
  path: string
  collector: ValidationCollector
}): ResolvedApplicationFixture | undefined {
  const { binding, contract, path, collector } = input
  if (!contract) {
    if (binding.application_fixture_sha256 || binding.application_topology_sha256) {
      collector.add(
        path,
        "application_fixture_context_missing",
        "the bound requirement names application fixture digests but validation has no server-owned application fixture contract",
      )
    }
    return undefined
  }
  if (contract.availability !== "documented") {
    if (binding.application_fixture_sha256 || binding.application_topology_sha256) {
      collector.add(
        path,
        "application_fixture_unavailable",
        "application fixture digests must be omitted when canonical evidence explicitly declares the typical application not_present",
      )
    }
    return undefined
  }
  if (!binding.application_fixture_sha256 || !binding.application_topology_sha256) {
    collector.add(
      path,
      "application_fixture_digest_missing",
      "a fresh documented-application binding must carry both server-owned application fixture digests",
    )
    return undefined
  }
  if (binding.application_fixture_sha256 !== contract.contract_sha256) {
    collector.add(
      `${path}.application_fixture_sha256`,
      "application_fixture_digest_mismatch",
      `must equal server-owned application fixture ${contract.contract_sha256}`,
    )
    return undefined
  }
  let resolved: ResolvedApplicationFixture
  try {
    resolved = resolveApplicationFixtureForBinding({ contract, binding })
  } catch (error) {
    collector.add(
      path,
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "application_fixture_resolution_failed",
      error instanceof Error ? error.message : String(error),
    )
    return undefined
  }
  if (binding.application_topology_sha256 !== resolved.topology_sha256) {
    collector.add(
      `${path}.application_topology_sha256`,
      "application_topology_digest_mismatch",
      `must equal server-resolved experiment topology ${resolved.topology_sha256}`,
    )
    return undefined
  }
  return resolved
}

export function exactApplicationNetIds(application_fixture: ResolvedApplicationFixture): string[] {
  return application_fixture.node_groups.filter(({ is_ground }) => !is_ground).map(({ id }) => id)
}

export function validateExactApplicationCase(input: {
  raw_application_fixture: unknown
  application_fixture: ResolvedApplicationFixture
  nets: readonly string[]
  fixtures: readonly FixtureElement[]
  path: string
  collector: ValidationCollector
  allowed_extra_passive_ids?: ReadonlySet<string>
}): void {
  const expected_nets = exactApplicationNetIds(input.application_fixture)
  if (stableStringify(input.nets) !== stableStringify(expected_nets)) {
    input.collector.add(
      `${input.path}.nets`,
      "application_node_groups_mismatch",
      `must contain exactly the server-owned application node groups in order: ${expected_nets.join(", ")}`,
    )
  }
  if (stableStringify(input.raw_application_fixture) !== stableStringify(input.application_fixture)) {
    input.collector.add(
      `${input.path}.application_fixture`,
      "application_fixture_topology_mismatch",
      `must exactly match server-resolved application topology ${input.application_fixture.topology_sha256}`,
    )
  }
  const expected_passives = input.application_fixture.fixtures.map(applicationPassiveToFixture)
  const expected_by_id = new Map(expected_passives.map((fixture) => [fixture.id, fixture]))
  const passive_types = new Set<FixtureElement["type"]>(["resistor", "capacitor", "inductor", "diode"])
  for (const [fixture_index, fixture] of input.fixtures.entries()) {
    if (!passive_types.has(fixture.type)) continue
    const expected = expected_by_id.get(fixture.id)
    if (!expected) {
      if (!input.allowed_extra_passive_ids?.has(fixture.id)) {
        input.collector.add(
          `${input.path}.fixtures[${fixture_index}]`,
          "application_fixture_extra_passive",
          `passive ${JSON.stringify(fixture.id)} is not present in the canonical typical application`,
        )
      }
      continue
    }
    if (stableStringify(fixture) !== stableStringify(expected)) {
      input.collector.add(
        `${input.path}.fixtures[${fixture_index}]`,
        "application_fixture_changed_passive",
        `must exactly match server-owned passive ${JSON.stringify(expected)}`,
      )
    }
  }
  for (const expected of expected_passives) {
    const matches = input.fixtures.filter(
      (fixture) => fixture.id === expected.id && stableStringify(fixture) === stableStringify(expected),
    )
    if (matches.length !== 1) {
      input.collector.add(
        `${input.path}.fixtures`,
        "application_fixture_passive_count",
        `must contain exactly one unchanged server-owned passive ${expected.id}; found ${matches.length}`,
      )
    }
  }
}

export function validateRequirementElectricalBindings(input: {
  requirement_ids: readonly string[]
  requirement_by_id: ReadonlyMap<string, ModelRequirement>
  fixtures: ValidationCase["fixtures"]
  analysis: ValidationCase["analysis"]
  path: string
  collector: ValidationCollector
  application_fixture?: ResolvedApplicationFixture
}): string | undefined {
  const bound_requirements = input.requirement_ids.flatMap((requirement_id, requirement_index) => {
    const binding = input.requirement_by_id.get(requirement_id)?.reference_curve?.electrical_binding
    return binding ? [{ requirement_id, requirement_index, binding }] : []
  })
  if (bound_requirements.length === 0) return undefined
  if (bound_requirements.length !== 1 || input.requirement_ids.length !== 1) {
    input.collector.add(
      `${input.path}.requirement_ids`,
      "bound_case_requirement_count",
      "a case containing a fresh graph electrical binding must cover exactly one modeled requirement",
    )
  }

  const pulsed_sources = input.fixtures.flatMap((fixture, fixture_index) =>
    (fixture.type === "voltage_source" || fixture.type === "current_source") && fixture.pulse
      ? [{ fixture, fixture_index }]
      : [],
  )
  const matched_fixture_indexes = new Set<number>()
  for (const { requirement_id, requirement_index, binding } of bound_requirements) {
    if (binding.stimulus.type !== "steady_state") {
      const expected_type = binding.stimulus.type === "voltage_step" ? "voltage_source" : "current_source"
      const matches = pulsed_sources.filter(
        ({ fixture }) =>
          fixture.type === expected_type &&
          fixture.positive === binding.stimulus.positive &&
          fixture.negative === binding.stimulus.negative,
      )
      if (matches.length !== 1) {
        input.collector.add(
          `${input.path}.requirement_ids[${requirement_index}]`,
          "requirement_stimulus_mismatch",
          `requirement ${JSON.stringify(requirement_id)} needs exactly one ${expected_type} PULSE from ${binding.stimulus.positive} to ${binding.stimulus.negative}; found ${matches.length}`,
        )
        continue
      }
      const match = matches[0]!
      matched_fixture_indexes.add(match.fixture_index)
      if (match.fixture.pulse!.low === match.fixture.pulse!.high) {
        input.collector.add(
          `${input.path}.fixtures[${match.fixture_index}].pulse`,
          "flat_bound_stimulus",
          `the pulsed stimulus bound to requirement ${JSON.stringify(requirement_id)} must have different low and high levels`,
        )
      }
      const expected_pulse = binding.stimulus.pulse
      const actual_pulse = match.fixture.pulse!
      const dc_value =
        match.fixture.type === "voltage_source" ? match.fixture.dc_volts : match.fixture.dc_amps
      if (dc_value !== expected_pulse.low) {
        input.collector.add(
          `${input.path}.fixtures[${match.fixture_index}].${match.fixture.type === "voltage_source" ? "dc_volts" : "dc_amps"}`,
          "requirement_stimulus_dc_mismatch",
          `must equal the observer-owned PULSE low value ${expected_pulse.low} for requirement ${JSON.stringify(requirement_id)}`,
        )
      }
      if (
        actual_pulse.low !== expected_pulse.low ||
        actual_pulse.high !== expected_pulse.high ||
        actual_pulse.delay !== expected_pulse.delay ||
        actual_pulse.rise !== expected_pulse.rise ||
        actual_pulse.fall !== expected_pulse.fall ||
        actual_pulse.width !== expected_pulse.width ||
        actual_pulse.period !== expected_pulse.period
      ) {
        input.collector.add(
          `${input.path}.fixtures[${match.fixture_index}].pulse`,
          "requirement_stimulus_pulse_mismatch",
          `must exactly match the observer-owned SI PULSE for requirement ${JSON.stringify(requirement_id)}: ${JSON.stringify(expected_pulse)}`,
        )
      }
      if (input.analysis.type === "transient") {
        const reference_max = Math.max(
          ...(input.requirement_by_id.get(requirement_id)?.reference_curve?.points ?? []).map(({ x }) => x),
          0,
        )
        const minimum_stop = Math.max(expected_pulse.delay + expected_pulse.rise, reference_max)
        if (input.analysis.stop < minimum_stop) {
          input.collector.add(
            `${input.path}.analysis.stop`,
            "bound_stimulus_outside_analysis_range",
            `must be at least ${minimum_stop} s to include the observer-owned pulse transition and complete reference curve for requirement ${JSON.stringify(requirement_id)}`,
          )
        }
      }
    }

    for (const [auxiliary_index, auxiliary] of (binding.auxiliary_fixtures ?? []).entries()) {
      if (auxiliary.type === "logic_state" && input.application_fixture) {
        const overlay_matches = input.application_fixture.condition_overlays.filter(
          (overlay) =>
            overlay.type === "logic_state" &&
            overlay.endpoint === auxiliary.endpoint &&
            overlay.reference === auxiliary.reference &&
            overlay.state === auxiliary.state,
        )
        if (overlay_matches.length !== 1) {
          input.collector.add(
            `${input.path}.requirement_ids[${requirement_index}]`,
            "requirement_logic_overlay_mismatch",
            `requirement ${JSON.stringify(requirement_id)} needs exactly one server-owned ${auxiliary.state} topology overlay from ${auxiliary.endpoint} to ${auxiliary.reference}; found ${overlay_matches.length}`,
          )
        }
        continue
      }
      const expected =
        auxiliary.type === "dc_voltage"
          ? {
              fixture_type: "voltage_source" as const,
              positive: auxiliary.positive,
              negative: auxiliary.negative,
              value_key: "dc_volts" as const,
              value: auxiliary.dc_volts,
            }
          : auxiliary.type === "dc_current"
            ? {
                fixture_type: "current_source" as const,
                positive: auxiliary.positive,
                negative: auxiliary.negative,
                value_key: "dc_amps" as const,
                value: auxiliary.dc_amps,
              }
            : auxiliary.type === "resistor"
              ? {
                  fixture_type: "resistor" as const,
                  positive: auxiliary.positive,
                  negative: auxiliary.negative,
                  value_key: "resistance_ohms" as const,
                  value: auxiliary.resistance_ohms,
                }
              : {
                  fixture_type: "voltage_source" as const,
                  positive: auxiliary.endpoint,
                  negative: auxiliary.reference,
                  value_key: "dc_volts" as const,
                  value: 0,
                }
      const matches = input.fixtures.flatMap((fixture, fixture_index) => {
        if (
          fixture.type !== expected.fixture_type ||
          ("pulse" in fixture && fixture.pulse !== undefined) ||
          fixture.positive !== expected.positive ||
          fixture.negative !== expected.negative ||
          (fixture.type === "voltage_source"
            ? fixture.dc_volts
            : fixture.type === "current_source"
              ? fixture.dc_amps
              : fixture.resistance_ohms) !== expected.value
        ) {
          return []
        }
        return [{ fixture_index }]
      })
      if (matches.length !== 1) {
        input.collector.add(
          `${input.path}.requirement_ids[${requirement_index}]`,
          "requirement_auxiliary_fixture_mismatch",
          `requirement ${JSON.stringify(requirement_id)} needs exactly one static ${expected.fixture_type} from ${expected.positive} to ${expected.negative} with ${expected.value_key}=${expected.value} for auxiliary condition ${auxiliary_index}; found ${matches.length}`,
        )
      } else if (matched_fixture_indexes.has(matches[0]!.fixture_index)) {
        input.collector.add(
          `${input.path}.fixtures[${matches[0]!.fixture_index}]`,
          "requirement_auxiliary_fixture_reused",
          "one validation fixture cannot satisfy more than one immutable printed condition",
        )
      } else {
        matched_fixture_indexes.add(matches[0]!.fixture_index)
      }
    }

    input.fixtures.forEach((fixture, fixture_index) => {
      if (
        fixture.type !== "voltage_source" ||
        fixture.pulse !== undefined ||
        !(
          (fixture.positive === binding.response.positive &&
            fixture.negative === binding.response.negative) ||
          (fixture.positive === binding.response.negative && fixture.negative === binding.response.positive)
        )
      ) {
        return
      }
      input.collector.add(
        `${input.path}.fixtures[${fixture_index}]`,
        "bound_response_clamp",
        `an exact datasheet experiment must observe ${binding.response.positive} relative to ${binding.response.negative}; a DC voltage source must not clamp that response`,
      )
    })

    const protected_public_endpoints = new Set(
      [
        binding.response.positive,
        binding.response.negative,
        ...(binding.stimulus.type === "steady_state"
          ? []
          : [binding.stimulus.positive, binding.stimulus.negative]),
        ...(binding.auxiliary_fixtures ?? []).flatMap((auxiliary) =>
          auxiliary.type === "logic_state"
            ? [auxiliary.endpoint, auxiliary.reference]
            : [auxiliary.positive, auxiliary.negative],
        ),
      ].filter((endpoint) => endpoint !== "gnd"),
    )
    input.fixtures.forEach((fixture, fixture_index) => {
      if (
        (fixture.type !== "voltage_source" && fixture.type !== "current_source") ||
        matched_fixture_indexes.has(fixture_index)
      ) {
        return
      }
      if (
        !protected_public_endpoints.has(fixture.positive as `dut.${string}`) &&
        !protected_public_endpoints.has(fixture.negative as `dut.${string}`)
      ) {
        return
      }
      input.collector.add(
        `${input.path}.fixtures[${fixture_index}]`,
        "unbound_bound_condition_source",
        "an independent source touching a bound response, stimulus, or auxiliary public endpoint must be the one exact immutable source for that printed experiment",
      )
    })
  }

  for (const { fixture_index } of pulsed_sources) {
    if (!matched_fixture_indexes.has(fixture_index)) {
      input.collector.add(
        `${input.path}.fixtures[${fixture_index}]`,
        "unbound_pulsed_stimulus",
        "every PULSE source in a fresh bound case must match a requirement's immutable stimulus kind and endpoints",
      )
    }
  }
  if (input.application_fixture) {
    input.fixtures.forEach((fixture, fixture_index) => {
      if (
        (fixture.type === "voltage_source" || fixture.type === "current_source") &&
        !matched_fixture_indexes.has(fixture_index)
      ) {
        input.collector.add(
          `${input.path}.fixtures[${fixture_index}]`,
          "application_fixture_extra_source",
          "a documented-application experiment may contain only the exact bound stimulus and auxiliary sources; extra or parallel ideal sources change the printed topology",
        )
      }
    })
  }
  return bound_requirements.length === 1 ? bound_requirements[0]!.requirement_id : undefined
}
