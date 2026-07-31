import type {
  CompiledObservation,
  ParsedRawFile,
  RawPlot,
  ValidationAnalysis,
  ValidationSeriesPoint,
} from "./types"

export class MissingRawVectorError extends Error {
  readonly code = "missing_vector"
  readonly requested: string[]
  readonly available: string[]

  constructor(requested: string[], available: string[]) {
    super(
      `Missing ngspice vector (${requested.join(" or ")}); available vectors: ${available.join(", ") || "none"}`,
    )
    this.name = "MissingRawVectorError"
    this.requested = requested
    this.available = available
  }
}

function normalizedVectorName(name: string): string {
  return name.trim().toLowerCase()
}

function vectorValues(plot: RawPlot, names: string[]): number[] | undefined {
  const requested = new Set(names.map(normalizedVectorName))
  const variable = plot.variables.find((candidate) => requested.has(normalizedVectorName(candidate.name)))
  if (!variable) return undefined
  return plot.rows.map((row) => {
    const value = row[variable.index]
    if (value === undefined) {
      throw new MissingRawVectorError(
        names,
        plot.variables.map((candidate) => candidate.name),
      )
    }
    return value
  })
}

function requireVectorValues(plot: RawPlot, names: string[]): number[] {
  const values = vectorValues(plot, names)
  if (values) return values
  throw new MissingRawVectorError(
    names,
    plot.variables.map((variable) => variable.name),
  )
}

export function selectAnalysisPlot(raw: ParsedRawFile, analysis: ValidationAnalysis): RawPlot {
  const expected =
    analysis.type === "operating_point"
      ? /operating point/i
      : analysis.type === "dc_sweep"
        ? /dc transfer characteristic|dc sweep/i
        : /transient analysis/i
  const plot = [...raw.plots].reverse().find((candidate) => expected.test(candidate.plot_name))
  if (plot) return plot
  throw new MissingRawVectorError(
    [`plot:${analysis.type}`],
    raw.plots.map((candidate) => `plot:${candidate.plot_name}`),
  )
}

function getXAxis(plot: RawPlot, analysis: ValidationAnalysis): number[] {
  if (analysis.type === "operating_point") return plot.rows.map(() => 0)
  const axis = plot.variables[0]
  if (!axis) throw new MissingRawVectorError([analysis.type === "transient" ? "time" : "sweep"], [])
  if (analysis.type === "transient" && normalizedVectorName(axis.name) !== "time") {
    return requireVectorValues(plot, ["time"])
  }
  return plot.rows.map((row) => {
    const value = row[axis.index]
    if (value === undefined) {
      throw new MissingRawVectorError(
        [axis.name],
        plot.variables.map((variable) => variable.name),
      )
    }
    return value
  })
}

function getNodeVoltage(plot: RawPlot, node: string): number[] {
  if (node === "0") return plot.rows.map(() => 0)
  return requireVectorValues(plot, [`v(${node})`])
}

function getDifferentialVoltage(plot: RawPlot, positive_node: string, negative_node: string): number[] {
  const direct = vectorValues(plot, [`v(${positive_node},${negative_node})`])
  if (direct) return direct
  const positive = getNodeVoltage(plot, positive_node)
  const negative = getNodeVoltage(plot, negative_node)
  return positive.map((value, index) => {
    const negative_value = negative[index]
    if (negative_value === undefined) {
      throw new MissingRawVectorError(
        [`v(${negative_node})`],
        plot.variables.map((variable) => variable.name),
      )
    }
    return value - negative_value
  })
}

function getCurrent(plot: RawPlot, observation: CompiledObservation): number[] {
  const element_name = observation.element_name
  if (!element_name) throw new MissingRawVectorError(observation.saved_vectors, [])
  const candidates = [
    ...observation.saved_vectors,
    `i(${element_name})`,
    `@${element_name}[i]`,
    `@${element_name}[id]`,
    `${element_name}#branch`,
  ]
  return requireVectorValues(plot, [...new Set(candidates)])
}

export function extractObservationSeries(input: {
  plot: RawPlot
  analysis: ValidationAnalysis
  compiled_observation: CompiledObservation
}): ValidationSeriesPoint[] {
  const x_values = getXAxis(input.plot, input.analysis)
  const compiled = input.compiled_observation
  const y_values =
    compiled.observation.type === "voltage"
      ? getDifferentialVoltage(input.plot, compiled.positive_node ?? "", compiled.negative_node ?? "")
      : getCurrent(input.plot, compiled)
  if (x_values.length !== y_values.length) {
    throw new MissingRawVectorError(
      compiled.saved_vectors,
      input.plot.variables.map((variable) => variable.name),
    )
  }
  return x_values.map((x, index) => {
    const y = y_values[index]
    if (y === undefined) {
      throw new MissingRawVectorError(
        compiled.saved_vectors,
        input.plot.variables.map((variable) => variable.name),
      )
    }
    return { x, y }
  })
}
