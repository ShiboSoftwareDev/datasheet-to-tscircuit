import type {
  ModelContract,
  ModelReferenceAuxiliaryFixture,
  ModelReferenceElectricalBinding,
} from "../modeling"
import { modelReferenceElectricalBindingsEqual } from "../modeling/reference-electrical-binding"
import { deterministicDutPinBiases } from "../spice-validation/dut-pin-bias"
import { parseAgentValidationPlan, type FixtureElement, type ValidationPlan } from "../spice-validation"
import { resolveApplicationFixtureForBinding } from "../modeling/application-fixture-contract"

function fixtureForAuxiliary(auxiliary: ModelReferenceAuxiliaryFixture, index: number): FixtureElement {
  const id = `condition_${index + 1}`
  if (auxiliary.type === "dc_voltage") {
    return {
      id,
      type: "voltage_source",
      positive: auxiliary.positive,
      negative: auxiliary.negative,
      dc_volts: auxiliary.dc_volts,
    }
  }
  if (auxiliary.type === "dc_current") {
    return {
      id,
      type: "current_source",
      positive: auxiliary.positive,
      negative: auxiliary.negative,
      dc_amps: auxiliary.dc_amps,
    }
  }
  if (auxiliary.type === "resistor") {
    return {
      id,
      type: "resistor",
      positive: auxiliary.positive,
      negative: auxiliary.negative,
      resistance_ohms: auxiliary.resistance_ohms,
    }
  }
  return {
    id,
    type: "voltage_source",
    positive: auxiliary.endpoint,
    negative: auxiliary.reference,
    dc_volts: 0,
  }
}

function stimulusFixture(binding: ModelReferenceElectricalBinding): FixtureElement | undefined {
  if (binding.stimulus.type === "steady_state") return undefined
  const common = {
    id: "stimulus",
    positive: binding.stimulus.positive,
    negative: binding.stimulus.negative,
    pulse: { ...binding.stimulus.pulse },
  }
  return binding.stimulus.type === "voltage_step"
    ? {
        ...common,
        type: "voltage_source",
        dc_volts: binding.stimulus.pulse.low,
      }
    : {
        ...common,
        type: "current_source",
        dc_amps: binding.stimulus.pulse.low,
      }
}

function transientAnalysis(points: readonly { x: number }[], binding: ModelReferenceElectricalBinding) {
  const x_values = points.map(({ x }) => x)
  const minimum = Math.min(...x_values)
  const maximum = Math.max(...x_values)
  if (minimum < 0 || !(maximum > minimum)) {
    throw new Error("A graph validation circuit requires a non-negative, increasing elapsed-time range")
  }
  const positive_deltas = x_values
    .slice(1)
    .map((value, index) => value - x_values[index]!)
    .filter((value) => value > 0)
  const span = maximum - minimum
  const smallest_delta = Math.min(...positive_deltas)
  const desired_step = Math.min(span / 1000, smallest_delta / 4)
  const step = Math.max(span / 20_000, desired_step, 1e-12)
  const stimulus_end =
    binding.stimulus.type === "steady_state" ? 0 : binding.stimulus.pulse.delay + binding.stimulus.pulse.rise
  const stop = Math.max(maximum, stimulus_end) + step
  const start = Math.max(0, minimum - step)
  return {
    type: "transient" as const,
    step,
    stop,
    ...(start > 0 ? { start } : {}),
  }
}

/**
 * Generates exactly one transient tscircuit/ngspice case per modeled graph.
 * Reference curves, observations, and application topology remain server-owned;
 * there is no validation-plan agent and therefore no opportunity to substitute
 * a scalar or unrelated "typical application" test.
 */
export function buildGraphValidationPlan(contract: ModelContract): ValidationPlan {
  const modeled = contract.characterization.requirements.filter(({ support }) => support.status === "modeled")
  const has_documented_application = contract.application_fixture?.availability === "documented"
  const groups = new Map<string, typeof modeled>()
  for (const requirement of modeled) {
    const graph_id = String(requirement.conditions.graph_id ?? "")
    if (!graph_id) throw new Error(`Modeled requirement ${requirement.requirement_id} has no source graph id`)
    const group = groups.get(graph_id) ?? []
    group.push(requirement)
    groups.set(graph_id, group)
  }
  const cases = [...groups.entries()].map(([graph_id, requirements]) => {
    const first_requirement = requirements[0]!
    const curve = first_requirement.reference_curve
    const binding = curve?.electrical_binding
    if (
      first_requirement.analysis !== "transient" ||
      !curve ||
      curve.x_quantity !== "time" ||
      curve.x_unit !== "s" ||
      !curve.measurement ||
      !curve.channel_id ||
      !curve.channel_role ||
      !binding
    ) {
      throw new Error(
        `Modeled requirement ${first_requirement.requirement_id} is not a bound time-domain channel`,
      )
    }
    for (const requirement of requirements) {
      const candidate = requirement.reference_curve
      if (
        requirement.analysis !== "transient" ||
        !candidate ||
        candidate.x_quantity !== "time" ||
        candidate.x_unit !== "s" ||
        !candidate.measurement ||
        !candidate.channel_id ||
        !candidate.channel_role ||
        !candidate.electrical_binding ||
        !modelReferenceElectricalBindingsEqual(candidate.electrical_binding, binding)
      ) {
        throw new Error(`Modeled requirement ${requirement.requirement_id} is not a channel in ${graph_id}`)
      }
    }
    const stimulus_fixture = stimulusFixture(binding)
    const application_fixture = has_documented_application
      ? resolveApplicationFixtureForBinding({
          contract: contract.application_fixture!,
          binding,
        })
      : undefined
    const fixtures: FixtureElement[] = [
      ...(stimulus_fixture ? [stimulus_fixture] : []),
      ...(binding.auxiliary_fixtures ?? []).flatMap((auxiliary, index) =>
        auxiliary.type === "logic_state" && has_documented_application
          ? []
          : [fixtureForAuxiliary(auxiliary, index)],
      ),
    ]
    fixtures.push(
      ...deterministicDutPinBiases({
        model_interface: contract.interface,
        binding,
        application_fixture,
      }),
    )
    return {
      id: graph_id,
      title: first_requirement.title.replace(/\s+—\s+.+$/, ""),
      requirement_ids: requirements.map(({ requirement_id }) => requirement_id),
      nets: [],
      fixtures,
      analysis: transientAnalysis(
        requirements.flatMap((requirement) => requirement.reference_curve!.points),
        binding,
      ),
      observations: requirements.map((requirement) => {
        const reference = requirement.reference_curve!
        const measurement = reference.measurement!
        const common = {
          id: reference.channel_id!,
          role: reference.channel_role!,
          requirement_id: requirement.requirement_id,
          scale: "linear" as const,
        }
        return measurement.type === "voltage"
          ? {
              ...common,
              type: "voltage" as const,
              positive: measurement.positive,
              negative: measurement.negative,
              unit: "V" as const,
            }
          : {
              ...common,
              type: "current" as const,
              element_id: measurement.element_id,
              direction: measurement.direction,
              unit: "A" as const,
            }
      }),
    }
  })
  return parseAgentValidationPlan(
    {
      version: 1,
      model: {
        entry_name: contract.interface.entry_name,
        pins: contract.interface.pins.map(({ spice_node }) => spice_node),
      },
      cases,
    },
    {
      model_interface: contract.interface,
      model_requirements: contract.characterization.requirements,
      model_family: contract.characterization.family,
      application_fixture: contract.application_fixture,
    },
  )
}
