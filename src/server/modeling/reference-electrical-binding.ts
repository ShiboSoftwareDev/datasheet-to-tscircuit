import type {
  ModelInterface,
  ModelPublicElectricalEndpoint,
  ModelReferenceAuxiliaryFixture,
  ModelReferenceElectricalBinding,
  ModelReferencePulse,
} from "./types"

type UnknownRecord = Record<string, unknown>

function record(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as UnknownRecord
}

function exactKeys(value: UnknownRecord, keys: readonly string[], path: string): void {
  const allowed = new Set(keys)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    throw new Error(`${path} contains unsupported fields: ${unknown.join(", ")}`)
  }
}

function endpoint(value: unknown, path: string): ModelPublicElectricalEndpoint {
  if (value === "gnd") return value
  if (typeof value === "string" && /^dut\.[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    return value as `dut.${string}`
  }
  throw new Error(`${path} must be gnd or dut.<spice_node>`)
}

function assertDistinctEndpoints(
  positive: ModelPublicElectricalEndpoint,
  negative: ModelPublicElectricalEndpoint,
  path: string,
): void {
  if (positive === negative) throw new Error(`${path} endpoints must be distinct`)
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`)
  }
  return Object.is(value, -0) ? 0 : value
}

function optionalSha256(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${path} must be a lowercase SHA-256 digest`)
  }
  return value
}

function parsePulse(value: unknown, path: string): ModelReferencePulse {
  const pulse = record(value, path)
  exactKeys(pulse, ["low", "high", "delay", "rise", "fall", "width", "period"], path)
  const result = {
    low: finite(pulse.low, `${path}.low`),
    high: finite(pulse.high, `${path}.high`),
    delay: finite(pulse.delay, `${path}.delay`),
    rise: finite(pulse.rise, `${path}.rise`),
    fall: finite(pulse.fall, `${path}.fall`),
    width: finite(pulse.width, `${path}.width`),
    period: finite(pulse.period, `${path}.period`),
  }
  if (result.low === result.high) throw new Error(`${path}.low and ${path}.high must differ`)
  if (result.delay < 0 || result.rise < 0 || result.fall < 0) {
    throw new Error(`${path}.delay, rise, and fall must be non-negative`)
  }
  if (!(result.width > 0) || !(result.period > 0)) {
    throw new Error(`${path}.width and period must be positive`)
  }
  if (result.width + result.rise + result.fall > result.period) {
    throw new Error(`${path}.width + rise + fall must not exceed period`)
  }
  return result
}

function parseAuxiliaryFixture(value: unknown, path: string): ModelReferenceAuxiliaryFixture {
  const fixture = record(value, path)
  if (fixture.type === "dc_voltage") {
    exactKeys(fixture, ["type", "positive", "negative", "dc_volts"], path)
    const positive = endpoint(fixture.positive, `${path}.positive`)
    const negative = endpoint(fixture.negative, `${path}.negative`)
    assertDistinctEndpoints(positive, negative, path)
    return { type: "dc_voltage", positive, negative, dc_volts: finite(fixture.dc_volts, `${path}.dc_volts`) }
  }
  if (fixture.type === "dc_current") {
    exactKeys(fixture, ["type", "positive", "negative", "dc_amps"], path)
    const positive = endpoint(fixture.positive, `${path}.positive`)
    const negative = endpoint(fixture.negative, `${path}.negative`)
    assertDistinctEndpoints(positive, negative, path)
    return { type: "dc_current", positive, negative, dc_amps: finite(fixture.dc_amps, `${path}.dc_amps`) }
  }
  if (fixture.type === "logic_state") {
    exactKeys(fixture, ["type", "endpoint", "reference", "state"], path)
    if (fixture.state !== "low" && fixture.state !== "high") {
      throw new Error(`${path}.state must be low or high`)
    }
    const logic_endpoint = endpoint(fixture.endpoint, `${path}.endpoint`)
    const reference = endpoint(fixture.reference, `${path}.reference`)
    assertDistinctEndpoints(logic_endpoint, reference, path)
    if (fixture.state === "low" && reference !== "gnd") {
      throw new Error(`${path}.reference must be gnd for a low logic state`)
    }
    if (fixture.state === "high" && reference === "gnd") {
      throw new Error(`${path}.reference must be a public input-supply endpoint for a high logic state`)
    }
    return { type: "logic_state", endpoint: logic_endpoint, reference, state: fixture.state }
  }
  throw new Error(`${path}.type must be dc_voltage, dc_current, or logic_state`)
}

export function parseModelReferenceElectricalBinding(
  value: unknown,
  path = "electrical_binding",
): ModelReferenceElectricalBinding {
  const binding = record(value, path)
  exactKeys(
    binding,
    [
      "application_fixture_sha256",
      "application_topology_sha256",
      "response",
      "stimulus",
      "auxiliary_fixtures",
    ],
    path,
  )
  const application_fixture_sha256 = optionalSha256(
    binding.application_fixture_sha256,
    `${path}.application_fixture_sha256`,
  )
  const application_topology_sha256 = optionalSha256(
    binding.application_topology_sha256,
    `${path}.application_topology_sha256`,
  )
  if ((application_fixture_sha256 === undefined) !== (application_topology_sha256 === undefined)) {
    throw new Error(
      `${path}.application_fixture_sha256 and application_topology_sha256 must be provided together`,
    )
  }

  const response = record(binding.response, `${path}.response`)
  exactKeys(response, ["type", "positive", "negative", "nominal_volts"], `${path}.response`)
  if (response.type !== "voltage") throw new Error(`${path}.response.type must be voltage`)
  const response_positive = endpoint(response.positive, `${path}.response.positive`)
  const response_negative = endpoint(response.negative, `${path}.response.negative`)
  assertDistinctEndpoints(response_positive, response_negative, `${path}.response`)
  const nominal_volts =
    response.nominal_volts === undefined
      ? undefined
      : finite(response.nominal_volts, `${path}.response.nominal_volts`)

  const stimulus = record(binding.stimulus, `${path}.stimulus`)
  exactKeys(stimulus, ["type", "positive", "negative", "pulse"], `${path}.stimulus`)
  if (stimulus.type !== "voltage_step" && stimulus.type !== "current_step") {
    throw new Error(`${path}.stimulus.type must be voltage_step or current_step`)
  }
  const stimulus_positive = endpoint(stimulus.positive, `${path}.stimulus.positive`)
  const stimulus_negative = endpoint(stimulus.negative, `${path}.stimulus.negative`)
  assertDistinctEndpoints(stimulus_positive, stimulus_negative, `${path}.stimulus`)

  const auxiliary_fixtures =
    binding.auxiliary_fixtures === undefined
      ? []
      : (() => {
          if (!Array.isArray(binding.auxiliary_fixtures)) {
            throw new Error(`${path}.auxiliary_fixtures must be an array`)
          }
          return binding.auxiliary_fixtures.map((fixture, index) =>
            parseAuxiliaryFixture(fixture, `${path}.auxiliary_fixtures[${index}]`),
          )
        })()
  const semantic_keys = auxiliary_fixtures.map((fixture) =>
    fixture.type === "logic_state"
      ? `${fixture.type}:${fixture.endpoint}`
      : `${fixture.type}:${fixture.positive}:${fixture.negative}`,
  )
  if (new Set(semantic_keys).size !== semantic_keys.length) {
    throw new Error(`${path}.auxiliary_fixtures must not contain duplicate electrical conditions`)
  }
  for (const [index, fixture] of auxiliary_fixtures.entries()) {
    const endpoints =
      fixture.type === "logic_state"
        ? [fixture.endpoint, fixture.reference]
        : [fixture.positive, fixture.negative]
    if (
      fixture.type !== "dc_current" &&
      endpoints.includes(response_positive) &&
      endpoints.includes(response_negative)
    ) {
      throw new Error(`${path}.auxiliary_fixtures[${index}] must not clamp the observed response endpoints`)
    }
  }

  return {
    ...(application_fixture_sha256
      ? { application_fixture_sha256, application_topology_sha256: application_topology_sha256! }
      : {}),
    response: {
      type: "voltage",
      positive: response_positive,
      negative: response_negative,
      ...(nominal_volts === undefined ? {} : { nominal_volts }),
    },
    stimulus: {
      type: stimulus.type,
      positive: stimulus_positive,
      negative: stimulus_negative,
      pulse: parsePulse(stimulus.pulse, `${path}.stimulus.pulse`),
    },
    ...(auxiliary_fixtures.length === 0 ? {} : { auxiliary_fixtures }),
  }
}

export function assertModelReferenceElectricalBindingInterface(input: {
  binding: ModelReferenceElectricalBinding
  model_interface: ModelInterface
  path?: string
}): void {
  const path = input.path ?? "electrical_binding"
  const public_endpoints = new Set(
    input.model_interface.pins.map(({ spice_node }) => `dut.${spice_node}` as const),
  )
  const endpoints: Array<[string, ModelPublicElectricalEndpoint]> = [
    ["response.positive", input.binding.response.positive],
    ["response.negative", input.binding.response.negative],
    ["stimulus.positive", input.binding.stimulus.positive],
    ["stimulus.negative", input.binding.stimulus.negative],
  ]
  endpoints.push(
    ...(input.binding.auxiliary_fixtures ?? []).flatMap(
      (fixture, index): Array<[string, ModelPublicElectricalEndpoint]> =>
        fixture.type === "logic_state"
          ? [
              [`auxiliary_fixtures[${index}].endpoint`, fixture.endpoint],
              [`auxiliary_fixtures[${index}].reference`, fixture.reference],
            ]
          : [
              [`auxiliary_fixtures[${index}].positive`, fixture.positive],
              [`auxiliary_fixtures[${index}].negative`, fixture.negative],
            ],
    ),
  )
  for (const [binding_path, electrical_endpoint] of endpoints) {
    if (electrical_endpoint !== "gnd" && !public_endpoints.has(electrical_endpoint)) {
      throw new Error(`${path}.${binding_path} does not name a public SPICE node in model-interface.json`)
    }
  }
}

export function modelReferenceElectricalBindingsEqual(
  left: ModelReferenceElectricalBinding,
  right: ModelReferenceElectricalBinding,
): boolean {
  return (
    left.application_fixture_sha256 === right.application_fixture_sha256 &&
    left.application_topology_sha256 === right.application_topology_sha256 &&
    left.response.type === right.response.type &&
    left.response.positive === right.response.positive &&
    left.response.negative === right.response.negative &&
    left.response.nominal_volts === right.response.nominal_volts &&
    left.stimulus.type === right.stimulus.type &&
    left.stimulus.positive === right.stimulus.positive &&
    left.stimulus.negative === right.stimulus.negative &&
    left.stimulus.pulse.low === right.stimulus.pulse.low &&
    left.stimulus.pulse.high === right.stimulus.pulse.high &&
    left.stimulus.pulse.delay === right.stimulus.pulse.delay &&
    left.stimulus.pulse.rise === right.stimulus.pulse.rise &&
    left.stimulus.pulse.fall === right.stimulus.pulse.fall &&
    left.stimulus.pulse.width === right.stimulus.pulse.width &&
    left.stimulus.pulse.period === right.stimulus.pulse.period &&
    JSON.stringify(left.auxiliary_fixtures ?? []) === JSON.stringify(right.auxiliary_fixtures ?? [])
  )
}
