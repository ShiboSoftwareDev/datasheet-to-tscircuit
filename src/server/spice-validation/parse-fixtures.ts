import { IDENTIFIER_PATTERN, parseEndpointSyntax } from "./identifiers"
import type { UnknownRecord, ValidationCollector } from "./parse-helpers"
import type { FixtureElement, PulseSpecification, SpiceEndpoint } from "./types"

export function parseEndpoint(value: unknown, path: string, collector: ValidationCollector): SpiceEndpoint {
  const endpoint = collector.string(value, path)
  if (endpoint && !parseEndpointSyntax(endpoint)) {
    collector.add(path, "invalid_endpoint", 'must be "gnd", "dut.<spice_node>", or "net.<identifier>"')
  }
  return (endpoint || "gnd") as SpiceEndpoint
}

function parseElementId(record: UnknownRecord, path: string, collector: ValidationCollector): string {
  const id = collector.string(record.id, `${path}.id`)
  if (id && !IDENTIFIER_PATTERN.test(id)) {
    collector.add(
      `${path}.id`,
      "invalid_identifier",
      "must start with a letter and contain only letters, digits, and underscores",
    )
  }
  return id
}

function parsePulse(
  value: unknown,
  path: string,
  collector: ValidationCollector,
): PulseSpecification | undefined {
  if (value === undefined) return undefined
  const pulse = collector.record(value, path)
  collector.rejectUnknownKeys(pulse, ["low", "high", "delay", "rise", "fall", "width", "period"], path)
  const result: PulseSpecification = {
    low: collector.finite(pulse.low, `${path}.low`),
    high: collector.finite(pulse.high, `${path}.high`),
    delay: collector.nonNegative(pulse.delay, `${path}.delay`),
    rise: collector.nonNegative(pulse.rise, `${path}.rise`),
    fall: collector.nonNegative(pulse.fall, `${path}.fall`),
    width: collector.positive(pulse.width, `${path}.width`),
    period: collector.positive(pulse.period, `${path}.period`),
  }
  if (
    Number.isFinite(result.period) &&
    Number.isFinite(result.width) &&
    Number.isFinite(result.rise) &&
    Number.isFinite(result.fall) &&
    result.width + result.rise + result.fall > result.period
  ) {
    collector.add(path, "invalid_pulse_timing", "width + rise + fall must not exceed period")
  }
  return result
}

export function parseFixtureElement(
  value: unknown,
  path: string,
  collector: ValidationCollector,
): FixtureElement {
  const record = collector.record(value, path)
  const type = collector.string(record.type, `${path}.type`)
  const id = parseElementId(record, path, collector)

  if (type === "diode") {
    collector.rejectUnknownKeys(record, ["type", "id", "anode", "cathode"], path)
    return {
      type,
      id,
      anode: parseEndpoint(record.anode, `${path}.anode`, collector),
      cathode: parseEndpoint(record.cathode, `${path}.cathode`, collector),
    }
  }

  const positive = parseEndpoint(record.positive, `${path}.positive`, collector)
  const negative = parseEndpoint(record.negative, `${path}.negative`, collector)
  switch (type) {
    case "resistor":
      collector.rejectUnknownKeys(record, ["type", "id", "positive", "negative", "resistance_ohms"], path)
      return {
        type,
        id,
        positive,
        negative,
        resistance_ohms: collector.positive(record.resistance_ohms, `${path}.resistance_ohms`),
      }
    case "capacitor":
      collector.rejectUnknownKeys(record, ["type", "id", "positive", "negative", "capacitance_farads"], path)
      return {
        type,
        id,
        positive,
        negative,
        capacitance_farads: collector.positive(record.capacitance_farads, `${path}.capacitance_farads`),
      }
    case "inductor":
      collector.rejectUnknownKeys(record, ["type", "id", "positive", "negative", "inductance_henries"], path)
      return {
        type,
        id,
        positive,
        negative,
        inductance_henries: collector.positive(record.inductance_henries, `${path}.inductance_henries`),
      }
    case "voltage_source":
      collector.rejectUnknownKeys(record, ["type", "id", "positive", "negative", "dc_volts", "pulse"], path)
      return {
        type,
        id,
        positive,
        negative,
        dc_volts: collector.finite(record.dc_volts, `${path}.dc_volts`),
        pulse: parsePulse(record.pulse, `${path}.pulse`, collector),
      }
    case "current_source":
      collector.rejectUnknownKeys(record, ["type", "id", "positive", "negative", "dc_amps", "pulse"], path)
      return {
        type,
        id,
        positive,
        negative,
        dc_amps: collector.finite(record.dc_amps, `${path}.dc_amps`),
        pulse: parsePulse(record.pulse, `${path}.pulse`, collector),
      }
    default:
      collector.add(
        `${path}.type`,
        "unsupported_fixture",
        "must be resistor, capacitor, inductor, voltage_source, current_source, or diode",
      )
      return {
        type: "resistor",
        id,
        positive,
        negative,
        resistance_ohms: 1,
      }
  }
}
