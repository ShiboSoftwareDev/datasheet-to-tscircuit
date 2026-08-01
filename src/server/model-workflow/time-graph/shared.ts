export const MAX_TIME_GRAPH_HINTS = 512
export const MAX_OPERATING_CONDITION_EVIDENCE_LENGTH = 2_048
export const MAX_FIXTURE_EVIDENCE_CONTEXT_LENGTH = 2_048
export const MAX_FIXTURE_SOURCE_EXCERPT_LENGTH = 512
export const MAX_GRAPH_LOCAL_CONDITIONS = 64
export const MAX_GRAPH_LOCAL_SOURCE_TEXT_LENGTH = 160

export const NUMBER_SOURCE = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)"
export const TIME_UNIT_SOURCE = "(?:[fpnumµμ]?s|[fpnumµμ]?sec(?:ond)?s?)"

export function compactText(value: string): string {
  return value.trim().replace(/\s+/g, " ")
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  return value
}

export function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new Error(`${path} contains unsupported fields: ${unknown.join(", ")}`)
  }
}

export function boundedString(value: unknown, path: string, max_length: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string`)
  }
  const normalized = value.trim()
  if (normalized.length > max_length) {
    throw new Error(`${path} cannot exceed ${max_length} characters`)
  }
  return normalized
}

export function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`)
  }
  return Object.is(value, -0) ? 0 : value
}

function siMultiplier(unit: string): number | undefined {
  const normalized = unit.replace(/[µμ]/g, "u").toLowerCase()
  const prefix = normalized.length > 1 ? normalized[0] : ""
  return (
    {
      "": 1,
      f: 1e-15,
      p: 1e-12,
      n: 1e-9,
      u: 1e-6,
      m: 1e-3,
    } as Record<string, number | undefined>
  )[prefix]
}

export function toSi(value: string, unit: string): number | undefined {
  const multiplier = siMultiplier(unit)
  const numeric = Number(value)
  return multiplier === undefined || !Number.isFinite(numeric)
    ? undefined
    : Number((numeric * multiplier).toPrecision(15))
}
