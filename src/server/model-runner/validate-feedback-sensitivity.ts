import { mkdir, readFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { JobLogStream } from "@/shared/job-types"
import { type ExpectedApplicationConnection } from "../job-artifact-validator"
import { parseTypicalApplicationPlan, type TypicalApplicationPlan } from "../job-runner"
import {
  extractSimulationResultPoints,
  getVerifiedResultsDirectory,
  readSimulationDefinitions,
} from "../model-simulation-validator"
import { inferApplicationDutReference } from "./get-benchmark-application-plan"
import { TimeShiftPoint, parseResultCsv } from "./validate-absolute-time-shift"
import { listModelBenchFiles } from "./list-model-bench-files"
import { executeValidationBuild } from "./validate-champion"

const RESISTANCE_PREFIX: Record<string, number> = {
  "": 1,
  m: 1e-3,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
}

function parseResistanceOhms(value: string | undefined): number | undefined {
  if (!value) return undefined
  const match = value
    .trim()
    .replace(/\s+/g, "")
    .replace(/ohms?|Ω/gi, "")
    .match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([mkKMG]?)$/)
  if (!match) return undefined
  const amount = Number(match[1])
  const multiplier = RESISTANCE_PREFIX[match[2] ?? ""]
  return Number.isFinite(amount) && multiplier !== undefined ? amount * multiplier : undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function shiftNamedResistorResistance(input: {
  source: string
  reference: string
  ratio: number
}): { source: string; original_ohms: number; shifted_ohms: number } | undefined {
  const { source, reference, ratio } = input
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error("resistance shift ratio must be positive")
  const tag_pattern = new RegExp(`<resistor\\b(?=[^>]*\\bname=["']${escapeRegExp(reference)}["'])[^>]*>`, "i")
  const tag = source.match(tag_pattern)?.[0]
  if (!tag) return undefined
  const resistance_match = tag.match(/\bresistance\s*=\s*(["'])([^"']+)\1/i)
  const original_ohms = parseResistanceOhms(resistance_match?.[2])
  if (!resistance_match || original_ohms === undefined) return undefined
  const shifted_ohms = original_ohms * ratio
  const shifted_tag = tag.replace(
    resistance_match[0],
    `resistance="${Number(shifted_ohms.toPrecision(12))}ohm"`,
  )
  return {
    source: source.replace(tag, shifted_tag),
    original_ohms,
    shifted_ohms,
  }
}

interface FeedbackDivider {
  top_reference: string
  bottom_reference: string
  top_ohms: number
  bottom_ohms: number
}

function findFeedbackDivider(plan: TypicalApplicationPlan): FeedbackDivider | undefined {
  const dut_reference = inferApplicationDutReference(plan)
  const find_dut_connection = (pattern: RegExp) =>
    plan.connections.find((connection) =>
      connection.pins.some((endpoint) => {
        const separator = endpoint.indexOf(".")
        return (
          endpoint.slice(0, separator).toLowerCase() === dut_reference.toLowerCase() &&
          pattern.test(endpoint.slice(separator + 1))
        )
      }),
    )
  const feedback = find_dut_connection(/^(?:fb|feedback)$/i)
  const output = find_dut_connection(/^(?:v?out|output)$/i)
  const ground =
    plan.connections.find((connection) => /^(?:gnd|ground|agnd)$/i.test(connection.net)) ??
    find_dut_connection(/^(?:gnd|ground|agnd)$/i)
  if (!feedback || !output || !ground) return undefined
  const resistor_components = plan.components.filter(
    (component) => component.value && /resistor/i.test(component.kind),
  )
  const has_reference = (connection: ExpectedApplicationConnection, reference: string) =>
    connection.pins.some(
      (endpoint) => endpoint.slice(0, endpoint.indexOf(".")).toLowerCase() === reference.toLowerCase(),
    )
  const top = resistor_components.find(
    (component) => has_reference(feedback, component.reference) && has_reference(output, component.reference),
  )
  const bottom = resistor_components.find(
    (component) => has_reference(feedback, component.reference) && has_reference(ground, component.reference),
  )
  const top_ohms = parseResistanceOhms(top?.value)
  const bottom_ohms = parseResistanceOhms(bottom?.value)
  return top && bottom && top_ohms !== undefined && bottom_ohms !== undefined
    ? {
        top_reference: top.reference,
        bottom_reference: bottom.reference,
        top_ohms,
        bottom_ohms,
      }
    : undefined
}

function tailMean(points: TimeShiftPoint[]): number | undefined {
  if (points.length < 3) return undefined
  const sorted = [...points].sort((left, right) => left.x - right.x)
  const start = sorted[0]!.x + (sorted.at(-1)!.x - sorted[0]!.x) * 0.7
  const tail = sorted.filter((point) => point.x >= start).map((point) => point.y)
  return tail.length >= 3 ? tail.reduce((sum, value) => sum + value, 0) / tail.length : undefined
}

export interface FeedbackSensitivityValidation {
  required: boolean
  passed: boolean
  benchmark_id?: string
  expected_ratio?: number
  actual_ratio?: number
  error_message?: string
}

export async function validateFeedbackSensitivity(input: {
  job_dir: string
  model_dir: string
  tsci_bin: string
  signal: AbortSignal
  append: (stream: JobLogStream, message: string) => Promise<void>
  resistance_ratio?: number
}): Promise<FeedbackSensitivityValidation> {
  const application_plan_path = join(input.model_dir, "typical-application-plan.json")
  if (!(await Bun.file(application_plan_path).exists())) {
    await input.append(
      "system",
      "No typical-application plan is available for this legacy job; skipping feedback-sensitivity validation.\n",
    )
    return { required: false, passed: true }
  }
  const plan = parseTypicalApplicationPlan(JSON.parse(await readFile(application_plan_path, "utf8")))
  const divider = findFeedbackDivider(plan)
  if (!divider) {
    await input.append(
      "system",
      "No external feedback divider was found; skipping feedback-sensitivity validation.\n",
    )
    return { required: false, passed: true }
  }
  const resistance_ratio = input.resistance_ratio ?? 1.05
  const benchmark_files = await listModelBenchFiles(input.model_dir)
  let selected:
    | {
        benchmark_id: string
        benchmark_file: string
        shifted_source: string
        series_id: string
        legacy_result: boolean
      }
    | undefined
  for (const benchmark_file of benchmark_files) {
    const source = await readFile(join(input.model_dir, "benchmarks", benchmark_file), "utf8")
    const shifted = shiftNamedResistorResistance({
      source,
      reference: divider.top_reference,
      ratio: resistance_ratio,
    })
    if (!shifted) continue
    const benchmark_id = benchmark_file.replace(/\.circuit\.tsx$/i, "")
    const definitions = await readSimulationDefinitions(input.model_dir, benchmark_id)
    const primary = definitions.find((definition) => definition.role === "response")
    if (!primary) continue
    const legacy_result = definitions.length === 1 && primary.series_id === "result"
    const verified_result = legacy_result
      ? join(getVerifiedResultsDirectory(input.model_dir), `${benchmark_id}.csv`)
      : join(getVerifiedResultsDirectory(input.model_dir), benchmark_id, `${primary.series_id}.csv`)
    if (!(await Bun.file(verified_result).exists())) {
      continue
    }
    selected = {
      benchmark_id,
      benchmark_file,
      shifted_source: shifted.source,
      series_id: primary.series_id,
      legacy_result,
    }
    break
  }
  if (!selected) {
    return {
      required: true,
      passed: false,
      error_message: `no verified benchmark preserves feedback resistor ${divider.top_reference}`,
    }
  }

  const source_root = join(input.model_dir, "server-feedback-sensitivity")
  const source_path = join(source_root, selected.benchmark_file)
  const generated_root = join(
    input.job_dir,
    "dist",
    "spice",
    "server-feedback-sensitivity",
    selected.benchmark_id,
  )
  const saved_root = join(input.model_dir, "validation-artifacts", ".feedback-sensitivity")
  const saved_path = join(saved_root, selected.benchmark_id, "circuit.json")
  const original_ratio = 1 + divider.top_ohms / divider.bottom_ohms
  const shifted_ratio = 1 + (divider.top_ohms * resistance_ratio) / divider.bottom_ohms
  const expected_ratio = shifted_ratio / original_ratio
  await input.append(
    "system",
    `Nominal validation passed; perturbing ${divider.top_reference} by ${((resistance_ratio - 1) * 100).toFixed(1)}% in ${selected.benchmark_id} for one hidden feedback-sensitivity check.\n`,
  )
  try {
    await mkdir(dirname(source_path), { recursive: true })
    await Bun.write(source_path, selected.shifted_source)
    const build = await executeValidationBuild({
      benchmark_file: `${selected.benchmark_file} (hidden feedback sensitivity)`,
      run: {
        run_id: "feedback-sensitivity",
        source_path,
        generated_path: join(generated_root, "circuit.json"),
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
        benchmark_id: selected.benchmark_id,
        expected_ratio,
        error_message: build.error_message ?? "feedback-shifted benchmark produced no simulator output",
      }
    }
    const definitions = await readSimulationDefinitions(input.model_dir, selected.benchmark_id)
    const definition = definitions.find((candidate) => candidate.series_id === selected.series_id)!
    const shifted_points = extractSimulationResultPoints(
      JSON.parse(await readFile(build.path, "utf8")),
      definition,
    )
    const original_points = parseResultCsv(
      await readFile(
        selected.legacy_result
          ? join(getVerifiedResultsDirectory(input.model_dir), `${selected.benchmark_id}.csv`)
          : join(
              getVerifiedResultsDirectory(input.model_dir),
              selected.benchmark_id,
              `${selected.series_id}.csv`,
            ),
        "utf8",
      ),
    )
    const original_mean = tailMean(original_points)
    const shifted_mean = tailMean(shifted_points)
    if (original_mean === undefined || shifted_mean === undefined || Math.abs(original_mean) < 0.1) {
      return {
        required: true,
        passed: false,
        benchmark_id: selected.benchmark_id,
        expected_ratio,
        error_message: "feedback-sensitivity check could not measure a stable output tail",
      }
    }
    const actual_ratio = shifted_mean / original_mean
    const expected_delta = expected_ratio - 1
    const actual_delta = actual_ratio - 1
    const passed =
      Math.sign(actual_delta) === Math.sign(expected_delta) &&
      Math.abs(actual_delta) >= Math.abs(expected_delta) * 0.4 &&
      Math.abs(actual_delta) <= Math.abs(expected_delta) * 2.5
    return {
      required: true,
      passed,
      benchmark_id: selected.benchmark_id,
      expected_ratio,
      actual_ratio,
      ...(passed
        ? {}
        : {
            error_message: `output ratio ${actual_ratio.toFixed(5)} did not follow expected feedback ratio ${expected_ratio.toFixed(5)}`,
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
