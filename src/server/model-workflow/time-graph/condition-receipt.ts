import {
  TIME_GRAPH_LOCAL_CONDITION_METHOD,
  type TimeGraphLocalCondition,
  type TimeGraphLocalConditionReceipt,
  type TimeGraphPassiveType,
  type UnsupportedFixtureCondition,
} from "./types"
import {
  assertOnlyKeys,
  boundedString,
  compactText,
  finiteNumber,
  isRecord,
  MAX_GRAPH_LOCAL_CONDITIONS,
  MAX_GRAPH_LOCAL_SOURCE_TEXT_LENGTH,
  NUMBER_SOURCE,
} from "./shared"

export const unsupported_condition_patterns: ReadonlyArray<{
  condition: UnsupportedFixtureCondition
  pattern: RegExp
}> = [
  {
    condition: "digital_protocol",
    pattern: /\b(?:i\s*[²2]\s*c|smbus|spi)\b/i,
  },
  {
    condition: "register_programming",
    pattern: /\b(?:register(?:s|ed)?|program(?:med|ming|mable)?|configuration)\b/i,
  },
  {
    condition: "internal_configuration",
    pattern:
      /\b(?:averag(?:e|ing)\s+(?:is\s+)?set|[a-z0-9_]*bit\s+(?:is\s+)?set|bus\s+only\s+conversions?|adc\s+conversion|conversion\s+(?:time|cycles?))\b/i,
  },
]

export function parseGraphLocalConditionReceipt(
  value: unknown,
  path: string,
  fixture_evidence_context: string,
  summary_fixture_evidence_context: string | null,
): TimeGraphLocalConditionReceipt {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  assertOnlyKeys(value, ["method", "conditions"], path)
  if (value.method !== TIME_GRAPH_LOCAL_CONDITION_METHOD) {
    throw new Error(`${path}.method must be ${TIME_GRAPH_LOCAL_CONDITION_METHOD}`)
  }
  if (!Array.isArray(value.conditions) || value.conditions.length > MAX_GRAPH_LOCAL_CONDITIONS) {
    throw new Error(`${path}.conditions must be an array with at most ${MAX_GRAPH_LOCAL_CONDITIONS} entries`)
  }
  const conditions = value.conditions.map((entry, index): TimeGraphLocalCondition => {
    const condition_path = `${path}.conditions[${index}]`
    if (!isRecord(entry)) throw new Error(`${condition_path} must be an object`)
    const source_scope = entry.source_scope
    if (source_scope !== "graph_caption" && source_scope !== "summary_row") {
      throw new Error(`${condition_path}.source_scope must be graph_caption or summary_row`)
    }
    const source_text = boundedString(
      entry.source_text,
      `${condition_path}.source_text`,
      MAX_GRAPH_LOCAL_SOURCE_TEXT_LENGTH,
    )
    const source_context =
      source_scope === "graph_caption" ? fixture_evidence_context : summary_fixture_evidence_context
    if (!source_context || !compactText(source_context).includes(source_text)) {
      throw new Error(`${condition_path}.source_text must occur in its retained ${source_scope} context`)
    }
    const label = boundedString(entry.label, `${condition_path}.label`, 64)
    if (!/^[A-Z][A-Z0-9]{0,63}$/.test(label)) {
      throw new Error(`${condition_path}.label must be a canonical uppercase electrical label`)
    }
    if (entry.kind === "passive_value") {
      assertOnlyKeys(
        entry,
        ["kind", "source_scope", "source_text", "label", "passive_type", "value_si"],
        condition_path,
      )
      if (
        entry.passive_type !== "resistor" &&
        entry.passive_type !== "capacitor" &&
        entry.passive_type !== "inductor"
      ) {
        throw new Error(`${condition_path}.passive_type must be resistor, capacitor, or inductor`)
      }
      const value_si = finiteNumber(entry.value_si, `${condition_path}.value_si`)
      if (!(value_si > 0)) throw new Error(`${condition_path}.value_si must be positive`)
      return {
        kind: "passive_value",
        source_scope,
        source_text,
        label,
        passive_type: entry.passive_type,
        value_si,
      }
    }
    if (entry.kind === "temperature") {
      assertOnlyKeys(
        entry,
        ["kind", "source_scope", "source_text", "label", "degrees_celsius"],
        condition_path,
      )
      return {
        kind: "temperature",
        source_scope,
        source_text,
        label,
        degrees_celsius: finiteNumber(entry.degrees_celsius, `${condition_path}.degrees_celsius`),
      }
    }
    if (entry.kind === "frequency") {
      assertOnlyKeys(entry, ["kind", "source_scope", "source_text", "label", "hertz"], condition_path)
      const hertz = finiteNumber(entry.hertz, `${condition_path}.hertz`)
      if (!(hertz > 0)) throw new Error(`${condition_path}.hertz must be positive`)
      return { kind: "frequency", source_scope, source_text, label, hertz }
    }
    if (entry.kind === "parasitic") {
      assertOnlyKeys(
        entry,
        ["kind", "source_scope", "source_text", "label", "parameter", "dimension", "value_si"],
        condition_path,
      )
      if (
        entry.parameter !== "esr" &&
        entry.parameter !== "dcr" &&
        entry.parameter !== "parasitic_capacitance" &&
        entry.parameter !== "parasitic_inductance"
      ) {
        throw new Error(`${condition_path}.parameter is not a supported parasitic identifier`)
      }
      if (
        entry.dimension !== "resistor" &&
        entry.dimension !== "capacitor" &&
        entry.dimension !== "inductor"
      ) {
        throw new Error(`${condition_path}.dimension must be resistor, capacitor, or inductor`)
      }
      const value_si =
        entry.value_si === null ? null : finiteNumber(entry.value_si, `${condition_path}.value_si`)
      if (value_si !== null && !(value_si > 0)) {
        throw new Error(`${condition_path}.value_si must be positive or null`)
      }
      return {
        kind: "parasitic",
        source_scope,
        source_text,
        label,
        parameter: entry.parameter,
        dimension: entry.dimension,
        value_si,
      }
    }
    throw new Error(`${condition_path}.kind is unsupported`)
  })
  return { method: TIME_GRAPH_LOCAL_CONDITION_METHOD, conditions }
}

const GRAPH_LOCAL_PREFIX_MULTIPLIERS: Readonly<Record<string, number>> = {
  "": 1,
  f: 1e-15,
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  μ: 1e-6,
  m: 1e-3,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
}

function graphLocalSiValue(value: string, prefix: string): number | undefined {
  const multiplier = GRAPH_LOCAL_PREFIX_MULTIPLIERS[prefix]
  const numeric = Number(value)
  if (multiplier === undefined || !Number.isFinite(numeric) || numeric <= 0) return undefined
  return Number(`${value}e${Math.round(Math.log10(multiplier))}`)
}

function graphLocalLabel(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase()
}

function passiveTypeForUnit(unit: string): TimeGraphPassiveType | undefined {
  if (/^(?:ohms?|Ω)$/i.test(unit)) return "resistor"
  if (/^f$/i.test(unit)) return "capacitor"
  if (/^h$/i.test(unit)) return "inductor"
  return undefined
}

function parasiticParameter(
  label: string,
): Extract<TimeGraphLocalCondition, { kind: "parasitic" }>["parameter"] | undefined {
  const normalized = graphLocalLabel(label)
  if (normalized === "ESR" || normalized === "EQUIVALENTSERIESRESISTANCE") return "esr"
  if (normalized === "DCR" || normalized === "DCSERIESRESISTANCE") return "dcr"
  if (normalized === "PARASITICCAPACITANCE") return "parasitic_capacitance"
  if (normalized === "PARASITICINDUCTANCE") return "parasitic_inductance"
  return undefined
}

function localConditionSortKey(condition: TimeGraphLocalCondition): string {
  return JSON.stringify(condition)
}

function extractGraphLocalConditions(
  context: string,
  source_scope: TimeGraphLocalCondition["source_scope"],
): TimeGraphLocalCondition[] {
  const normalized = compactText(context)
  const conditions: TimeGraphLocalCondition[] = []
  const numeric_parasitics = new Set<string>()
  const passive_pattern = new RegExp(
    `\\b([rcl][a-z0-9_]*(?:\\s+(?:in|out|load))?|esr|dcr)\\s*(?:=|:)\\s*(${NUMBER_SOURCE})\\s*([fpnuµμmkKMG]?)\\s*(Ω|ohms?|[FfHh])(?=\\s|[,;.)]|$)`,
    "gi",
  )
  for (const match of normalized.matchAll(passive_pattern)) {
    const passive_type = passiveTypeForUnit(match[4]!)
    const value_si = graphLocalSiValue(match[2]!, match[3]!)
    if (!passive_type || value_si === undefined) continue
    const label = graphLocalLabel(match[1]!)
    const source_text = match[0]!.trim().slice(0, MAX_GRAPH_LOCAL_SOURCE_TEXT_LENGTH)
    const parameter = parasiticParameter(label)
    if (parameter) {
      numeric_parasitics.add(parameter)
      conditions.push({
        kind: "parasitic",
        source_scope,
        source_text,
        label,
        parameter,
        dimension: passive_type,
        value_si,
      })
    } else {
      conditions.push({
        kind: "passive_value",
        source_scope,
        source_text,
        label,
        passive_type,
        value_si,
      })
    }
  }

  const temperature_pattern = new RegExp(
    `\\b(t[a-z0-9_]*|ambient\\s+temperature|junction\\s+temperature|temperature)\\s*(?:=|:)\\s*(${NUMBER_SOURCE})\\s*(?:°\\s*|deg(?:rees?)?\\s*)?c\\b`,
    "gi",
  )
  for (const match of normalized.matchAll(temperature_pattern)) {
    const degrees_celsius = Number(match[2])
    if (!Number.isFinite(degrees_celsius)) continue
    conditions.push({
      kind: "temperature",
      source_scope,
      source_text: match[0]!.trim().slice(0, MAX_GRAPH_LOCAL_SOURCE_TEXT_LENGTH),
      label: graphLocalLabel(match[1]!),
      degrees_celsius: Object.is(degrees_celsius, -0) ? 0 : degrees_celsius,
    })
  }

  const frequency_pattern = new RegExp(
    `\\b(f[a-z0-9_]*|switching\\s+frequency|frequency)\\s*(?:=|:)\\s*(${NUMBER_SOURCE})\\s*([munµμkKMG]?)\\s*hz\\b`,
    "gi",
  )
  for (const match of normalized.matchAll(frequency_pattern)) {
    const hertz = graphLocalSiValue(match[2]!, match[3]!)
    if (hertz === undefined) continue
    conditions.push({
      kind: "frequency",
      source_scope,
      source_text: match[0]!.trim().slice(0, MAX_GRAPH_LOCAL_SOURCE_TEXT_LENGTH),
      label: graphLocalLabel(match[1]!),
      hertz,
    })
  }

  const parasitic_pattern =
    /\b(esr|dcr|equivalent\s+series\s+resistance|dc\s+series\s+resistance|parasitic\s+capacitance|parasitic\s+inductance)\b/gi
  for (const match of normalized.matchAll(parasitic_pattern)) {
    const parameter = parasiticParameter(match[1]!)
    if (!parameter || numeric_parasitics.has(parameter)) continue
    conditions.push({
      kind: "parasitic",
      source_scope,
      source_text: match[0]!.trim().slice(0, MAX_GRAPH_LOCAL_SOURCE_TEXT_LENGTH),
      label: graphLocalLabel(match[1]!),
      parameter,
      dimension:
        parameter === "parasitic_capacitance"
          ? "capacitor"
          : parameter === "parasitic_inductance"
            ? "inductor"
            : "resistor",
      value_si: null,
    })
  }
  return conditions
}

/**
 * Versioned deterministic extraction of graph-local conditions which are not
 * ideal voltage/current sources. This receipt is stored beside every fresh
 * graph hint and reparsed byte-for-byte from the retained source contexts.
 */
export function deriveTimeGraphLocalConditionReceipt(input: {
  fixture_evidence_context: string
  summary_fixture_evidence_context?: string | null
}): TimeGraphLocalConditionReceipt {
  const conditions = [
    ...extractGraphLocalConditions(input.fixture_evidence_context, "graph_caption"),
    ...(input.summary_fixture_evidence_context
      ? extractGraphLocalConditions(input.summary_fixture_evidence_context, "summary_row")
      : []),
  ]
    .sort((left, right) => localConditionSortKey(left).localeCompare(localConditionSortKey(right)))
    .filter(
      (condition, index, values) =>
        index === 0 || localConditionSortKey(condition) !== localConditionSortKey(values[index - 1]!),
    )
  if (conditions.length > MAX_GRAPH_LOCAL_CONDITIONS) {
    throw new Error(`A graph fixture cannot retain more than ${MAX_GRAPH_LOCAL_CONDITIONS} local conditions`)
  }
  return {
    method: TIME_GRAPH_LOCAL_CONDITION_METHOD,
    conditions,
  }
}

export function unsupportedFixtureConditions(
  context: string,
  local_conditions: TimeGraphLocalConditionReceipt,
): UnsupportedFixtureCondition[] {
  const textual = unsupported_condition_patterns
    .filter(({ pattern }) => {
      pattern.lastIndex = 0
      return pattern.test(context)
    })
    .map(({ condition }) => condition)
  const typed: UnsupportedFixtureCondition[] = [
    ...(local_conditions.conditions.some(({ kind }) => kind === "temperature")
      ? (["temperature_control"] as const)
      : []),
    ...(local_conditions.conditions.some(({ kind }) => kind === "frequency")
      ? (["frequency_control"] as const)
      : []),
    ...(local_conditions.conditions.some(({ kind }) => kind === "parasitic")
      ? (["unrepresentable_parasitic"] as const)
      : []),
  ]
  return [...new Set([...textual, ...typed])]
}
