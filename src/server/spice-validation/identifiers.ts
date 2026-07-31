import type { FixtureElement, SpiceEndpoint } from "./types"

export const CASE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/
export const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
export const SPICE_NODE_PATTERN = /^[A-Za-z0-9_]{1,64}$/

export type ParsedEndpoint =
  | { scope: "gnd" }
  | { scope: "dut"; identifier: string }
  | { scope: "net"; identifier: string }

export function parseEndpointSyntax(value: string): ParsedEndpoint | null {
  if (value === "gnd") return { scope: "gnd" }
  const separator_index = value.indexOf(".")
  if (separator_index <= 0 || separator_index === value.length - 1) return null
  if (value.indexOf(".", separator_index + 1) !== -1) return null
  const scope = value.slice(0, separator_index)
  const identifier = value.slice(separator_index + 1)
  if (scope === "dut" && SPICE_NODE_PATTERN.test(identifier)) {
    return { scope, identifier }
  }
  if (scope === "net" && IDENTIFIER_PATTERN.test(identifier)) {
    return { scope, identifier }
  }
  return null
}

export function getFixtureElementName(element: FixtureElement): string {
  const prefix: Record<FixtureElement["type"], string> = {
    resistor: "R",
    capacitor: "C",
    inductor: "L",
    voltage_source: "V",
    current_source: "I",
    diode: "D",
  }
  return `${prefix[element.type]}_${element.id}`
}

export function getFixtureEndpoints(element: FixtureElement): [SpiceEndpoint, SpiceEndpoint] {
  if (element.type === "diode") return [element.anode, element.cathode]
  return [element.positive, element.negative]
}

export function getDutNodeName(pin_index: number): string {
  return `n_dut_${pin_index + 1}`
}

export function getNetNodeName(identifier: string): string {
  return `n_net_${identifier}`
}
