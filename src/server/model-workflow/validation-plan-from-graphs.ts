import type {
  ModelContract,
  ModelReferenceAuxiliaryFixture,
  ModelReferenceElectricalBinding,
} from "../modeling"
import { parseAgentValidationPlan, type FixtureElement, type ValidationPlan } from "../spice-validation"

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
  return {
    id,
    type: "voltage_source",
    positive: auxiliary.endpoint,
    negative: auxiliary.reference,
    dc_volts: 0,
  }
}

function stimulusFixture(binding: ModelReferenceElectricalBinding): FixtureElement {
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
  const stop = Math.max(maximum, binding.stimulus.pulse.delay + binding.stimulus.pulse.rise) + step
  return {
    type: "transient" as const,
    step,
    stop,
    ...(minimum > 0 ? { start: minimum } : {}),
  }
}

function protectedEndpoints(binding: ModelReferenceElectricalBinding): Set<string> {
  return new Set([
    binding.response.positive,
    binding.response.negative,
    binding.stimulus.positive,
    binding.stimulus.negative,
    ...(binding.auxiliary_fixtures ?? []).flatMap((fixture) =>
      fixture.type === "logic_state"
        ? [fixture.endpoint, fixture.reference]
        : [fixture.positive, fixture.negative],
    ),
  ])
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
  const cases = modeled.map((requirement) => {
    const curve = requirement.reference_curve
    const binding = curve?.electrical_binding
    if (
      requirement.analysis !== "transient" ||
      !curve ||
      curve.x_quantity !== "time" ||
      curve.x_unit !== "s" ||
      curve.y_quantity !== "voltage" ||
      curve.y_unit !== "V" ||
      !binding
    ) {
      throw new Error(
        `Modeled requirement ${requirement.requirement_id} is not a bound voltage-versus-time graph`,
      )
    }
    const fixtures: FixtureElement[] = [
      stimulusFixture(binding),
      ...(binding.auxiliary_fixtures ?? []).flatMap((auxiliary, index) =>
        auxiliary.type === "logic_state" && has_documented_application
          ? []
          : [fixtureForAuxiliary(auxiliary, index)],
      ),
    ]
    if (!has_documented_application) {
      const connected = new Set(
        fixtures.flatMap((fixture) =>
          fixture.type === "diode" ? [fixture.anode, fixture.cathode] : [fixture.positive, fixture.negative],
        ),
      )
      const protected_endpoints = protectedEndpoints(binding)
      for (const [pin_index, pin] of contract.interface.pins.entries()) {
        const endpoint = `dut.${pin.spice_node}` as const
        if (connected.has(endpoint)) continue
        fixtures.push({
          id: `pin_bias_${pin_index + 1}`,
          type: "resistor",
          positive: endpoint,
          negative: "gnd",
          resistance_ohms: protected_endpoints.has(endpoint) ? 1e12 : 1e9,
        })
      }
    }
    return {
      id: requirement.requirement_id,
      title: requirement.title,
      requirement_ids: [requirement.requirement_id],
      nets: [],
      fixtures,
      analysis: transientAnalysis(curve.points, binding),
      observations: [
        {
          id: "response",
          requirement_id: requirement.requirement_id,
          type: "voltage",
          positive: binding.response.positive,
          negative: binding.response.negative,
          unit: "V",
          scale: "linear",
        },
      ],
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
