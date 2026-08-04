import type { AnyCircuitElement } from "circuit-json"
import type { FixtureElement, ValidationExecutionError } from "../../spice-validation/types"
import { asRecord, simulatorError } from "./errors"
import {
  expectedNativeFixtureIdentity,
  expectedPulseFixtureSource,
  fixtureComponentPorts,
  fixturePort,
  fixtureTerminals,
  namedFixtureComponents,
  nativeFixturePort,
  normalizedSpiceSource,
  type PulsedSourceFixture,
  traceExactlyConnectsFixturePort,
} from "./fixture-shared"
import type { CircuitRecord } from "./types"
import { resolvePlannedEndpoint } from "./waveform-probes"

export function validateFixtureEndpoints(input: {
  fixture: FixtureElement
  circuit_json: readonly AnyCircuitElement[]
  component_id: string
  model?: CircuitRecord
}): ValidationExecutionError[] {
  const path = `fixtures.${input.fixture.id}`
  const pulsed =
    (input.fixture.type === "voltage_source" || input.fixture.type === "current_source") &&
    input.fixture.pulse !== undefined
  const errors: ValidationExecutionError[] = []
  for (const terminal of fixtureTerminals(input.fixture)) {
    const port = pulsed
      ? input.model &&
        fixturePort({
          circuit_json: input.circuit_json,
          component_id: input.component_id,
          model: input.model,
          spice_node: terminal.spice_node,
        })
      : nativeFixturePort({
          circuit_json: input.circuit_json,
          component_id: input.component_id,
          port_name: terminal.native_port,
        })
    const port_id = port?.source_port_id
    const resolved = resolvePlannedEndpoint({
      circuit_json: input.circuit_json,
      endpoint: terminal.endpoint,
      subject: `fixture ${input.fixture.id}`,
      path: `${path}.${terminal.side}`,
    })
    if (
      typeof port_id !== "string" ||
      resolved.error ||
      !traceExactlyConnectsFixturePort({
        circuit_json: input.circuit_json,
        fixture_port_id: port_id,
        endpoint: resolved.endpoint,
      })
    ) {
      errors.push(
        simulatorError(
          pulsed ? "viewer_stimulus_endpoint_mismatch" : "viewer_fixture_endpoint_mismatch",
          `Fixture ${input.fixture.id} is not connected from ${terminal.native_port} to planned ${terminal.side} endpoint ${terminal.endpoint}`,
          `${path}.${terminal.side}`,
        ),
      )
    }
  }
  return errors
}

function validatePulseFixture(input: {
  fixture: PulsedSourceFixture
  circuit_json: readonly AnyCircuitElement[]
  component: CircuitRecord
}): ValidationExecutionError[] {
  const path = `fixtures.${input.fixture.id}`
  const component_id = input.component.source_component_id
  if (typeof component_id !== "string" || input.component.ftype !== "simple_chip") {
    return [
      simulatorError(
        "viewer_stimulus_model_mismatch",
        `Pulsed fixture ${input.fixture.id} is not the exact tscircuit helper component emitted by the validation projection`,
        path,
      ),
    ]
  }
  const models = input.circuit_json.flatMap((element) => {
    const record = asRecord(element)
    return record.type === "simulation_spice_subcircuit" && record.source_component_id === component_id
      ? [record]
      : []
  })
  const model = models[0]
  const source = model?.subcircuit_source
  const mapping = model?.spice_pin_to_source_port_map
  const component_ports = fixtureComponentPorts({ circuit_json: input.circuit_json, component_id })
  if (
    models.length !== 1 ||
    typeof source !== "string" ||
    normalizedSpiceSource(source) !== expectedPulseFixtureSource(input.fixture) ||
    !mapping ||
    typeof mapping !== "object" ||
    Array.isArray(mapping) ||
    JSON.stringify(Object.keys(mapping).sort()) !== JSON.stringify(["NEG", "POS"]) ||
    component_ports.length !== 2 ||
    new Set(Object.values(mapping)).size !== 2 ||
    Object.values(mapping).some(
      (port_id) =>
        typeof port_id !== "string" || !component_ports.some((port) => port.source_port_id === port_id),
    )
  ) {
    return [
      simulatorError(
        "viewer_stimulus_model_mismatch",
        `Pulsed fixture ${input.fixture.id} does not embed the exact planned source kind, DC level, PULSE levels, or edge timing`,
        path,
      ),
    ]
  }
  return validateFixtureEndpoints({
    fixture: input.fixture,
    circuit_json: input.circuit_json,
    component_id,
    model,
  })
}

function validateNativeFixture(input: {
  fixture: FixtureElement
  circuit_json: readonly AnyCircuitElement[]
  component: CircuitRecord
}): ValidationExecutionError[] {
  const path = `fixtures.${input.fixture.id}`
  const component_id = input.component.source_component_id
  const expected = expectedNativeFixtureIdentity(input.fixture)
  const component_ports =
    typeof component_id === "string"
      ? fixtureComponentPorts({ circuit_json: input.circuit_json, component_id })
      : []
  const fixture_models =
    typeof component_id === "string"
      ? input.circuit_json.filter(
          (element) =>
            element.type === "simulation_spice_subcircuit" &&
            asRecord(element).source_component_id === component_id,
        )
      : []
  if (
    typeof component_id !== "string" ||
    input.component.ftype !== expected.ftype ||
    (expected.field !== undefined && input.component[expected.field] !== expected.value) ||
    component_ports.length !== 2 ||
    fixture_models.length !== 0
  ) {
    return [
      simulatorError(
        "viewer_fixture_model_mismatch",
        `Fixture ${input.fixture.id} does not have the exact planned ${input.fixture.type} identity or value in Circuit JSON`,
        path,
      ),
    ]
  }
  return validateFixtureEndpoints({
    fixture: input.fixture,
    circuit_json: input.circuit_json,
    component_id,
  })
}

export function validateFixture(input: {
  fixture: FixtureElement
  circuit_json: readonly AnyCircuitElement[]
}): ValidationExecutionError[] {
  const path = `fixtures.${input.fixture.id}`
  const components = namedFixtureComponents(input)
  if (components.length !== 1 || typeof components[0]?.source_component_id !== "string") {
    const pulsed =
      (input.fixture.type === "voltage_source" || input.fixture.type === "current_source") &&
      input.fixture.pulse !== undefined
    return [
      simulatorError(
        pulsed ? "viewer_stimulus_source_count" : "viewer_fixture_source_count",
        `Fixture ${input.fixture.id} resolved to ${components.length} named tscircuit source components; exactly one is required`,
        path,
      ),
    ]
  }
  if (
    (input.fixture.type === "voltage_source" || input.fixture.type === "current_source") &&
    input.fixture.pulse !== undefined
  ) {
    return validatePulseFixture({
      fixture: input.fixture as PulsedSourceFixture,
      circuit_json: input.circuit_json,
      component: components[0]!,
    })
  }
  return validateNativeFixture({
    fixture: input.fixture,
    circuit_json: input.circuit_json,
    component: components[0]!,
  })
}
