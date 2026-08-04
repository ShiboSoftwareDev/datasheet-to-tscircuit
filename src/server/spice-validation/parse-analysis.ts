import { IDENTIFIER_PATTERN } from "./identifiers"
import type { ValidationCollector } from "./parse-helpers"
import type { ValidationAnalysis } from "./types"

export const MAX_VALIDATION_POINTS_PER_CASE = 20_000

function validatePointBudget(input: {
  start: number
  stop: number
  step: number
  path: string
  collector: ValidationCollector
}): void {
  if (!Number.isFinite(input.start) || !Number.isFinite(input.stop) || !Number.isFinite(input.step)) {
    return
  }
  const span = Math.abs(input.stop - input.start)
  const step = Math.abs(input.step)
  if (span === 0 || step === 0) return
  const estimated_points = Math.ceil(span / step) + 1
  if (!Number.isFinite(estimated_points) || estimated_points > MAX_VALIDATION_POINTS_PER_CASE) {
    input.collector.add(
      input.path,
      "analysis_point_limit_exceeded",
      `would request about ${Number.isFinite(estimated_points) ? estimated_points : "an unbounded number of"} points; the limit is ${MAX_VALIDATION_POINTS_PER_CASE}`,
    )
  }
}

export function parseAnalysis(
  value: unknown,
  path: string,
  collector: ValidationCollector,
): ValidationAnalysis {
  const record = collector.record(value, path)
  const type = collector.string(record.type, `${path}.type`)
  if (type === "operating_point") {
    collector.rejectUnknownKeys(record, ["type"], path)
    return { type }
  }
  if (type === "dc_sweep") {
    collector.rejectUnknownKeys(record, ["type", "source_id", "start", "stop", "step"], path)
    const source_id = collector.string(record.source_id, `${path}.source_id`)
    if (source_id && !IDENTIFIER_PATTERN.test(source_id)) {
      collector.add(`${path}.source_id`, "invalid_identifier", "must be a stable fixture identifier")
    }
    const start = collector.finite(record.start, `${path}.start`)
    const stop = collector.finite(record.stop, `${path}.stop`)
    const step = collector.finite(record.step, `${path}.step`)
    if (typeof record.start === "number" && typeof record.stop === "number" && start === stop) {
      collector.add(path, "empty_sweep", "start and stop must differ")
    }
    if (typeof record.step === "number" && Number.isFinite(step) && step === 0) {
      collector.add(`${path}.step`, "out_of_range", "must not be zero")
    }
    if (
      Number.isFinite(start) &&
      Number.isFinite(stop) &&
      Number.isFinite(step) &&
      start !== stop &&
      step !== 0 &&
      Math.sign(stop - start) !== Math.sign(step)
    ) {
      collector.add(`${path}.step`, "invalid_sweep_direction", "must move from start toward stop")
    }
    if (Math.abs(step) > Math.abs(stop - start) && start !== stop) {
      collector.add(`${path}.step`, "out_of_range", "must not exceed the sweep range")
    }
    validatePointBudget({ start, stop, step, path, collector })
    return { type, source_id, start, stop, step }
  }
  if (type === "transient") {
    collector.rejectUnknownKeys(record, ["type", "step", "stop", "start"], path)
    const step = collector.positive(record.step, `${path}.step`)
    const stop = collector.positive(record.stop, `${path}.stop`)
    const start =
      record.start === undefined ? undefined : collector.nonNegative(record.start, `${path}.start`)
    if (start !== undefined && Number.isFinite(start) && Number.isFinite(stop) && start >= stop) {
      collector.add(`${path}.start`, "out_of_range", "must be less than stop")
    }
    const duration = stop - (start ?? 0)
    if (Number.isFinite(step) && Number.isFinite(duration) && duration > 0 && step > duration) {
      collector.add(`${path}.step`, "out_of_range", "must not exceed the simulated duration")
    }
    validatePointBudget({ start: start ?? 0, stop, step, path, collector })
    return { type, step, stop, ...(start === undefined ? {} : { start }) }
  }
  collector.add(`${path}.type`, "unsupported_analysis", "must be operating_point, dc_sweep, or transient")
  return { type: "operating_point" }
}
