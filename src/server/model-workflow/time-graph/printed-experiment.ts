import { classifyElectricalSignal, electricalSignalMatches } from "../electrical-signal"
import type {
  TimeGraphAuxiliaryCondition,
  TimeGraphConditionConflict,
  TimeGraphTransientFixtureEvidence,
} from "./types"
import {
  assertOnlyKeys,
  boundedString,
  compactText,
  finiteNumber,
  isRecord,
  MAX_FIXTURE_SOURCE_EXCERPT_LENGTH,
  NUMBER_SOURCE,
  record,
  TIME_UNIT_SOURCE,
  toSi,
} from "./shared"

export function parseTransientFixtureEvidence(
  value: unknown,
  path: string,
  fixture_evidence_context: string,
  summary_fixture_evidence_context: string | null,
): TimeGraphTransientFixtureEvidence | null {
  if (value === null) return null
  if (!isRecord(value)) throw new Error(`${path} must be an object or null`)
  assertOnlyKeys(value, ["method", "source_excerpts", "response", "stimulus", "auxiliary_conditions"], path)
  if (value.method !== "printed_experiment_conditions_v2") {
    throw new Error(`${path}.method must be printed_experiment_conditions_v2`)
  }
  if (!Array.isArray(value.source_excerpts) || value.source_excerpts.length < 1) {
    throw new Error(`${path}.source_excerpts must be a non-empty array`)
  }
  const source_excerpts = value.source_excerpts.map((entry, index) => {
    const excerpt_path = `${path}.source_excerpts[${index}]`
    if (!isRecord(entry)) throw new Error(`${excerpt_path} must be an object`)
    assertOnlyKeys(entry, ["scope", "text"], excerpt_path)
    if (entry.scope !== "summary_row" && entry.scope !== "graph_caption") {
      throw new Error(`${excerpt_path}.scope must be summary_row or graph_caption`)
    }
    const excerpt = boundedString(entry.text, `${excerpt_path}.text`, MAX_FIXTURE_SOURCE_EXCERPT_LENGTH)
    const context =
      entry.scope === "summary_row" ? summary_fixture_evidence_context : fixture_evidence_context
    if (!context || !compactText(context).includes(excerpt)) {
      throw new Error(`${excerpt_path}.text must occur verbatim in its retained ${entry.scope} context`)
    }
    return { scope: entry.scope as "summary_row" | "graph_caption", text: excerpt }
  })
  if (new Set(source_excerpts.map(({ scope }) => scope)).size !== source_excerpts.length) {
    throw new Error(`${path}.source_excerpts must contain each scope at most once`)
  }
  const response = record(value.response, `${path}.response`)
  assertOnlyKeys(response, ["signal", "quantity", "nominal_volts"], `${path}.response`)
  if (response.quantity !== "voltage") throw new Error(`${path}.response.quantity must be voltage`)
  const stimulus = record(value.stimulus, `${path}.stimulus`)
  assertOnlyKeys(stimulus, ["signal", "type", "low", "high", "rise", "fall"], `${path}.stimulus`)
  if (stimulus.type !== "voltage_step" && stimulus.type !== "current_step") {
    throw new Error(`${path}.stimulus.type must be voltage_step or current_step`)
  }
  if (!Array.isArray(value.auxiliary_conditions)) {
    throw new Error(`${path}.auxiliary_conditions must be an array`)
  }
  const auxiliary_conditions = value.auxiliary_conditions.map((entry, index): TimeGraphAuxiliaryCondition => {
    const condition_path = `${path}.auxiliary_conditions[${index}]`
    if (!isRecord(entry)) throw new Error(`${condition_path} must be an object`)
    if (entry.kind === "dc_voltage" || entry.kind === "dc_current") {
      assertOnlyKeys(entry, ["kind", "signal", "value"], condition_path)
      return {
        kind: entry.kind,
        signal: boundedString(entry.signal, `${condition_path}.signal`, 64),
        value: finiteNumber(entry.value, `${condition_path}.value`),
      }
    }
    if (entry.kind === "logic_state") {
      assertOnlyKeys(entry, ["kind", "signal", "state"], condition_path)
      if (entry.state !== "low" && entry.state !== "high") {
        throw new Error(`${condition_path}.state must be low or high`)
      }
      return {
        kind: "logic_state",
        signal: boundedString(entry.signal, `${condition_path}.signal`, 64),
        state: entry.state,
      }
    }
    throw new Error(`${condition_path}.kind must be dc_voltage, dc_current, or logic_state`)
  })
  const auxiliary_keys = auxiliary_conditions.map(({ signal }) => normalizedSignalLabel(signal))
  if (new Set(auxiliary_keys).size !== auxiliary_keys.length) {
    throw new Error(`${path}.auxiliary_conditions must not contain duplicate signals`)
  }
  const result: TimeGraphTransientFixtureEvidence = {
    method: "printed_experiment_conditions_v2",
    source_excerpts,
    response: {
      signal: boundedString(response.signal, `${path}.response.signal`, 64),
      quantity: "voltage",
      nominal_volts: finiteNumber(response.nominal_volts, `${path}.response.nominal_volts`),
    },
    stimulus: {
      signal: boundedString(stimulus.signal, `${path}.stimulus.signal`, 64),
      type: stimulus.type,
      low: finiteNumber(stimulus.low, `${path}.stimulus.low`),
      high: finiteNumber(stimulus.high, `${path}.stimulus.high`),
      rise: finiteNumber(stimulus.rise, `${path}.stimulus.rise`),
      fall: finiteNumber(stimulus.fall, `${path}.stimulus.fall`),
    },
    auxiliary_conditions,
  }
  if (result.stimulus.low === result.stimulus.high) {
    throw new Error(`${path}.stimulus.low and ${path}.stimulus.high must differ`)
  }
  if (result.stimulus.rise < 0 || result.stimulus.fall < 0) {
    throw new Error(`${path}.stimulus.rise and ${path}.stimulus.fall must be non-negative`)
  }
  return result
}

interface ParsedPrintedQuantity {
  value: string
  unit: string
  end: number
}

function lastElectricalQuantity(segment: string, base_unit: "A" | "V"): ParsedPrintedQuantity | undefined {
  const matches = [...segment.matchAll(new RegExp(`(${NUMBER_SOURCE})\\s*([munpµμ]?${base_unit})\\b`, "gi"))]
  const match = matches.at(-1)
  if (match) {
    return {
      value: match[1]!,
      unit: match[2]!,
      end: (match.index ?? 0) + match[0].length,
    }
  }
  // pdftotext can interleave another oscilloscope column between a number and
  // its unit. Accept that layout only when the first number after "to" and a
  // same-dimension unit are both still present before the printed rise label.
  const value_match = new RegExp(NUMBER_SOURCE).exec(segment)
  const unit_match = new RegExp(`[munpµμ]?${base_unit}\\b`, "i").exec(segment)
  if (!value_match || !unit_match || (unit_match.index ?? 0) < (value_match.index ?? 0)) return undefined
  return {
    value: value_match[0],
    unit: unit_match[0],
    end: (unit_match.index ?? 0) + unit_match[0].length,
  }
}

function firstTimeQuantity(segment: string): ParsedPrintedQuantity | undefined {
  const contiguous = new RegExp(`(${NUMBER_SOURCE})\\s*(${TIME_UNIT_SOURCE})\\b`, "i").exec(segment)
  if (contiguous) {
    return {
      value: contiguous[1]!,
      unit: contiguous[2]!,
      end: (contiguous.index ?? 0) + contiguous[0].length,
    }
  }
  const value_match = new RegExp(NUMBER_SOURCE).exec(segment)
  const unit_match = new RegExp(`${TIME_UNIT_SOURCE}\\b`, "i").exec(segment)
  if (!value_match || !unit_match || (unit_match.index ?? 0) < (value_match.index ?? 0)) return undefined
  return {
    value: value_match[0],
    unit: unit_match[0],
    end: (unit_match.index ?? 0) + unit_match[0].length,
  }
}

function normalizedSignalLabel(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase()
}

type ParsedConditionFact =
  | { key: string; display: string; kind: "dc_voltage" | "dc_current"; signal: string; value: number }
  | { key: string; display: string; kind: "logic_state"; signal: string; state: "low" | "high" }
  | {
      key: string
      display: string
      kind: "voltage_step" | "current_step"
      signal: string
      low: number
      high: number
    }

function canonicalConditionSignal(value: string): string {
  const normalized = normalizedSignalLabel(value)
  const kind = classifyElectricalSignal(normalized)
  if (kind === "load_current") return "IO"
  if (kind === "output_voltage") return "VO"
  if (kind === "input_voltage") return "VI"
  return normalized
}

export function parsePrintedConditionFacts(context: string): ParsedConditionFact[] {
  const normalized = compactText(context)
  const by_key = new Map<string, ParsedConditionFact>()
  const step_pattern = new RegExp(
    `\\b(load(?:\\s+current)?|[iv][a-z0-9_]*)\\s+(?:current\\s+)?(?:steps?\\s+)?(?:from|=)\\s*(${NUMBER_SOURCE})\\s*([munpµμ]?[AV])\\s+to\\s+(${NUMBER_SOURCE})\\s*([munpµμ]?[AV])\\b`,
    "gi",
  )
  for (const match of normalized.matchAll(step_pattern)) {
    const low = toSi(match[2]!, match[3]!)
    const high = toSi(match[4]!, match[5]!)
    const low_dimension = match[3]!.toUpperCase().endsWith("V") ? "voltage_step" : "current_step"
    const high_dimension = match[5]!.toUpperCase().endsWith("V") ? "voltage_step" : "current_step"
    if (low === undefined || high === undefined || low === high || low_dimension !== high_dimension) continue
    const signal = canonicalConditionSignal(match[1]!)
    const fact: ParsedConditionFact = {
      key: `step:${signal}`,
      display: `${low_dimension}:${low}:${high}`,
      kind: low_dimension,
      signal,
      low,
      high,
    }
    by_key.set(fact.key, fact)
  }
  const fixed_pattern = new RegExp(
    `\\b([a-z][a-z0-9_]*|load(?:\\s+current)?)\\s*=\\s*(${NUMBER_SOURCE})\\s*([munpµμ]?[AV])\\b`,
    "gi",
  )
  for (const match of normalized.matchAll(fixed_pattern)) {
    const tail = normalized.slice(
      (match.index ?? 0) + match[0].length,
      (match.index ?? 0) + match[0].length + 12,
    )
    if (/^\s+to\b/i.test(tail)) continue
    const value = toSi(match[2]!, match[3]!)
    if (value === undefined) continue
    const signal = canonicalConditionSignal(match[1]!)
    const kind = match[3]!.toUpperCase().endsWith("V") ? "dc_voltage" : "dc_current"
    const fact: ParsedConditionFact = {
      key: `${kind}:${signal}`,
      display: `${kind}:${value}`,
      kind,
      signal,
      value,
    }
    by_key.set(fact.key, fact)
  }
  for (const match of normalized.matchAll(/\b([a-z][a-z0-9_]*)\s*=\s*(low|high)\b/gi)) {
    const signal = canonicalConditionSignal(match[1]!)
    const state = match[2]!.toLowerCase() as "low" | "high"
    const fact: ParsedConditionFact = {
      key: `logic_state:${signal}`,
      display: `logic_state:${state}`,
      kind: "logic_state",
      signal,
      state,
    }
    by_key.set(fact.key, fact)
  }
  for (const match of normalized.matchAll(
    /\b(mode)\s*=\s*(?:.{0,180}?\bfigure\s+\d+(?:\s*[-–—]\s*\d+)*\s*)?(low|high)\b/gi,
  )) {
    const signal = canonicalConditionSignal(match[1]!)
    const state = match[2]!.toLowerCase() as "low" | "high"
    by_key.set(`logic_state:${signal}`, {
      key: `logic_state:${signal}`,
      display: `logic_state:${state}`,
      kind: "logic_state",
      signal,
      state,
    })
  }
  return [...by_key.values()].sort((left, right) => left.key.localeCompare(right.key))
}

function printedConditionConflicts(
  summary: readonly ParsedConditionFact[],
  graph: readonly ParsedConditionFact[],
): TimeGraphConditionConflict[] {
  const graph_by_key = new Map(graph.map((fact) => [fact.key, fact]))
  return summary.flatMap((summary_fact) => {
    const graph_fact = graph_by_key.get(summary_fact.key)
    return graph_fact && graph_fact.display !== summary_fact.display
      ? [
          {
            code: "condition_conflict" as const,
            key: summary_fact.key,
            summary_value: summary_fact.display,
            graph_value: graph_fact.display,
          },
        ]
      : []
  })
}

/**
 * Extracts the complete, narrow experiment class the current simulator can
 * reproduce: one numeric step, a printed output-voltage nominal, and every
 * graph-local static electrical/logical condition. Conflicting retained
 * summary/caption facts fail closed instead of using a precedence heuristic.
 */
export function deriveTimeGraphPrintedExperiment(input: {
  fixture_evidence_context: string
  summary_fixture_evidence_context?: string | null
}): {
  evidence: TimeGraphTransientFixtureEvidence | null
  condition_conflicts: TimeGraphConditionConflict[]
} {
  const stimulus_context = input.fixture_evidence_context
  const normalized_stimulus = compactText(stimulus_context)
  const prefix_candidates = (["A", "V"] as const).flatMap((base_unit) => {
    const pattern = new RegExp(
      `\\b(load\\s+current|[iv][a-z0-9_]*)\\s+(?:current\\s+)?(?:steps?\\s+)?from\\s+(${NUMBER_SOURCE})\\s*([munpµμ]?${base_unit})\\b`,
      "i",
    )
    const match = pattern.exec(normalized_stimulus)
    return match ? [{ base_unit, match }] : []
  })
  const prefix = prefix_candidates.sort(
    (left, right) => (left.match.index ?? 0) - (right.match.index ?? 0),
  )[0]
  if (!prefix) return { evidence: null, condition_conflicts: [] }
  const prefix_end = (prefix.match.index ?? 0) + prefix.match[0].length
  const after_prefix = normalized_stimulus.slice(prefix_end, prefix_end + 700)
  const to_match = /\bto\b/i.exec(after_prefix)
  if (!to_match || (to_match.index ?? 0) > 160) return { evidence: null, condition_conflicts: [] }
  const after_to_offset = prefix_end + (to_match.index ?? 0) + to_match[0].length
  const after_to = normalized_stimulus.slice(after_to_offset, after_to_offset + 540)
  const rise_label = /\b(?:t[_\s]*r|rise(?:\s+time)?)\b/i.exec(after_to)
  if (!rise_label || (rise_label.index ?? 0) > 260) return { evidence: null, condition_conflicts: [] }
  const rise_label_offset = after_to_offset + (rise_label.index ?? 0)
  const after_rise_label = normalized_stimulus.slice(
    rise_label_offset + rise_label[0].length,
    rise_label_offset + rise_label[0].length + 260,
  )
  const fall_label = /\b(?:t[_\s]*f|fall(?:\s+time)?)\b/i.exec(after_rise_label)
  if (!fall_label || (fall_label.index ?? 0) > 180) return { evidence: null, condition_conflicts: [] }
  const fall_label_offset = rise_label_offset + rise_label[0].length + (fall_label.index ?? 0)
  const high_quantity = lastElectricalQuantity(
    normalized_stimulus.slice(after_to_offset, rise_label_offset),
    prefix.base_unit,
  )
  const rise_quantity = firstTimeQuantity(
    normalized_stimulus.slice(rise_label_offset + rise_label[0].length, fall_label_offset),
  )
  const fall_segment = normalized_stimulus.slice(
    fall_label_offset + fall_label[0].length,
    fall_label_offset + fall_label[0].length + 180,
  )
  const fall_quantity = firstTimeQuantity(fall_segment)
  if (!high_quantity || !rise_quantity || !fall_quantity) {
    return { evidence: null, condition_conflicts: [] }
  }
  const stimulus_signal = canonicalConditionSignal(prefix.match[1]!)
  const low = toSi(prefix.match[2]!, prefix.match[3]!)
  const high = toSi(high_quantity.value, high_quantity.unit)
  const rise = toSi(rise_quantity.value, rise_quantity.unit)
  const fall = toSi(fall_quantity.value, fall_quantity.unit)
  if (
    low === undefined ||
    high === undefined ||
    rise === undefined ||
    fall === undefined ||
    low === high ||
    rise < 0 ||
    fall < 0
  ) {
    return { evidence: null, condition_conflicts: [] }
  }
  const source_start = prefix.match.index ?? 0
  const source_end =
    fall_label_offset + fall_label[0].length + Math.min(fall_segment.length, fall_quantity.end)
  const next_figure = normalized_stimulus.slice(source_start).search(/\bfigure\s+\d+/i)
  const excerpt_end = Math.min(
    normalized_stimulus.length,
    next_figure >= 0 ? source_start + next_figure : Math.max(source_end, source_start + 420),
  )
  const graph_excerpt = normalized_stimulus
    .slice(Math.max(0, source_start - 180), excerpt_end)
    .slice(0, MAX_FIXTURE_SOURCE_EXCERPT_LENGTH)
    .trim()
  const graph_facts_by_key = new Map(
    parsePrintedConditionFacts(graph_excerpt).map((fact) => [fact.key, fact]),
  )
  const stimulus_fact: ParsedConditionFact = {
    key: `step:${stimulus_signal}`,
    display: `${prefix.base_unit === "A" ? "current_step" : "voltage_step"}:${low}:${high}`,
    kind: prefix.base_unit === "A" ? "current_step" : "voltage_step",
    signal: stimulus_signal,
    low,
    high,
  }
  graph_facts_by_key.set(stimulus_fact.key, stimulus_fact)
  const graph_facts = [...graph_facts_by_key.values()]
  const summary_context = input.summary_fixture_evidence_context
    ? compactText(input.summary_fixture_evidence_context)
    : null
  const summary_facts = summary_context ? parsePrintedConditionFacts(summary_context) : []
  const condition_conflicts = printedConditionConflicts(summary_facts, graph_facts)
  if (condition_conflicts.length > 0) return { evidence: null, condition_conflicts }

  const all_facts = new Map([...summary_facts, ...graph_facts].map((fact) => [fact.key, fact]))
  all_facts.set(stimulus_fact.key, stimulus_fact)
  const response_candidates = [...all_facts.values()].filter(
    (fact) => fact.kind === "dc_voltage" && electricalSignalMatches(fact.signal, "output_voltage"),
  ) as Array<ParsedConditionFact & { kind: "dc_voltage"; value: number }>
  if (response_candidates.length !== 1) return { evidence: null, condition_conflicts: [] }
  const response = response_candidates[0]!
  const auxiliary_conditions = [...all_facts.values()].flatMap((fact): TimeGraphAuxiliaryCondition[] => {
    if (fact.signal === response.signal || fact.signal === stimulus_signal) return []
    if (fact.kind === "dc_voltage" || fact.kind === "dc_current") {
      return [{ kind: fact.kind, signal: fact.signal, value: fact.value }]
    }
    if (fact.kind === "logic_state") {
      return [{ kind: "logic_state", signal: fact.signal, state: fact.state }]
    }
    return []
  })
  const source_excerpts: TimeGraphTransientFixtureEvidence["source_excerpts"] = [
    { scope: "graph_caption", text: graph_excerpt },
    ...(summary_context
      ? ([
          {
            scope: "summary_row" as const,
            text: summary_context.slice(0, MAX_FIXTURE_SOURCE_EXCERPT_LENGTH),
          },
        ] as const)
      : []),
  ]
  return {
    evidence: {
      method: "printed_experiment_conditions_v2",
      source_excerpts,
      response: { signal: response.signal, quantity: "voltage", nominal_volts: response.value },
      stimulus: {
        signal: stimulus_signal,
        type: prefix.base_unit === "A" ? "current_step" : "voltage_step",
        low,
        high,
        rise,
        fall,
      },
      auxiliary_conditions,
    },
    condition_conflicts,
  }
}

export function deriveTimeGraphTransientFixtureEvidence(
  stimulus_context: string,
): TimeGraphTransientFixtureEvidence | null {
  return deriveTimeGraphPrintedExperiment({
    fixture_evidence_context: stimulus_context,
  }).evidence
}
