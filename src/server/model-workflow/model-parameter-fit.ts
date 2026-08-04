import type { ValidationRunResult } from "../spice-validation"

const PARAMETER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const NUMBER_SOURCE = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?"
const PARAMETER_LINE_PATTERN = new RegExp(
  `^(\\s*\\.param\\s+)([A-Za-z_][A-Za-z0-9_]*)(\\s*=\\s*)(${NUMBER_SOURCE})(\\s*(?:[;$].*)?)$`,
  "i",
)

export interface ModelFitParameterRange {
  readonly name: string
  readonly min: number
  readonly max: number
  readonly scale: "linear" | "log"
}

export interface ModelFitParameterDeclaration {
  readonly name: string
  readonly value: number
}

export interface ModelFitScore {
  readonly runnable: boolean
  readonly failed_series_count: number
  readonly worst_normalized_max_error: number
  readonly mean_normalized_rmse: number
}

export interface ModelFitEvaluation {
  readonly values: Readonly<Record<string, number>>
  readonly score: ModelFitScore
}

export interface ModelParameterSearchResult {
  readonly evaluations: number
  readonly initial: ModelFitEvaluation
  readonly best: ModelFitEvaluation
  readonly improvements: readonly ModelFitEvaluation[]
}

interface ParsedParameterLine {
  readonly line_index: number
  readonly name: string
  readonly normalized_name: string
  readonly value: number
  readonly prefix: string
  readonly suffix: string
}

function parseParameterLines(source: string): ParsedParameterLine[] {
  const declarations: ParsedParameterLine[] = []
  const seen = new Set<string>()
  for (const [line_index, line] of source.split("\n").entries()) {
    const match = PARAMETER_LINE_PATTERN.exec(line)
    if (!match) continue
    const name = match[2]!
    const normalized_name = name.toUpperCase()
    if (seen.has(normalized_name)) {
      throw new Error(`model.lib declares .param ${name} more than once`)
    }
    seen.add(normalized_name)
    const value = Number(match[4])
    if (!Number.isFinite(value)) {
      throw new Error(`model.lib .param ${name} must have one finite numeric literal value`)
    }
    declarations.push({
      line_index,
      name,
      normalized_name,
      value,
      prefix: `${match[1]}${name}${match[3]}`,
      suffix: match[5] ?? "",
    })
  }
  return declarations
}

export function readModelFitParameterDeclarations(source: string): ModelFitParameterDeclaration[] {
  return parseParameterLines(source).map(({ name, value }) => ({ name, value }))
}

function spiceNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error("A fitted SPICE parameter became non-finite")
  if (Object.is(value, -0)) return "0"
  return value
    .toExponential(12)
    .replace(/(\.\d*?[1-9])0+e/, "$1e")
    .replace(/\.0+e/, "e")
}

export function replaceModelFitParameters(source: string, values: Readonly<Record<string, number>>): string {
  const requested = new Map(
    Object.entries(values).map(([name, value]) => {
      if (!PARAMETER_NAME_PATTERN.test(name)) throw new Error(`Invalid SPICE parameter name ${name}`)
      if (!Number.isFinite(value)) throw new Error(`Fitted SPICE parameter ${name} must be finite`)
      return [name.toUpperCase(), value] as const
    }),
  )
  const declarations = parseParameterLines(source)
  const declaration_by_name = new Map(declarations.map((entry) => [entry.normalized_name, entry]))
  for (const name of requested.keys()) {
    if (!declaration_by_name.has(name)) {
      throw new Error(`model.lib must declare tunable parameter ${name} as one numeric .param line`)
    }
  }
  const by_line = new Map(
    declarations.flatMap((entry) => {
      const value = requested.get(entry.normalized_name)
      return value === undefined
        ? []
        : [[entry.line_index, `${entry.prefix}${spiceNumber(value)}${entry.suffix}`] as const]
    }),
  )
  return source
    .split("\n")
    .map((line, line_index) => by_line.get(line_index) ?? line)
    .join("\n")
}

export function scoreModelFitValidation(result: ValidationRunResult): ModelFitScore {
  const series = result.cases.flatMap((validation_case) => validation_case.series)
  const normalized_max_errors = series
    .map(({ metrics }) => metrics.normalized_max_error)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  const normalized_rmse = series
    .map(({ metrics }) => metrics.normalized_rmse)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  const runnable =
    result.cases.length > 0 &&
    series.length > 0 &&
    normalized_max_errors.length === series.length &&
    !result.errors.some(({ kind }) => kind !== "comparison")
  return {
    runnable,
    failed_series_count: series.filter(({ passed }) => !passed).length,
    worst_normalized_max_error: runnable ? Math.max(...normalized_max_errors) : Number.MAX_VALUE,
    mean_normalized_rmse:
      runnable && normalized_rmse.length > 0
        ? normalized_rmse.reduce((sum, value) => sum + value, 0) / normalized_rmse.length
        : Number.MAX_VALUE,
  }
}

/** Negative means left is a better public-training fit. */
export function compareModelFitScores(left: ModelFitScore, right: ModelFitScore): number {
  const fields: Array<[number, number]> = [
    [left.runnable ? 0 : 1, right.runnable ? 0 : 1],
    [left.worst_normalized_max_error, right.worst_normalized_max_error],
    [left.mean_normalized_rmse, right.mean_normalized_rmse],
    [left.failed_series_count, right.failed_series_count],
  ]
  for (const [left_value, right_value] of fields) {
    if (left_value < right_value) return -1
    if (left_value > right_value) return 1
  }
  return 0
}

function unitFromValue(range: ModelFitParameterRange, value: number): number {
  if (range.scale === "log") {
    return (Math.log(value) - Math.log(range.min)) / (Math.log(range.max) - Math.log(range.min))
  }
  return (value - range.min) / (range.max - range.min)
}

function valueFromUnit(range: ModelFitParameterRange, unit: number): number {
  const bounded = Math.max(0, Math.min(1, unit))
  if (range.scale === "log") {
    return Math.exp(Math.log(range.min) + bounded * (Math.log(range.max) - Math.log(range.min)))
  }
  return range.min + bounded * (range.max - range.min)
}

function halton(index: number, base: number): number {
  let fraction = 1
  let result = 0
  let remaining = index
  while (remaining > 0) {
    fraction /= base
    result += fraction * (remaining % base)
    remaining = Math.floor(remaining / base)
  }
  return result
}

function validateRanges(
  source: string,
  declarations: readonly ModelFitParameterDeclaration[],
  ranges: readonly ModelFitParameterRange[],
): void {
  if (ranges.length === 0 || ranges.length > 6) {
    throw new Error("Parameter fitting requires between 1 and 6 bounded parameters")
  }
  const declaration_by_name = new Map(declarations.map((entry) => [entry.name.toUpperCase(), entry]))
  const seen = new Set<string>()
  for (const range of ranges) {
    if (!PARAMETER_NAME_PATTERN.test(range.name)) {
      throw new Error(`Invalid SPICE parameter name ${range.name}`)
    }
    const normalized = range.name.toUpperCase()
    if (seen.has(normalized)) throw new Error(`Parameter fitting range ${range.name} is duplicated`)
    seen.add(normalized)
    const declaration = declaration_by_name.get(normalized)
    if (!declaration) {
      throw new Error(`model.lib must declare tunable parameter ${range.name} as one numeric .param line`)
    }
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min >= range.max) {
      throw new Error(`Parameter ${range.name} must have finite min < max`)
    }
    if (range.scale === "log" && (range.min <= 0 || declaration.value <= 0)) {
      throw new Error(`Log-scaled parameter ${range.name} and its bounds must be positive`)
    }
    if (declaration.value < range.min || declaration.value > range.max) {
      throw new Error(
        `Initial .param ${range.name}=${declaration.value} lies outside [${range.min}, ${range.max}]`,
      )
    }
    const used_as_passive_value = source.split("\n").some((line) => {
      const value = /^[rcl]\S*\s+\S+\s+\S+\s+(\S+)/i.exec(line.trim())?.[1]
      const parameter_name = /^\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value ?? "")?.[1]
      return parameter_name?.toUpperCase() === normalized
    })
    if (used_as_passive_value && range.min <= 0) {
      throw new Error(
        `Parameter ${range.name} is used as an R/C/L value and must have a strictly positive lower bound`,
      )
    }
  }
}

function valuesFromUnits(
  ranges: readonly ModelFitParameterRange[],
  units: readonly number[],
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    ranges.map((range, index) => [range.name, valueFromUnit(range, units[index] ?? 0)]),
  )
}

/**
 * Deterministic bounded search: a small Halton exploration followed by
 * coordinate refinement. The evaluator owns the real simulator invocation.
 */
export async function searchModelParameters(input: {
  source: string
  ranges: readonly ModelFitParameterRange[]
  max_evaluations: number
  signal?: AbortSignal
  evaluate: (source: string) => Promise<ModelFitScore>
}): Promise<ModelParameterSearchResult> {
  const declarations = readModelFitParameterDeclarations(input.source)
  validateRanges(input.source, declarations, input.ranges)
  const max_evaluations = Math.max(3, Math.min(64, Math.floor(input.max_evaluations)))
  const declaration_by_name = new Map(declarations.map((entry) => [entry.name.toUpperCase(), entry.value]))
  const initial_units = input.ranges.map((range) =>
    unitFromValue(range, declaration_by_name.get(range.name.toUpperCase())!),
  )
  const improvements: ModelFitEvaluation[] = []
  let evaluations = 0

  const evaluateUnits = async (units: readonly number[]): Promise<ModelFitEvaluation> => {
    if (input.signal?.aborted) throw new Error("Model parameter fitting was cancelled")
    const values = valuesFromUnits(input.ranges, units)
    const score = await input.evaluate(replaceModelFitParameters(input.source, values))
    evaluations += 1
    return { values, score }
  }

  const initial = await evaluateUnits(initial_units)
  let best = initial
  let best_units = [...initial_units]
  improvements.push(initial)

  const accept = (candidate: ModelFitEvaluation, units: readonly number[]) => {
    if (compareModelFitScores(candidate.score, best.score) >= 0) return
    best = candidate
    best_units = [...units]
    improvements.push(candidate)
  }

  const primes = [2, 3, 5, 7, 11, 13]
  const exploration_budget = Math.min(Math.max(input.ranges.length * 3, 6), Math.floor(max_evaluations / 2))
  for (let index = 1; evaluations < exploration_budget; index += 1) {
    const units = input.ranges.map((_, dimension) => halton(index, primes[dimension]!))
    accept(await evaluateUnits(units), units)
  }

  let step = 0.25
  while (evaluations < max_evaluations && step >= 1 / 128) {
    let improved_this_round = false
    for (
      let dimension = 0;
      dimension < input.ranges.length && evaluations < max_evaluations;
      dimension += 1
    ) {
      const center = best_units[dimension]!
      for (const direction of [-1, 1] as const) {
        if (evaluations >= max_evaluations) break
        const moved = Math.max(0, Math.min(1, center + direction * step))
        if (moved === center) continue
        const units = [...best_units]
        units[dimension] = moved
        const before = best
        accept(await evaluateUnits(units), units)
        if (best !== before) improved_this_round = true
      }
    }
    if (!improved_this_round) step /= 2
  }

  return { evaluations, initial, best, improvements }
}
