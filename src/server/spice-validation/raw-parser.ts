import type { ParsedRawFile, RawPlot, RawVariable } from "./types"

export type RawParseErrorCode =
  | "raw_empty"
  | "raw_binary_unsupported"
  | "raw_complex_unsupported"
  | "raw_malformed_header"
  | "raw_malformed_variable"
  | "raw_malformed_value"
  | "raw_non_finite"
  | "raw_count_mismatch"

export class RawParseError extends Error {
  readonly code: RawParseErrorCode
  readonly line?: number

  constructor(code: RawParseErrorCode, message: string, line?: number) {
    super(line === undefined ? message : `${message} (line ${line})`)
    this.name = "RawParseError"
    this.code = code
    this.line = line
  }
}

function findHeader(lines: string[], name: string): { index: number; value: string } | null {
  const escaped_name = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`^\\s*${escaped_name}\\s*:\\s*(.*?)\\s*$`, "i")
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(pattern)
    if (match) return { index, value: match[1] ?? "" }
  }
  return null
}

function requireHeader(lines: string[], name: string, plot_index: number): { index: number; value: string } {
  const header = findHeader(lines, name)
  if (!header) {
    throw new RawParseError("raw_malformed_header", `Raw plot ${plot_index + 1} is missing ${name}:`)
  }
  return header
}

function parseCount(value: string, name: string, plot_index: number): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new RawParseError(
      "raw_malformed_header",
      `Raw plot ${plot_index + 1} has an invalid ${name}: value ${JSON.stringify(value)}`,
    )
  }
  const count = Number.parseInt(value, 10)
  if (count < 1) {
    throw new RawParseError("raw_count_mismatch", `Raw plot ${plot_index + 1} declares no ${name}`)
  }
  return count
}

function parseFiniteRawNumber(token: string, line: number): number {
  const value = Number(token)
  if (Number.isNaN(value) && /^[-+]?nan$/i.test(token)) {
    throw new RawParseError("raw_non_finite", `Raw value ${JSON.stringify(token)} is not finite`, line)
  }
  if (!Number.isFinite(value)) {
    throw new RawParseError(
      /^[-+]?(?:inf|infinity)$/i.test(token) ? "raw_non_finite" : "raw_malformed_value",
      `Raw value ${JSON.stringify(token)} is not a finite real number`,
      line,
    )
  }
  return value
}

function parseVariables(input: {
  lines: string[]
  start_index: number
  end_index: number
  variable_count: number
  line_offset: number
}): RawVariable[] {
  const variables: RawVariable[] = []
  for (let index = input.start_index; index < input.end_index; index += 1) {
    const line = input.lines[index]
    if (line === undefined) {
      throw new RawParseError("raw_count_mismatch", "Raw variable table ended unexpectedly")
    }
    if (!line.trim()) continue
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(\S+)\s*$/)
    if (!match) {
      throw new RawParseError(
        "raw_malformed_variable",
        `Invalid raw variable descriptor ${JSON.stringify(line.trim())}`,
        input.line_offset + index + 1,
      )
    }
    const [, raw_index, name, data_type] = match
    if (raw_index === undefined || name === undefined || data_type === undefined) {
      throw new RawParseError(
        "raw_malformed_variable",
        `Invalid raw variable descriptor ${JSON.stringify(line.trim())}`,
        input.line_offset + index + 1,
      )
    }
    const variable_index = Number.parseInt(raw_index, 10)
    if (variable_index !== variables.length) {
      throw new RawParseError(
        "raw_count_mismatch",
        `Expected raw variable index ${variables.length}, found ${variable_index}`,
        input.line_offset + index + 1,
      )
    }
    variables.push({ index: variable_index, name, data_type })
  }
  if (variables.length !== input.variable_count) {
    throw new RawParseError(
      "raw_count_mismatch",
      `Declared ${input.variable_count} raw variables but parsed ${variables.length}`,
    )
  }
  return variables
}

function parseRows(input: {
  lines: string[]
  start_index: number
  point_count: number
  variable_count: number
  line_offset: number
}): number[][] {
  const rows: number[][] = []
  let line_index = input.start_index
  const nextNonEmptyLine = (): { text: string; index: number } | null => {
    while (line_index < input.lines.length) {
      const index = line_index
      line_index += 1
      const text = input.lines[index]?.trim() ?? ""
      if (text) return { text, index }
    }
    return null
  }

  for (let point_index = 0; point_index < input.point_count; point_index += 1) {
    const first_line = nextNonEmptyLine()
    if (!first_line) {
      throw new RawParseError(
        "raw_count_mismatch",
        `Declared ${input.point_count} raw points but parsed ${rows.length}`,
      )
    }
    const first_tokens = first_line.text.split(/\s+/)
    if (!/^\d+$/.test(first_tokens[0] ?? "")) {
      throw new RawParseError(
        "raw_malformed_value",
        `Expected raw point index ${point_index}`,
        input.line_offset + first_line.index + 1,
      )
    }
    const raw_index = first_tokens[0]
    if (raw_index === undefined) {
      throw new RawParseError(
        "raw_malformed_value",
        `Expected raw point index ${point_index}`,
        input.line_offset + first_line.index + 1,
      )
    }
    const parsed_index = Number.parseInt(raw_index, 10)
    if (parsed_index !== point_index) {
      throw new RawParseError(
        "raw_count_mismatch",
        `Expected raw point index ${point_index}, found ${parsed_index}`,
        input.line_offset + first_line.index + 1,
      )
    }
    const values = first_tokens
      .slice(1)
      .map((token) => parseFiniteRawNumber(token, input.line_offset + first_line.index + 1))
    while (values.length < input.variable_count) {
      const continuation = nextNonEmptyLine()
      if (!continuation) {
        throw new RawParseError(
          "raw_count_mismatch",
          `Raw point ${point_index} has ${values.length} of ${input.variable_count} values`,
        )
      }
      values.push(
        ...continuation.text
          .split(/\s+/)
          .map((token) => parseFiniteRawNumber(token, input.line_offset + continuation.index + 1)),
      )
    }
    if (values.length !== input.variable_count) {
      throw new RawParseError(
        "raw_count_mismatch",
        `Raw point ${point_index} has ${values.length} values, expected ${input.variable_count}`,
      )
    }
    rows.push(values)
  }
  const unexpected = nextNonEmptyLine()
  if (unexpected) {
    throw new RawParseError(
      "raw_count_mismatch",
      `Raw plot has data after its declared ${input.point_count} points`,
      input.line_offset + unexpected.index + 1,
    )
  }
  return rows
}

function parsePlot(lines: string[], plot_index: number, line_offset: number): RawPlot {
  if (lines.some((line) => /^\s*Binary\s*:/i.test(line))) {
    throw new RawParseError("raw_binary_unsupported", `Raw plot ${plot_index + 1} contains binary data`)
  }
  const title = requireHeader(lines, "Title", plot_index).value
  const plot_name = requireHeader(lines, "Plotname", plot_index).value
  const flags = requireHeader(lines, "Flags", plot_index)
    .value.split(/\s+/)
    .filter(Boolean)
    .map((flag) => flag.toLowerCase())
  if (!flags.includes("real") || flags.includes("complex")) {
    throw new RawParseError("raw_complex_unsupported", `Raw plot ${plot_index + 1} is not real-valued`)
  }
  const variable_count = parseCount(
    requireHeader(lines, "No. Variables", plot_index).value,
    "No. Variables",
    plot_index,
  )
  const point_count = parseCount(
    requireHeader(lines, "No. Points", plot_index).value,
    "No. Points",
    plot_index,
  )
  const variables_header = requireHeader(lines, "Variables", plot_index)
  const values_header = requireHeader(lines, "Values", plot_index)
  if (values_header.index <= variables_header.index) {
    throw new RawParseError("raw_malformed_header", `Raw plot ${plot_index + 1} has Values before Variables`)
  }
  const variables = parseVariables({
    lines,
    start_index: variables_header.index + 1,
    end_index: values_header.index,
    variable_count,
    line_offset,
  })
  const rows = parseRows({
    lines,
    start_index: values_header.index + 1,
    point_count,
    variable_count,
    line_offset,
  })
  return { title, plot_name, flags, variables, rows }
}

export function parseNgspiceAsciiRaw(source: string): ParsedRawFile {
  const lines = source.replace(/\r\n?/g, "\n").split("\n")
  const starts = lines.flatMap((line, index) => (/^\s*Title\s*:/i.test(line) ? [index] : []))
  if (starts.length === 0) throw new RawParseError("raw_empty", "Raw file contains no plots")
  const plots = starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length
    return parsePlot(lines.slice(start, end), index, start)
  })
  return { plots }
}
