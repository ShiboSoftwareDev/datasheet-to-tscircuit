const SI_PREFIX_EXPONENTS: Readonly<Record<string, number>> = {
  p: -12,
  n: -9,
  u: -6,
  "µ": -6,
  m: -3,
  "": 0,
  k: 3,
  K: 3,
  M: 6,
  G: 9,
}

/** Parses a passive value into SI base units without accepting prose or guessed defaults. */
export function parseApplicationEngineeringValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined
  if (typeof value !== "string") return undefined
  const normalized = value
    .trim()
    .replace(/\s+/g, "")
    .replace(/ohms?|Ω/gi, "")
  const match = normalized.match(
    /^([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([pnuµmkKMG]?)(?:[FfHh])?$/,
  )
  if (!match) return undefined
  const exponent = SI_PREFIX_EXPONENTS[match[2] ?? ""]
  // Parsing one decimal scientific-notation string avoids multiplication noise
  // (for example 0.47 * 1e-6) becoming part of the canonical contract digest.
  const result = exponent === undefined ? Number.NaN : Number(`${match[1]}e${exponent}`)
  return Number.isFinite(result) && result > 0 ? result : undefined
}
