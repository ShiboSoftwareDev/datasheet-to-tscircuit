import type {
  ApplicationFixtureContract,
  ApplicationPassiveFixture,
} from "../../modeling/application-fixture-contract"
import type { ModelInterface, ModelReferenceElectricalBinding } from "../../modeling/types"
import type {
  TimeGraphDiscovery,
  TimeGraphLocalCondition,
  TimeGraphTransientFixtureEvidence,
} from "../time-graph-hints"
import type { ObservedReferenceGraph, ObservedVoltageTimeCurve } from "./types"

function normalizedElectricalSignal(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase()
}

function matchingPublicPins(model_interface: ModelInterface, signal: string): ModelInterface["pins"] {
  const normalized_signal = normalizedElectricalSignal(signal)
  const exact = model_interface.pins.filter(({ spice_node, labels }) =>
    [spice_node, ...labels].some((label) => normalizedElectricalSignal(label) === normalized_signal),
  )
  if (exact.length > 0) return exact

  const preferred_roles =
    normalized_signal === "VO" || normalized_signal === "VOUT" || normalized_signal === "OUTPUTVOLTAGE"
      ? ["power_output", "output"]
      : normalized_signal === "VI" || normalized_signal === "INPUTVOLTAGE"
        ? ["power_input", "input"]
        : undefined
  if (!preferred_roles) return []
  for (const preferred_role of preferred_roles) {
    const matches = model_interface.pins.filter(({ role }) => role === preferred_role)
    if (matches.length > 0) return matches
  }
  return []
}

function uniquePrintedSignalEndpoint(input: {
  model_interface: ModelInterface
  signal: string
  path: string
}): `dut.${string}` {
  const matches = matchingPublicPins(input.model_interface, input.signal)
  if (matches.length !== 1) {
    throw new Error(
      `${input.path} printed signal ${input.signal} resolves to ${matches.length} public model pins; exactly one is required`,
    )
  }
  return `dut.${matches[0]!.spice_node}`
}

export function assertBindingMatchesPrintedFixture(input: {
  graph: ObservedReferenceGraph & {
    electrical_binding: ModelReferenceElectricalBinding
    digitized_curve: ObservedVoltageTimeCurve
  }
  evidence: TimeGraphTransientFixtureEvidence
  model_interface: ModelInterface
}): void {
  const { graph, evidence, model_interface } = input
  const path = `Eligible graph ${graph.graph_id}`
  const response_positive = uniquePrintedSignalEndpoint({
    model_interface,
    signal: evidence.response.signal,
    path,
  })
  const stimulus_positive =
    evidence.stimulus.type === "current_step" &&
    /^(?:IO|ILOAD|LOADCURRENT)$/i.test(normalizedElectricalSignal(evidence.stimulus.signal))
      ? response_positive
      : uniquePrintedSignalEndpoint({
          model_interface,
          signal: evidence.stimulus.signal,
          path,
        })
  const auxiliary_fixtures = evidence.auxiliary_conditions.map((condition, index) => {
    const condition_path = `${path} auxiliary condition ${index}`
    if (condition.kind === "dc_voltage") {
      return {
        type: "dc_voltage" as const,
        positive: uniquePrintedSignalEndpoint({
          model_interface,
          signal: condition.signal,
          path: condition_path,
        }),
        negative: "gnd" as const,
        dc_volts: condition.value,
      }
    }
    if (condition.kind === "dc_current") {
      const positive = /^(?:IO|ILOAD|LOADCURRENT)$/i.test(normalizedElectricalSignal(condition.signal))
        ? response_positive
        : uniquePrintedSignalEndpoint({
            model_interface,
            signal: condition.signal,
            path: condition_path,
          })
      return {
        type: "dc_current" as const,
        positive,
        negative: "gnd" as const,
        dc_amps: condition.value,
      }
    }
    const logic_endpoint = uniquePrintedSignalEndpoint({
      model_interface,
      signal: condition.signal,
      path: condition_path,
    })
    const input_supply_endpoints = [
      ...evidence.auxiliary_conditions.flatMap((candidate) =>
        candidate.kind === "dc_voltage" &&
        /^(?:VI|VIN|INPUTVOLTAGE)$/i.test(normalizedElectricalSignal(candidate.signal))
          ? [
              uniquePrintedSignalEndpoint({
                model_interface,
                signal: candidate.signal,
                path: condition_path,
              }),
            ]
          : [],
      ),
      ...(evidence.stimulus.type === "voltage_step" &&
      /^(?:VI|VIN|INPUTVOLTAGE)$/i.test(normalizedElectricalSignal(evidence.stimulus.signal))
        ? [stimulus_positive]
        : []),
    ]
    const unique_input_supply_endpoints = [...new Set(input_supply_endpoints)]
    if (condition.state === "high" && unique_input_supply_endpoints.length !== 1) {
      throw new Error(
        `${condition_path} printed high state cannot map uniquely to one public input-supply endpoint`,
      )
    }
    return {
      type: "logic_state" as const,
      endpoint: logic_endpoint,
      reference: condition.state === "low" ? ("gnd" as const) : unique_input_supply_endpoints[0]!,
      state: condition.state,
    }
  })
  const binding = graph.electrical_binding
  if (
    binding.response.positive !== response_positive ||
    binding.response.negative !== "gnd" ||
    binding.response.nominal_volts !== evidence.response.nominal_volts ||
    binding.stimulus.type !== evidence.stimulus.type ||
    binding.stimulus.positive !== stimulus_positive ||
    binding.stimulus.negative !== "gnd" ||
    binding.stimulus.pulse.low !== evidence.stimulus.low ||
    binding.stimulus.pulse.high !== evidence.stimulus.high ||
    binding.stimulus.pulse.rise !== evidence.stimulus.rise ||
    binding.stimulus.pulse.fall !== evidence.stimulus.fall ||
    JSON.stringify(binding.auxiliary_fixtures ?? []) !== JSON.stringify(auxiliary_fixtures)
  ) {
    throw new Error(
      `${path} electrical_binding must exactly match the server-extracted printed response nominal, stimulus, and every auxiliary fixture`,
    )
  }
  const { min, max } = graph.digitized_curve.x_range
  const pulse = binding.stimulus.pulse
  const falling_edge_start = pulse.delay + pulse.rise + pulse.width
  const falling_edge_end = pulse.delay + pulse.rise + pulse.width + pulse.fall
  const printed_second_edge_is_inside = falling_edge_end <= max
  const single_printed_edge_is_held_through_window = falling_edge_start >= max
  if (
    min < 0 ||
    pulse.delay < min ||
    pulse.delay > max ||
    pulse.delay + pulse.rise > max ||
    (!printed_second_edge_is_inside && !single_printed_edge_is_held_through_window) ||
    pulse.period <= max
  ) {
    throw new Error(
      `${path} PULSE timing must place the printed first edge inside the non-negative calibrated time window, either place the second edge fully inside or hold it beyond the window, and keep the next period beyond that window`,
    )
  }
}

type GraphPassiveCondition = Extract<TimeGraphLocalCondition, { kind: "passive_value" }>

type GraphPassiveConstraintFailureCode =
  | "graph_passive_application_fixture_missing"
  | "graph_passive_application_fixture_not_present"
  | "graph_passive_application_fixture_ambiguous"
  | "graph_passive_application_fixture_value_mismatch"

interface GraphPassiveConstraintFailure {
  code: GraphPassiveConstraintFailureCode
  message: string
}

function normalizedApplicationIdentity(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase()
}

function applicationPassiveValue(fixture: ApplicationPassiveFixture): number | undefined {
  if (fixture.type === "resistor") return fixture.resistance_ohms
  if (fixture.type === "capacitor") return fixture.capacitance_farads
  if (fixture.type === "inductor") return fixture.inductance_henries
  return undefined
}

function passiveSiValuesRepresentSameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-18, Math.max(Math.abs(left), Math.abs(right)) * 1e-12)
}

function applicationFixtureEndpoints(fixture: ApplicationPassiveFixture): [string, string] | undefined {
  if (fixture.type === "diode") return undefined
  return [fixture.positive, fixture.negative]
}

function applicationNodeMatchesSignal(input: {
  contract: ApplicationFixtureContract
  endpoint: string
  signal: "input" | "output"
}): boolean {
  if (!input.endpoint.startsWith("net.")) return false
  const node_group = input.contract.node_groups.find(({ id }) => `net.${id}` === input.endpoint)
  if (!node_group) return false
  const aliases =
    input.signal === "input"
      ? new Set(["VI", "VIN", "INPUT", "INPUTVOLTAGE"])
      : new Set(["VO", "VOUT", "OUT", "OUTPUT", "OUTPUTVOLTAGE"])
  const identities = [
    node_group.source_net,
    ...node_group.external_terminals,
    ...node_group.source_endpoints.flatMap((endpoint) => {
      const separator = endpoint.indexOf(".")
      return separator < 0 ? [endpoint] : [endpoint, endpoint.slice(separator + 1)]
    }),
  ].map(normalizedApplicationIdentity)
  return identities.some((identity) => aliases.has(identity))
}

function applicationFixtureConnectsSignalToGround(input: {
  contract: ApplicationFixtureContract
  fixture: ApplicationPassiveFixture
  signal: "input" | "output"
}): boolean {
  const endpoints = applicationFixtureEndpoints(input.fixture)
  if (!endpoints) return false
  return endpoints.some((endpoint, index) => {
    const other = endpoints[index === 0 ? 1 : 0]
    return (
      other === "gnd" &&
      applicationNodeMatchesSignal({
        contract: input.contract,
        endpoint,
        signal: input.signal,
      })
    )
  })
}

function applicationPassiveCandidates(input: {
  contract: ApplicationFixtureContract
  constraint: GraphPassiveCondition
}): ApplicationPassiveFixture[] {
  const same_type = input.contract.fixtures.filter(
    (fixture) => fixture.type === input.constraint.passive_type,
  )
  const exact_reference = same_type.filter(
    ({ reference }) => normalizedApplicationIdentity(reference) === input.constraint.label,
  )
  if (exact_reference.length > 0) return exact_reference

  const label = input.constraint.label
  if (
    input.constraint.passive_type === "capacitor" &&
    new Set(["COUT", "CO", "OUTPUTCAPACITOR", "OUTPUTCAPACITANCE"]).has(label)
  ) {
    return same_type.filter((fixture) =>
      applicationFixtureConnectsSignalToGround({
        contract: input.contract,
        fixture,
        signal: "output",
      }),
    )
  }
  if (
    input.constraint.passive_type === "capacitor" &&
    new Set(["CIN", "CI", "INPUTCAPACITOR", "INPUTCAPACITANCE"]).has(label)
  ) {
    return same_type.filter((fixture) =>
      applicationFixtureConnectsSignalToGround({
        contract: input.contract,
        fixture,
        signal: "input",
      }),
    )
  }
  if (
    input.constraint.passive_type === "resistor" &&
    new Set(["RLOAD", "ROUT", "LOADRESISTOR", "OUTPUTRESISTOR"]).has(label)
  ) {
    return same_type.filter((fixture) =>
      applicationFixtureConnectsSignalToGround({
        contract: input.contract,
        fixture,
        signal: "output",
      }),
    )
  }
  const generic_labels: Record<GraphPassiveCondition["passive_type"], ReadonlySet<string>> = {
    resistor: new Set(["R", "RESISTOR"]),
    capacitor: new Set(["C", "CAPACITOR"]),
    inductor: new Set(["L", "LOUT", "INDUCTOR", "POWERINDUCTOR"]),
  }
  return generic_labels[input.constraint.passive_type].has(label) ? same_type : []
}

export function reconcileGraphPassiveConstraints(input: {
  source_hints: TimeGraphDiscovery["hints"]
  application_fixture?: ApplicationFixtureContract
}): GraphPassiveConstraintFailure | undefined {
  const constraints = input.source_hints
    .flatMap(({ graph_local_conditions }) => graph_local_conditions?.conditions ?? [])
    .filter((condition): condition is GraphPassiveCondition => condition.kind === "passive_value")
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    .filter(
      (condition, index, values) =>
        index === 0 || JSON.stringify(condition) !== JSON.stringify(values[index - 1]!),
    )
  if (constraints.length === 0) return undefined
  if (!input.application_fixture) {
    return {
      code: "graph_passive_application_fixture_missing",
      message: "graph-local passive values require a server-owned application fixture contract",
    }
  }
  if (input.application_fixture.availability !== "documented") {
    return {
      code: "graph_passive_application_fixture_not_present",
      message:
        "graph-local passive values cannot be reproduced because canonical application evidence is not_present",
    }
  }
  for (const constraint of constraints) {
    const candidates = applicationPassiveCandidates({
      contract: input.application_fixture,
      constraint,
    })
    if (candidates.length !== 1) {
      return {
        code: "graph_passive_application_fixture_ambiguous",
        message:
          `printed ${constraint.label} (${constraint.passive_type}) resolves to ${candidates.length} ` +
          "canonical application passives; exactly one is required",
      }
    }
    const fixture = candidates[0]!
    const application_value = applicationPassiveValue(fixture)
    if (
      application_value === undefined ||
      !passiveSiValuesRepresentSameNumber(application_value, constraint.value_si)
    ) {
      return {
        code: "graph_passive_application_fixture_value_mismatch",
        message:
          `printed ${constraint.label}=${constraint.value_si} SI does not match ` +
          `canonical application ${fixture.reference}=${String(application_value)} SI`,
      }
    }
  }
  return undefined
}
