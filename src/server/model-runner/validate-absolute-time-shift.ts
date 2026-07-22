import { randomInt } from "node:crypto"
import { mkdir, readFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { JobLogStream } from "@/shared/job-types"
import {
  extractSimulationResultPoints,
  getVerifiedResultsDirectory,
  readSimulationDefinitions,
} from "../model-simulation-validator"
import { listModelBenchFiles } from "./list-model-bench-files"
import { executeValidationBuild } from "./validate-champion"

const TIME_LITERAL_TO_MS: Record<string, number> = {
  s: 1_000,
  ms: 1,
  us: 0.001,
  µs: 0.001,
  ns: 0.000_001,
}

function parseTimeLiteralMs(value: string): number | undefined {
  const match = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(s|ms|us|µs|ns)$/i)
  if (!match) return undefined
  const amount = Number(match[1])
  const multiplier = TIME_LITERAL_TO_MS[match[2]!.toLowerCase()]
  return Number.isFinite(amount) && multiplier !== undefined ? amount * multiplier : undefined
}

function formatTimeMs(value: number): string {
  return `${Number(value.toPrecision(12))}ms`
}

function getExecutableModelSource(model_source: string): string {
  return model_source
    .split(/\r?\n/)
    .filter((line) => !/^\s*[*;$]/.test(line))
    .map((line) => line.replace(/\s+[;$].*$/, ""))
    .join("\n")
}

export function modelUsesAbsoluteTime(model_source: string): boolean {
  const executable_source = getExecutableModelSource(model_source)
  return /\bTIME\b/i.test(executable_source)
}

export function findSuspiciousBenchmarkConditioning(model_source: string): string[] {
  const executable_source = getExecutableModelSource(model_source).replace(/\s+/g, " ")
  const number_source = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?"
  const windows_by_signal = new Map<string, Array<{ lower: number; upper: number }>>()
  const exact_values_by_signal = new Map<string, Set<number>>()
  const comparisons: Array<{
    signal: string
    operator: string
    value: number
    start: number
    end: number
  }> = []
  const signal_first = new RegExp(`V\\(([^)]+)\\)\\s*(<=|>=|==|=|<|>)\\s*(${number_source})`, "gi")
  for (const match of executable_source.matchAll(signal_first)) {
    comparisons.push({
      signal: match[1]!.replace(/\s+/g, "").toLowerCase(),
      operator: match[2]!,
      value: Number(match[3]),
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    })
  }
  const number_first = new RegExp(`(${number_source})\\s*(<=|>=|==|=|<|>)\\s*V\\(([^)]+)\\)`, "gi")
  const reverse_operator: Record<string, string> = {
    "<": ">",
    "<=": ">=",
    ">": "<",
    ">=": "<=",
    "=": "=",
    "==": "==",
  }
  for (const match of executable_source.matchAll(number_first)) {
    comparisons.push({
      signal: match[3]!.replace(/\s+/g, "").toLowerCase(),
      operator: reverse_operator[match[2]!]!,
      value: Number(match[1]),
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    })
  }
  comparisons.sort((left, right) => left.start - right.start)
  for (const comparison of comparisons) {
    if (!Number.isFinite(comparison.value)) continue
    if (comparison.operator === "=" || comparison.operator === "==") {
      const values = exact_values_by_signal.get(comparison.signal) ?? new Set<number>()
      values.add(comparison.value)
      exact_values_by_signal.set(comparison.signal, values)
    }
  }
  for (let index = 0; index < comparisons.length - 1; index++) {
    const left = comparisons[index]!
    const right = comparisons[index + 1]!
    if (left.signal !== right.signal) continue
    const separator = executable_source.slice(left.end, right.start)
    if (!/^\s*[),]*(?:&{1,2}|\band\b|,)\s*[(,]*$/i.test(separator)) continue
    const lower_comparison = [left, right].find((entry) => entry.operator.startsWith(">"))
    const upper_comparison = [left, right].find((entry) => entry.operator.startsWith("<"))
    if (!lower_comparison || !upper_comparison) continue
    const lower = lower_comparison.value
    const upper = upper_comparison.value
    const center = (lower + upper) / 2
    const width = upper - lower
    if (width <= 0 || width > Math.max(0.05, Math.abs(center) * 0.02)) continue
    const windows = windows_by_signal.get(left.signal) ?? []
    windows.push({ lower, upper })
    windows_by_signal.set(left.signal, windows)
  }
  const abs_window = new RegExp(
    `abs\\s*\\(\\s*V\\(([^)]+)\\)\\s*-\\s*(${number_source})\\s*\\)\\s*<\\s*(${number_source})`,
    "gi",
  )
  for (const match of executable_source.matchAll(abs_window)) {
    const signal = match[1]!.replace(/\s+/g, "").toLowerCase()
    const center = Number(match[2])
    const tolerance = Number(match[3])
    if (!Number.isFinite(center) || !Number.isFinite(tolerance) || tolerance <= 0) continue
    if (tolerance * 2 > Math.max(0.05, Math.abs(center) * 0.02)) continue
    const windows = windows_by_signal.get(signal) ?? []
    windows.push({ lower: center - tolerance, upper: center + tolerance })
    windows_by_signal.set(signal, windows)
  }
  const signals = new Set([...windows_by_signal.keys(), ...exact_values_by_signal.keys()])
  return [...signals].flatMap((signal) => {
    const windows = windows_by_signal.get(signal) ?? []
    const exact_values = [...(exact_values_by_signal.get(signal) ?? [])]
    if (windows.length >= 3) {
      return [
        `model.lib contains ${windows.length} narrow conditional windows for V(${signal}) around ${windows
          .map(({ lower, upper }) => `${lower}..${upper}`)
          .join(", ")}; replace benchmark-specific operating-point selection with continuous causal behavior`,
      ]
    }
    if (exact_values.length >= 3) {
      return [
        `model.lib selects ${exact_values.length} exact operating points for V(${signal}) at ${exact_values.join(
          ", ",
        )}; replace benchmark-specific equality selection with continuous causal behavior`,
      ]
    }
    return []
  })
}

export interface ShiftedBenchmarkSource {
  source: string
  shift_ms: number
  first_pulse_delay_ms: number
  original_duration_ms: number
}

export function shiftLiteralPulseDelays(
  source: string,
  shift_ms: number,
): ShiftedBenchmarkSource | undefined {
  if (!Number.isFinite(shift_ms) || shift_ms <= 0) throw new Error("time shift must be positive")
  const pulse_delays: number[] = []
  const shifted_pulses = source.replace(
    /(\bpulseDelay\s*=\s*)(["'])([^"']+)\2/g,
    (...matches: [string, string, string, string]) => {
      const [match, prefix, quote, literal] = matches
      const delay_ms = parseTimeLiteralMs(literal)
      if (delay_ms === undefined) return match
      pulse_delays.push(delay_ms)
      return `${prefix}${quote}${formatTimeMs(delay_ms + shift_ms)}${quote}`
    },
  )
  if (pulse_delays.length === 0) return undefined

  let original_duration_ms: number | undefined
  const shifted_source = shifted_pulses.replace(
    /(<analogsimulation\b[\s\S]*?\bduration\s*=\s*)(["'])([^"']+)\2/i,
    (...matches: [string, string, string, string]) => {
      const [match, prefix, quote, literal] = matches
      const duration_ms = parseTimeLiteralMs(literal)
      if (duration_ms === undefined) return match
      original_duration_ms = duration_ms
      return `${prefix}${quote}${formatTimeMs(duration_ms + shift_ms)}${quote}`
    },
  )
  if (original_duration_ms === undefined) return undefined
  return {
    source: shifted_source,
    shift_ms,
    first_pulse_delay_ms: Math.min(...pulse_delays),
    original_duration_ms,
  }
}

export interface TimeShiftPoint {
  x: number
  y: number
}

export interface TimeShiftComparison {
  passed: boolean
  normalized_rmse: number
  normalized_max_error: number
  compared_points: number
}

function interpolatePoints(points: TimeShiftPoint[], x: number): number | undefined {
  if (points.length < 2 || x < points[0]!.x || x > points.at(-1)!.x) return undefined
  let low = 0
  let high = points.length - 1
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (points[middle]!.x <= x) low = middle
    else high = middle
  }
  const left = points[low]!
  const right = points[high]!
  if (right.x === left.x) return right.y
  const ratio = (x - left.x) / (right.x - left.x)
  return left.y + ratio * (right.y - left.y)
}

export function compareTimeShiftedResults(input: {
  original: TimeShiftPoint[]
  shifted: TimeShiftPoint[]
  shift_ms: number
  first_pulse_delay_ms: number
}): TimeShiftComparison {
  const original = [...input.original].sort((a, b) => a.x - b.x)
  const shifted = [...input.shifted].sort((a, b) => a.x - b.x)
  const comparisons = original.flatMap((point) => {
    if (point.x < input.first_pulse_delay_ms) return []
    const shifted_y = interpolatePoints(shifted, point.x + input.shift_ms)
    return shifted_y === undefined ? [] : [{ expected: point.y, actual: shifted_y }]
  })
  if (comparisons.length < 3) {
    return {
      passed: false,
      normalized_rmse: Number.POSITIVE_INFINITY,
      normalized_max_error: Number.POSITIVE_INFINITY,
      compared_points: comparisons.length,
    }
  }
  const expected_values = comparisons.map(({ expected }) => expected)
  const span = Math.max(
    Math.max(...expected_values) - Math.min(...expected_values),
    Math.max(...expected_values.map((value) => Math.abs(value))) * 0.05,
    1e-9,
  )
  const errors = comparisons.map(({ expected, actual }) => Math.abs(expected - actual))
  const normalized_rmse =
    Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / errors.length) / span
  const normalized_max_error = Math.max(...errors) / span
  return {
    passed: normalized_rmse <= 0.05 && normalized_max_error <= 0.15,
    normalized_rmse,
    normalized_max_error,
    compared_points: comparisons.length,
  }
}

export function parseResultCsv(text: string): TimeShiftPoint[] {
  return text
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .flatMap((line) => {
      const [raw_x, raw_y] = line.split(",")
      const x = Number(raw_x)
      const y = Number(raw_y)
      return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : []
    })
}

export interface AbsoluteTimeShiftValidation {
  required: boolean
  passed: boolean
  benchmark_id?: string
  shift_ms?: number
  normalized_rmse?: number
  normalized_max_error?: number
  error_message?: string
}

export async function validateAbsoluteTimeShift(input: {
  job_dir: string
  model_dir: string
  tsci_bin: string
  signal: AbortSignal
  append: (stream: JobLogStream, message: string) => Promise<void>
  shift_ratio?: number
}): Promise<AbsoluteTimeShiftValidation> {
  const model_source = await readFile(join(input.model_dir, "model.lib"), "utf8")
  if (!modelUsesAbsoluteTime(model_source)) {
    await input.append(
      "system",
      "Absolute-TIME gate was not triggered; skipping the extra stimulus-shift simulation.\n",
    )
    return { required: false, passed: true }
  }

  const benchmark_files = await listModelBenchFiles(input.model_dir)
  const candidates: Array<{
    benchmark_id: string
    benchmark_file: string
    source: string
    duration_ms: number
  }> = []
  for (const benchmark_file of benchmark_files) {
    const source = await readFile(join(input.model_dir, "benchmarks", benchmark_file), "utf8")
    const probe = shiftLiteralPulseDelays(source, 0.001)
    if (!probe) continue
    candidates.push({
      benchmark_id: benchmark_file.replace(/\.circuit\.tsx$/i, ""),
      benchmark_file,
      source,
      duration_ms: probe.original_duration_ms,
    })
  }
  if (candidates.length === 0) {
    return {
      required: true,
      passed: false,
      error_message:
        "model.lib uses absolute TIME, but no locked benchmark has a literal pulseDelay that the server can shift",
    }
  }

  const candidate = candidates[randomInt(candidates.length)]!
  const shift_ratio = input.shift_ratio ?? 0.11 + randomInt(0, 7_001) / 100_000
  const shifted = shiftLiteralPulseDelays(candidate.source, candidate.duration_ms * shift_ratio)!
  const source_root = join(input.model_dir, "server-time-shift")
  const source_path = join(source_root, candidate.benchmark_file)
  const generated_root = join(input.job_dir, "dist", "spice", "server-time-shift", candidate.benchmark_id)
  const generated_path = join(generated_root, "circuit.json")
  const saved_root = join(input.model_dir, "validation-artifacts", ".time-shift")
  const saved_path = join(saved_root, candidate.benchmark_id, "circuit.json")

  await input.append(
    "system",
    `Absolute-TIME gate triggered after nominal validation; shifting ${candidate.benchmark_id} stimuli by ${shifted.shift_ms.toFixed(6)} ms for one causal check.\n`,
  )
  try {
    await mkdir(dirname(source_path), { recursive: true })
    await Bun.write(source_path, shifted.source)
    const build = await executeValidationBuild({
      benchmark_file: `${candidate.benchmark_file} (hidden stimulus shift)`,
      run: {
        run_id: "time-shift",
        source_path,
        generated_path,
        saved_path,
      },
      model_dir: input.model_dir,
      signal: input.signal,
      tsci_bin: input.tsci_bin,
      append: input.append,
    })
    if (build.exit_code !== 0 || !build.path) {
      return {
        required: true,
        passed: false,
        benchmark_id: candidate.benchmark_id,
        shift_ms: shifted.shift_ms,
        error_message: build.error_message ?? "shifted benchmark did not produce simulator output",
      }
    }

    const definitions = await readSimulationDefinitions(input.model_dir, candidate.benchmark_id)
    const definition = definitions.find((entry) => entry.role === "response")!
    const shifted_circuit: unknown = JSON.parse(await readFile(build.path, "utf8"))
    const shifted_points = extractSimulationResultPoints(shifted_circuit, definition)
    const original_points = parseResultCsv(
      await readFile(
        definitions.length === 1 && definition.series_id === "result"
          ? join(getVerifiedResultsDirectory(input.model_dir), `${candidate.benchmark_id}.csv`)
          : join(
              getVerifiedResultsDirectory(input.model_dir),
              candidate.benchmark_id,
              `${definition.series_id}.csv`,
            ),
        "utf8",
      ),
    )
    const comparison = compareTimeShiftedResults({
      original: original_points,
      shifted: shifted_points,
      shift_ms: shifted.shift_ms,
      first_pulse_delay_ms: shifted.first_pulse_delay_ms,
    })
    return {
      required: true,
      passed: comparison.passed,
      benchmark_id: candidate.benchmark_id,
      shift_ms: shifted.shift_ms,
      normalized_rmse: comparison.normalized_rmse,
      normalized_max_error: comparison.normalized_max_error,
      ...(comparison.passed
        ? {}
        : {
            error_message: `output did not follow the shifted stimulus (NRMSE ${comparison.normalized_rmse.toFixed(4)}, max ${comparison.normalized_max_error.toFixed(4)})`,
          }),
    }
  } finally {
    await Promise.all([
      rm(source_root, { recursive: true, force: true }),
      rm(generated_root, { recursive: true, force: true }),
      rm(saved_root, { recursive: true, force: true }),
    ])
  }
}
