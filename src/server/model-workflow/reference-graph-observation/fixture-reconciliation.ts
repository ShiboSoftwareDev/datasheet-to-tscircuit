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
import type { ObservedReferenceGraph } from "./types"
import {
  classifyElectricalSignal,
  electricalSignalMatches,
  matchingElectricalSignalAliases,
  normalizeElectricalSignal,
} from "../electrical-signal"

export type FixtureEndpointResolutionErrorCode = "printed_signal_not_unique" | "input_supply_not_unique"

export class FixtureEndpointResolutionError extends Error {
  readonly code: FixtureEndpointResolutionErrorCode

  constructor(code: FixtureEndpointResolutionErrorCode, message: string) {
    super(message)
    this.name = "FixtureEndpointResolutionError"
    this.code = code
  }
}

function resolvePrintedFixtureEndpoints(input: {
  evidence: TimeGraphTransientFixtureEvidence
  model_interface: ModelInterface
  path: string
}) {
  const { evidence, model_interface, path } = input
  const response_positive = uniquePrintedSignalEndpoint({
    model_interface,
    signal: evidence.response.signal,
    path,
  })
  const stimulus_positive =
    evidence.stimulus.type === "steady_state"
      ? undefined
      : evidence.stimulus.type === "current_step" &&
          electricalSignalMatches(evidence.stimulus.signal, "load_current")
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
      const positive = electricalSignalMatches(condition.signal, "load_current")
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
    if (condition.kind === "resistance") {
      return {
        type: "resistor" as const,
        positive: response_positive,
        negative: "gnd" as const,
        resistance_ohms: condition.value,
      }
    }
    const logic_endpoint = uniquePrintedSignalEndpoint({
      model_interface,
      signal: condition.signal,
      path: condition_path,
    })
    const input_supply_endpoints = [
      ...evidence.auxiliary_conditions.flatMap((candidate) =>
        candidate.kind === "dc_voltage" && electricalSignalMatches(candidate.signal, "input_voltage")
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
      electricalSignalMatches(evidence.stimulus.signal, "input_voltage")
        ? [stimulus_positive!]
        : []),
    ]
    const unique_input_supply_endpoints = [...new Set(input_supply_endpoints)]
    if (condition.state === "high" && unique_input_supply_endpoints.length !== 1) {
      throw new FixtureEndpointResolutionError(
        "input_supply_not_unique",
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
  return { response_positive, stimulus_positive, auxiliary_fixtures }
}

export function assertPrintedFixtureEndpointsResolvable(input: {
  evidence: TimeGraphTransientFixtureEvidence
  model_interface: ModelInterface
  graph_id: string
}): void {
  resolvePrintedFixtureEndpoints({
    evidence: input.evidence,
    model_interface: input.model_interface,
    path: `Observed graph ${input.graph_id}`,
  })
}

function matchingPublicPins(model_interface: ModelInterface, signal: string): ModelInterface["pins"] {
  const normalized_signal = normalizeElectricalSignal(signal)
  const semantic_aliases = matchingElectricalSignalAliases(normalized_signal)
  const exact = model_interface.pins.filter(({ spice_node, labels }) =>
    [spice_node, ...labels].some((label) => semantic_aliases.has(normalizeElectricalSignal(label))),
  )
  if (exact.length > 0) return exact

  const signal_kind = classifyElectricalSignal(normalized_signal)
  const preferred_roles =
    signal_kind === "output_voltage"
      ? ["power_output", "output"]
      : signal_kind === "input_voltage"
        ? ["power_input", "input"]
        : undefined
  if (!preferred_roles) return []
  for (const preferred_role of preferred_roles) {
    const matches = model_interface.pins.filter(({ role }) => role === preferred_role)
    if (matches.length > 0) return matches
  }
  return []
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function visibleCurveLevels(points: readonly { y: number }[]): { low: number; high: number } {
  const values = points.map(({ y }) => y).sort((left, right) => left - right)
  const sample_count = Math.max(2, Math.floor(values.length * 0.2))
  const low = median(values.slice(0, sample_count))
  const high = median(values.slice(-sample_count))
  if (!(high > low)) throw new Error("a plotted step channel must contain two distinct voltage levels")
  return { low, high }
}

function valuesApproximatelyEqual(left: number, right: number, scale: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-12, Math.abs(scale) * 0.12)
}

function visibleTransitions(points: readonly { x: number; y: number }[]): Array<{
  direction: "rising" | "falling"
  time: number
}> {
  const { low, high } = visibleCurveLevels(points)
  const midpoint = (low + high) / 2
  const states = points.map(({ y }) => y >= midpoint)
  return points.slice(1).flatMap((point, index) => {
    const before = states[index]!
    const after = states[index + 1]!
    if (before === after) return []
    return [
      {
        direction: after ? ("rising" as const) : ("falling" as const),
        time: (points[index]!.x + point.x) / 2,
      },
    ]
  })
}

function sourceFrequencyHertz(source_hints: TimeGraphDiscovery["hints"]): number | undefined {
  const values = source_hints.flatMap(({ reason, operating_condition_evidence }) => {
    const text = `${reason} ${operating_condition_evidence}`
    return [...text.matchAll(/(?:^|\b)(\d+(?:\.\d*)?|\.\d+)\s*([kmg]?)hz\b/gi)].flatMap((match) => {
      const value = Number(match[1])
      const multiplier =
        match[2]?.toLowerCase() === "k"
          ? 1e3
          : match[2]?.toLowerCase() === "m"
            ? 1e6
            : match[2]?.toLowerCase() === "g"
              ? 1e9
              : 1
      return Number.isFinite(value) && value > 0 ? [value * multiplier] : []
    })
  })
  const unique = [...new Set(values)]
  return unique.length === 1 ? unique[0] : undefined
}

function voltageFromApplicationIdentity(value: string): number | undefined {
  const normalized = value.trim().toUpperCase()
  const decimal = normalized.match(/(?:^|_)(\d+)[._](\d+)(?:_?V)(?:_|$)/)
  if (decimal) return Number(`${decimal[1]}.${decimal[2]}`)
  const embedded = normalized.match(/(?:^|_)(\d+)V(\d+)(?:_|$)/)
  if (embedded) return Number(`${embedded[1]}.${embedded[2]}`)
  const integer = normalized.match(/(?:^|_)(\d+)(?:_?V)(?:_|$)/)
  return integer ? Number(integer[1]) : undefined
}

function applicationVoltageForEndpoint(input: {
  endpoint: string
  application_fixture: ApplicationFixtureContract
}): number | undefined {
  const groups = input.application_fixture.node_groups.filter(({ dut_endpoints }) =>
    dut_endpoints.includes(input.endpoint as `dut.${string}`),
  )
  if (groups.length !== 1) return undefined
  const group = groups[0]!
  const values = [group.source_net, ...group.external_terminals].flatMap((identity) => {
    const value = voltageFromApplicationIdentity(identity)
    return value === undefined ? [] : [value]
  })
  const unique = [...new Set(values)]
  return unique.length === 1 ? unique[0] : undefined
}

function assertVisiblePulseTiming(input: {
  graph: ObservedReferenceGraph & {
    electrical_binding: ModelReferenceElectricalBinding
    channels: NonNullable<ObservedReferenceGraph["channels"]>
  }
  source_hints: TimeGraphDiscovery["hints"]
}): void {
  const { graph } = input
  if (graph.electrical_binding.stimulus.type !== "voltage_step") {
    throw new Error(
      `Eligible graph ${graph.graph_id} visibly plots a voltage stimulus and requires voltage_step`,
    )
  }
  const stimulus_channels = graph.channels.filter(({ role }) => role === "stimulus")
  if (stimulus_channels.length !== 1 || stimulus_channels[0]!.measurement.type !== "voltage") {
    throw new Error(
      `Eligible graph ${graph.graph_id} must retain exactly one visible voltage stimulus channel when no printed fixture receipt exists`,
    )
  }
  const stimulus_curve = stimulus_channels[0]!.digitized_curve
  const levels = visibleCurveLevels(stimulus_curve.points)
  const pulse = graph.electrical_binding.stimulus.pulse
  const level_span = levels.high - levels.low
  if (
    !valuesApproximatelyEqual(pulse.low, levels.low, level_span) ||
    !valuesApproximatelyEqual(pulse.high, levels.high, level_span)
  ) {
    throw new Error(
      `Eligible graph ${graph.graph_id} PULSE low/high must match the two pixel-traced stimulus levels (${levels.low} V, ${levels.high} V)`,
    )
  }
  const transitions = visibleTransitions(stimulus_curve.points)
  const rising = transitions.filter(({ direction }) => direction === "rising").map(({ time }) => time)
  const falling = transitions.filter(({ direction }) => direction === "falling").map(({ time }) => time)
  if (rising.length === 0 || falling.length === 0) {
    throw new Error(
      `Eligible graph ${graph.graph_id} visible stimulus must retain both rising and falling edges`,
    )
  }
  const periods = rising.slice(1).map((time, index) => time - rising[index]!)
  const visible_period = periods.length > 0 ? median(periods) : undefined
  const source_frequency = sourceFrequencyHertz(input.source_hints)
  const source_period = source_frequency === undefined ? undefined : 1 / source_frequency
  const expected_period = source_period ?? visible_period
  if (
    expected_period !== undefined &&
    !valuesApproximatelyEqual(pulse.period, expected_period, expected_period)
  ) {
    throw new Error(
      `Eligible graph ${graph.graph_id} PULSE period ${pulse.period} s must match the repeated visible/source period ${expected_period} s`,
    )
  }
  if (visible_period !== undefined && source_period !== undefined) {
    if (!valuesApproximatelyEqual(visible_period, source_period, source_period)) {
      throw new Error(
        `Eligible graph ${graph.graph_id} pixel-traced stimulus period ${visible_period} s does not match printed frequency ${source_frequency} Hz`,
      )
    }
  }
  const first_rising = rising[0]!
  const first_falling_after_rise = falling.find((time) => time > first_rising)
  const timing_scale = expected_period ?? stimulus_curve.x_range.max - stimulus_curve.x_range.min
  if (!valuesApproximatelyEqual(pulse.delay, first_rising, timing_scale)) {
    throw new Error(
      `Eligible graph ${graph.graph_id} PULSE delay ${pulse.delay} s must match the first pixel-traced rising edge ${first_rising} s`,
    )
  }
  if (
    first_falling_after_rise !== undefined &&
    !valuesApproximatelyEqual(pulse.width, first_falling_after_rise - first_rising, timing_scale)
  ) {
    throw new Error(
      `Eligible graph ${graph.graph_id} PULSE width ${pulse.width} s must match the visible high interval ${first_falling_after_rise - first_rising} s`,
    )
  }
  if (pulse.rise + pulse.fall > timing_scale * 0.25) {
    throw new Error(`Eligible graph ${graph.graph_id} PULSE rise/fall consume too much of one visible cycle`)
  }
}

/**
 * Validates a complete experiment derived from a calibrated multi-channel
 * scope capture when prose does not restate the already-visible PULSE.
 */
export function assertBindingMatchesVisibleScopeGraph(input: {
  graph: ObservedReferenceGraph & {
    electrical_binding: ModelReferenceElectricalBinding
    channels: NonNullable<ObservedReferenceGraph["channels"]>
  }
  source_hints: TimeGraphDiscovery["hints"]
  model_interface: ModelInterface
  application_fixture: ApplicationFixtureContract
}): void {
  const { graph, model_interface, application_fixture } = input
  const path = `Eligible graph ${graph.graph_id}`
  if (application_fixture.availability !== "documented") {
    throw new Error(`${path} requires documented application evidence for its source-derived fixture`)
  }
  assertVisiblePulseTiming({ graph, source_hints: input.source_hints })
  const response_channel = graph.channels.find(
    ({ role, measurement }) =>
      role === "response" &&
      measurement.type === "voltage" &&
      measurement.positive === graph.electrical_binding.response.positive &&
      measurement.negative === graph.electrical_binding.response.negative,
  )
  if (!response_channel) throw new Error(`${path} is missing its visible response voltage channel`)
  const response_levels = visibleCurveLevels(response_channel.digitized_curve.points)
  const response_nominal = graph.electrical_binding.response.nominal_volts
  if (
    response_nominal === undefined ||
    !valuesApproximatelyEqual(
      response_nominal,
      response_levels.high,
      response_levels.high - response_levels.low,
    )
  ) {
    throw new Error(`${path} response nominal must match the pixel-traced high response level`)
  }
  const stimulus = graph.electrical_binding.stimulus
  if (stimulus.type !== "voltage_step") throw new Error(`${path} requires a visible voltage step`)
  for (const endpoint of [stimulus.positive, graph.electrical_binding.response.positive]) {
    const groups = application_fixture.node_groups.filter(({ dut_endpoints }) =>
      dut_endpoints.includes(endpoint as `dut.${string}`),
    )
    if (groups.length !== 1 || groups[0]!.external_terminals.length === 0) {
      throw new Error(`${path} endpoint ${endpoint} must map to one documented external application signal`)
    }
  }
  const stimulus_index = stimulus.positive.match(/(\d+)$/)?.[1]
  const response_index = graph.electrical_binding.response.positive.match(/(\d+)$/)?.[1]
  if (stimulus_index && response_index && stimulus_index !== response_index) {
    throw new Error(`${path} must bind the same indexed application signal on both sides of the DUT`)
  }
  const auxiliary = graph.electrical_binding.auxiliary_fixtures ?? []
  for (const pin of model_interface.pins.filter(({ role }) => role === "power_input")) {
    const endpoint = `dut.${pin.spice_node}` as const
    const documented_voltage = applicationVoltageForEndpoint({ endpoint, application_fixture })
    const sources = auxiliary.filter(
      (fixture) =>
        fixture.type === "dc_voltage" && fixture.positive === endpoint && fixture.negative === "gnd",
    )
    if (
      documented_voltage === undefined ||
      sources.length !== 1 ||
      sources[0]!.type !== "dc_voltage" ||
      sources[0]!.dc_volts !== documented_voltage
    ) {
      throw new Error(`${path} must bind exact documented DC voltage for public supply ${endpoint}`)
    }
  }
  for (const pin of model_interface.pins.filter(({ role }) => role === "input")) {
    const endpoint = `dut.${pin.spice_node}` as const
    const conditions = auxiliary.filter(
      (fixture) => fixture.type === "logic_state" && fixture.endpoint === endpoint,
    )
    if (conditions.length !== 1 || conditions[0]!.type !== "logic_state") {
      throw new Error(`${path} must bind one exact logic state for public control ${endpoint}`)
    }
    const condition = conditions[0]!
    if (
      condition.state === "high" &&
      !auxiliary.some(
        (fixture) =>
          fixture.type === "dc_voltage" &&
          fixture.positive === condition.reference &&
          fixture.negative === "gnd",
      )
    ) {
      throw new Error(`${path} high control ${endpoint} must reference one documented DC supply`)
    }
  }
}

function uniquePrintedSignalEndpoint(input: {
  model_interface: ModelInterface
  signal: string
  path: string
}): `dut.${string}` {
  const matches = matchingPublicPins(input.model_interface, input.signal)
  if (matches.length !== 1) {
    throw new FixtureEndpointResolutionError(
      "printed_signal_not_unique",
      `${input.path} printed signal ${input.signal} resolves to ${matches.length} public model pins; exactly one is required`,
    )
  }
  return `dut.${matches[0]!.spice_node}`
}

export function assertBindingMatchesPrintedFixture(input: {
  graph: ObservedReferenceGraph & {
    electrical_binding: ModelReferenceElectricalBinding
    channels: NonNullable<ObservedReferenceGraph["channels"]>
  }
  evidence: TimeGraphTransientFixtureEvidence
  model_interface: ModelInterface
}): void {
  const { graph, evidence, model_interface } = input
  const path = `Eligible graph ${graph.graph_id}`
  const { response_positive, stimulus_positive, auxiliary_fixtures } = resolvePrintedFixtureEndpoints({
    evidence,
    model_interface,
    path,
  })
  const binding = graph.electrical_binding
  const expected_printed_binding = {
    response: {
      type: "voltage" as const,
      positive: response_positive,
      negative: "gnd" as const,
      nominal_volts: evidence.response.nominal_volts,
    },
    stimulus:
      evidence.stimulus.type === "steady_state"
        ? { type: "steady_state" as const }
        : {
            type: evidence.stimulus.type,
            positive: stimulus_positive,
            negative: "gnd" as const,
            pulse: {
              low: evidence.stimulus.low,
              high: evidence.stimulus.high,
              rise: evidence.stimulus.rise,
              fall: evidence.stimulus.fall,
            },
          },
    auxiliary_fixtures,
  }
  const received_printed_binding = {
    response: binding.response,
    stimulus:
      binding.stimulus.type === "steady_state"
        ? { type: binding.stimulus.type }
        : {
            type: binding.stimulus.type,
            positive: binding.stimulus.positive,
            negative: binding.stimulus.negative,
            pulse: {
              low: binding.stimulus.pulse.low,
              high: binding.stimulus.pulse.high,
              rise: binding.stimulus.pulse.rise,
              fall: binding.stimulus.pulse.fall,
            },
          },
    auxiliary_fixtures: binding.auxiliary_fixtures ?? [],
  }
  const common_mismatch =
    binding.response.positive !== response_positive ||
    binding.response.negative !== "gnd" ||
    binding.response.nominal_volts !== evidence.response.nominal_volts ||
    JSON.stringify(binding.auxiliary_fixtures ?? []) !== JSON.stringify(auxiliary_fixtures)
  const stimulus_mismatch =
    evidence.stimulus.type === "steady_state"
      ? binding.stimulus.type !== "steady_state"
      : binding.stimulus.type === "steady_state" ||
        binding.stimulus.type !== evidence.stimulus.type ||
        binding.stimulus.positive !== stimulus_positive ||
        binding.stimulus.negative !== "gnd" ||
        binding.stimulus.pulse.low !== evidence.stimulus.low ||
        binding.stimulus.pulse.high !== evidence.stimulus.high ||
        binding.stimulus.pulse.rise !== evidence.stimulus.rise ||
        binding.stimulus.pulse.fall !== evidence.stimulus.fall
  if (common_mismatch || stimulus_mismatch) {
    throw new Error(
      `${path} electrical_binding must exactly match the server-extracted printed response nominal, stimulus, and every auxiliary fixture. Expected printed binding ${JSON.stringify(expected_printed_binding)}; received ${JSON.stringify(received_printed_binding)}`,
    )
  }
  if (binding.stimulus.type === "steady_state") return
  const response_curve = graph.channels.find(
    ({ measurement }) =>
      measurement.type === "voltage" &&
      measurement.positive === binding.response.positive &&
      measurement.negative === binding.response.negative,
  )?.digitized_curve
  if (!response_curve) throw new Error(`${path} is missing its printed response channel`)
  const { min, max } = response_curve.x_range
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

export function assertCurrentChannelsUseResolvedFixtures(input: {
  graph: ObservedReferenceGraph & { channels: NonNullable<ObservedReferenceGraph["channels"]> }
  fixture_ids: ReadonlySet<string>
  stimulus_available: boolean
}): void {
  for (const channel of input.graph.channels) {
    if (channel.measurement.type !== "current") continue
    if (channel.measurement.element_id === "stimulus") {
      if (!input.stimulus_available) {
        throw new Error(
          `Eligible graph ${input.graph.graph_id} channel ${channel.channel_id} cannot measure a steady-state stimulus`,
        )
      }
      continue
    }
    if (!input.fixture_ids.has(channel.measurement.element_id)) {
      throw new Error(
        `Eligible graph ${input.graph.graph_id} channel ${channel.channel_id} names unknown current fixture ${channel.measurement.element_id}; use stimulus or one exact resolved application passive id`,
      )
    }
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
  const signal_kind = input.signal === "input" ? "input_voltage" : "output_voltage"
  const identities = [
    node_group.source_net,
    ...node_group.external_terminals,
    ...node_group.source_endpoints.flatMap((endpoint) => {
      const separator = endpoint.indexOf(".")
      return separator < 0 ? [endpoint] : [endpoint, endpoint.slice(separator + 1)]
    }),
  ]
  return identities.some((identity) => electricalSignalMatches(identity, signal_kind))
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
