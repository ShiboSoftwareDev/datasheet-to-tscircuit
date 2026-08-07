import type { ModelManifest } from "@/shared/job-types"
import type {
  FixtureElement,
  SpiceEndpoint,
  ValidationAnalysis,
  ValidationCase,
} from "../../spice-validation"

function endpointSelector(endpoint: SpiceEndpoint, manifest: ModelManifest): string {
  if (endpoint === "gnd") return "net.GND"
  if (endpoint.startsWith("net.")) return endpoint
  const spice_node = endpoint.slice("dut.".length)
  const mapping = manifest.pins.find((pin) => pin.spice_node === spice_node)
  if (!mapping) throw new Error(`Cannot project unknown DUT node ${spice_node}`)
  return `.DUT > .${mapping.component_pin}`
}

function dutPinLabel(spice_node: string): string {
  // circuit-json-to-spice treats a source port named exactly "GND" as node 0.
  // Validation topology is explicit, so keep that reserved transport name out
  // of the display label and bind the SPICE node through spicePinMapping below.
  return spice_node.toLowerCase() === "gnd" ? `DUT_${spice_node}` : spice_node
}

function fixtureTerminals(fixture: FixtureElement): [SpiceEndpoint, SpiceEndpoint] {
  return fixture.type === "diode" ? [fixture.anode, fixture.cathode] : [fixture.positive, fixture.negative]
}

function pulseSourceModel(fixture: Extract<FixtureElement, { type: "voltage_source" | "current_source" }>): {
  source: string
  pin_labels: Record<string, string>
  pin_mapping: Record<string, string>
} {
  const pulse = fixture.pulse
  if (!pulse) throw new Error(`Pulse helper requested for DC fixture ${fixture.id}`)
  const subcircuit_name = `VALIDATION_${fixture.id.toUpperCase()}`
  const source_name = fixture.type === "voltage_source" ? "VDRIVE" : "IDRIVE"
  const dc_value = fixture.type === "voltage_source" ? fixture.dc_volts : fixture.dc_amps
  const pulse_values = [pulse.low, pulse.high, pulse.delay, pulse.rise, pulse.fall, pulse.width, pulse.period]
  return {
    source: `.SUBCKT ${subcircuit_name} POS NEG\n${source_name} POS NEG DC ${dc_value} PULSE(${pulse_values.join(" ")})\n.ENDS ${subcircuit_name}\n`,
    pin_labels: { pin1: "POS", pin2: "NEG" },
    pin_mapping: { POS: "pin1", NEG: "pin2" },
  }
}

function fixtureElementSource(fixture: FixtureElement): string {
  const name = JSON.stringify(fixture.id)
  switch (fixture.type) {
    case "resistor":
      return `<resistor name=${name} resistance=${JSON.stringify(`${fixture.resistance_ohms}ohm`)} />`
    case "capacitor":
      return `<capacitor name=${name} capacitance=${JSON.stringify(`${fixture.capacitance_farads}F`)} />`
    case "inductor":
      return `<inductor name=${name} inductance=${JSON.stringify(`${fixture.inductance_henries}H`)} />`
    case "voltage_source": {
      if (fixture.pulse) {
        const model = pulseSourceModel(fixture)
        return `<chip name=${name} pinLabels={${JSON.stringify(model.pin_labels)}} spiceModel={(<spicemodel source={${JSON.stringify(model.source)}} spicePinMapping={${JSON.stringify(model.pin_mapping)}} />)} />`
      }
      return `<voltagesource name=${name} voltage=${JSON.stringify(`${fixture.dc_volts}V`)} />`
    }
    case "current_source": {
      if (fixture.pulse) {
        const model = pulseSourceModel(fixture)
        return `<chip name=${name} pinLabels={${JSON.stringify(model.pin_labels)}} spiceModel={(<spicemodel source={${JSON.stringify(model.source)}} spicePinMapping={${JSON.stringify(model.pin_mapping)}} />)} />`
      }
      return `<currentsource name=${name} current=${JSON.stringify(`${fixture.dc_amps}A`)} />`
    }
    case "diode":
      return `<diode name=${name} />`
  }
}

/**
 * The installed tscircuit analog element currently exposes transient analysis,
 * voltage probes, and ammeters. OP/DC analyses remain intentionally unsupported.
 * Exact voltage/current PULSE fixtures are represented by harness-local SPICE
 * helpers so the TSX and the server-compiled fixture have the same source law.
 */
export function getAnalogProjectionIssue(validation_case: ValidationCase): string | undefined {
  if (validation_case.analysis.type !== "transient") {
    return `tscircuit analogsimulation does not support ${validation_case.analysis.type} analysis`
  }
  return undefined
}

function analogSimulationSource(analysis: Extract<ValidationAnalysis, { type: "transient" }>): string {
  const start_time = analysis.start === undefined ? "" : ` startTime=${JSON.stringify(`${analysis.start}s`)}`
  return `<analogsimulation name="validation" duration=${JSON.stringify(`${analysis.stop}s`)} timePerStep=${JSON.stringify(`${analysis.step}s`)}${start_time} spiceEngine="ngspice" graphIndependentAxes />`
}

function safeComment(value: string): string {
  return value
    .replace(/\*\//g, "* /")
    .replace(/[\r\n]+/g, " ")
    .trim()
}

/** Generates display TSX from the same plan that the server compiles to SPICE. */
export function renderValidationCaseTsx(input: {
  validation_case: ValidationCase
  manifest: ModelManifest
  model_source: string
  model_card: string
}): string {
  const { validation_case, manifest } = input
  const analog_projection_issue = getAnalogProjectionIssue(validation_case)
  const analog_projection_supported = analog_projection_issue === undefined
  const pin_labels = Object.fromEntries(
    manifest.pins.map(({ component_pin, spice_node }) => [component_pin, dutPinLabel(spice_node)]),
  )
  const spice_pin_mapping = Object.fromEntries(
    manifest.pins.map(({ component_pin, spice_node }) => [spice_node, component_pin]),
  )
  const fixture_elements = validation_case.fixtures.map((fixture) => `      ${fixtureElementSource(fixture)}`)
  const application_group_traces = (validation_case.application_fixture?.node_groups ?? []).flatMap(
    (group) => {
      const group_selector = group.is_ground ? "net.GND" : `net.${group.id}`
      return group.dut_endpoints.map(
        (endpoint) =>
          `      <trace from=${JSON.stringify(endpointSelector(endpoint, manifest))} to=${JSON.stringify(group_selector)} />`,
      )
    },
  )
  const application_overlay_traces = (validation_case.application_fixture?.condition_overlays ?? []).flatMap(
    (overlay) =>
      overlay.type === "logic_state"
        ? [
            `      <trace from=${JSON.stringify(endpointSelector(overlay.endpoint, manifest))} to=${JSON.stringify(endpointSelector(overlay.reference, manifest))} />`,
          ]
        : [],
  )
  const current_observation_by_element = new Map(
    validation_case.observations.flatMap((observation) =>
      observation.type === "current" ? [[observation.element_id, observation] as const] : [],
    ),
  )
  const traces = validation_case.fixtures.flatMap((fixture) => {
    const [positive, negative] = fixtureTerminals(fixture)
    const current_observation = current_observation_by_element.get(fixture.id)
    if (current_observation) {
      const positive_to_negative = current_observation.direction !== "negative_to_positive"
      return [
        `      <ammeter name=${JSON.stringify(`probe_${current_observation.id}`)} graphDisplayName=${JSON.stringify(current_observation.id)} connections={${JSON.stringify(
          positive_to_negative
            ? {
                pos: endpointSelector(positive, manifest),
                neg: `.${fixture.id} > .pin1`,
              }
            : {
                pos: `.${fixture.id} > .pin1`,
                neg: endpointSelector(positive, manifest),
              },
        )}} />`,
        `      <trace from=${JSON.stringify(`.${fixture.id} > .pin2`)} to=${JSON.stringify(endpointSelector(negative, manifest))} />`,
      ]
    }
    return [
      `      <trace from=${JSON.stringify(`.${fixture.id} > .pin1`)} to=${JSON.stringify(endpointSelector(positive, manifest))} />`,
      `      <trace from=${JSON.stringify(`.${fixture.id} > .pin2`)} to=${JSON.stringify(endpointSelector(negative, manifest))} />`,
    ]
  })
  const probes = validation_case.observations.flatMap((observation) =>
    observation.type === "voltage"
      ? [
          `      <voltageprobe name=${JSON.stringify(`probe_${observation.id}`)} graphDisplayName=${JSON.stringify(observation.id)} connectsTo=${JSON.stringify(endpointSelector(observation.positive, manifest))} referenceTo=${JSON.stringify(endpointSelector(observation.negative, manifest))} />`,
        ]
      : [],
  )
  const analog_simulation =
    analog_projection_supported && validation_case.analysis.type === "transient"
      ? [`      ${analogSimulationSource(validation_case.analysis)}`]
      : []
  const card_title =
    input.model_card
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find(Boolean) ?? "Generated SPICE model"
  const requirement_ids = validation_case.requirement_ids.join(", ")
  const observation_ids = validation_case.observations.map(({ id }) => id).join(", ")
  return `/*
 * Deterministic schematic projection of validation case: ${safeComment(validation_case.id)}
 * Requirements: ${safeComment(requirement_ids)}
 * Analysis: ${safeComment(validation_case.analysis.type)}
 * Observations: ${safeComment(observation_ids)}
 * Model revision: ${safeComment(manifest.revision)}
 * Model card: ${safeComment(card_title).slice(0, 160)}
 * Analog preview: ${safeComment(analog_projection_issue ?? "faithful transient projection")}
 * Numeric validation is executed from the server-compiled SPICE netlist.
 */
const modelSource = ${JSON.stringify(input.model_source)}
const validationCaseContract = ${JSON.stringify(validation_case, null, 2)} as const

export default function ValidationCasePreview() {
  void validationCaseContract
  return (
    <board routingDisabled>
      <chip
        name="DUT"
        manufacturerPartNumber=${JSON.stringify(manifest.part_number)}
        pinLabels={${JSON.stringify(pin_labels, null, 2)}}
        spiceModel={(
          <spicemodel
            source={modelSource}
            spicePinMapping={${JSON.stringify(spice_pin_mapping, null, 2)}}
          />
        )}
      />
${[
  ...fixture_elements,
  ...application_group_traces,
  ...application_overlay_traces,
  ...traces,
  ...probes,
  ...analog_simulation,
].join("\n")}
    </board>
  )
}
`
}
