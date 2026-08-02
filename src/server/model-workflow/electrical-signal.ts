export type ElectricalSignalKind = "input_voltage" | "output_voltage" | "load_current"

const ALIASES: Readonly<Record<ElectricalSignalKind, ReadonlySet<string>>> = {
  input_voltage: new Set(["VI", "VIN", "INPUT", "INPUTVOLTAGE"]),
  output_voltage: new Set(["VO", "VOUT", "OUT", "OUTPUT", "OUTPUTVOLTAGE"]),
  load_current: new Set(["IO", "ILOAD", "LOAD", "LOADCURRENT"]),
}

export function normalizeElectricalSignal(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase()
}

export function classifyElectricalSignal(value: string): ElectricalSignalKind | undefined {
  const normalized = normalizeElectricalSignal(value)
  return (Object.keys(ALIASES) as ElectricalSignalKind[]).find((kind) => ALIASES[kind].has(normalized))
}

export function electricalSignalMatches(value: string, kind: ElectricalSignalKind): boolean {
  return ALIASES[kind].has(normalizeElectricalSignal(value))
}

export function matchingElectricalSignalAliases(value: string): ReadonlySet<string> {
  const normalized = normalizeElectricalSignal(value)
  const kind = classifyElectricalSignal(normalized)
  return kind ? ALIASES[kind] : new Set([normalized])
}
