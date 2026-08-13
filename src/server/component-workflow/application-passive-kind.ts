export type ExecutableApplicationPassiveType = "resistor" | "capacitor" | "inductor" | "diode"

function normalizeApplicationComponentKind(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
}

export function executableApplicationPassiveType(kind: string): ExecutableApplicationPassiveType | undefined {
  const normalized = normalizeApplicationComponentKind(kind)
  if (normalized.includes("resistor")) return "resistor"
  if (normalized.includes("capacitor")) return "capacitor"
  if (normalized.includes("inductor") || normalized.includes("ferrite")) return "inductor"
  if (normalized.includes("diode")) return "diode"
  return undefined
}

export function tscircuitApplicationPassiveValue(value: string): string | undefined {
  const normalized = value
    .trim()
    .replace(/\s+/g, "")
    .replace(/[µμ]/g, "u")
    .replace(/ohms?|Ω/gi, "")
  return /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[pnumkKMG]?(?:[FfHh])?$/.test(normalized)
    ? normalized
    : undefined
}
