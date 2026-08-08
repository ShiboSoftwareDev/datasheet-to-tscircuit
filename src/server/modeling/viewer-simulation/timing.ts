import type {
  ValidationCase,
  ValidationExecutionError,
  ValidationSeriesPoint,
} from "../../spice-validation/types"
import { simulatorError } from "./errors"
import type { CircuitRecord } from "./types"

function millisecondsApproximatelyEqual(actual: unknown, expected: number): boolean {
  if (typeof actual !== "number" || !Number.isFinite(actual)) return false
  const tolerance = Math.max(1e-9, Math.abs(expected) * 1e-9)
  return Math.abs(actual - expected) <= tolerance
}

/**
 * circuit-json-to-spice currently serializes transient values with six
 * significant digits before ngspice sees them. The experiment record retains
 * the original value, while graph metadata is reconstructed from that
 * serialized netlist. Keep the plan-to-experiment check strict and allow only
 * the maximum rounding error introduced at this graph boundary.
 */
function spiceSerializedMillisecondsApproximatelyEqual(actual: unknown, expected: number): boolean {
  if (typeof actual !== "number" || !Number.isFinite(actual)) return false
  const tolerance = Math.max(1e-9, Math.abs(expected) * 5e-6)
  return Math.abs(actual - expected) <= tolerance
}

function expectedTransientTimestamps(input: {
  start_ms: number
  step_ms: number
  stop_ms: number
}): number[] {
  const duration = input.stop_ms - input.start_ms
  const regular_sample_count = Math.floor(duration / input.step_ms + 1e-9) + 1
  const timestamps = Array.from({ length: regular_sample_count }, (_, index) =>
    Math.min(input.stop_ms, input.start_ms + index * input.step_ms),
  )
  const last = timestamps.at(-1)
  if (last === undefined || !millisecondsApproximatelyEqual(last, input.stop_ms)) {
    timestamps.push(input.stop_ms)
  }
  return timestamps
}

function redundantTerminalSampleIndex(
  timestamps_ms: readonly unknown[],
  expected_ms: readonly number[],
): number | undefined {
  if (timestamps_ms.length !== expected_ms.length + 1 || expected_ms.length < 2) return undefined
  const penultimate_index = timestamps_ms.length - 2
  const terminal_index = timestamps_ms.length - 1
  if (
    !timestamps_ms
      .slice(0, penultimate_index)
      .every((timestamp, index) => millisecondsApproximatelyEqual(timestamp, expected_ms[index]!)) ||
    !millisecondsApproximatelyEqual(timestamps_ms[penultimate_index], expected_ms.at(-1)!) ||
    !millisecondsApproximatelyEqual(timestamps_ms[terminal_index], expected_ms.at(-1)!)
  ) {
    return undefined
  }
  const penultimate = timestamps_ms[penultimate_index]
  const terminal = timestamps_ms[terminal_index]
  if (
    typeof penultimate !== "number" ||
    typeof terminal !== "number" ||
    !Number.isFinite(penultimate) ||
    !Number.isFinite(terminal) ||
    terminal <= penultimate
  ) {
    return undefined
  }
  return penultimate_index
}

export function normalizeTransientBoundaryPoint(
  validation_case: ValidationCase,
  points: ValidationSeriesPoint[],
  graph: CircuitRecord,
): ValidationSeriesPoint[] {
  if (validation_case.analysis.type !== "transient") return points
  const start_ms = graph.start_time_ms
  const step_ms = graph.time_per_step
  const stop_ms = graph.end_time_ms
  if (
    typeof start_ms !== "number" ||
    !Number.isFinite(start_ms) ||
    typeof step_ms !== "number" ||
    !Number.isFinite(step_ms) ||
    typeof stop_ms !== "number" ||
    !Number.isFinite(stop_ms)
  ) {
    return points
  }
  const expected_ms = expectedTransientTimestamps({
    start_ms,
    step_ms,
    stop_ms,
  })
  const redundant_index = redundantTerminalSampleIndex(
    points.map(({ x }) => x * 1_000),
    expected_ms,
  )
  return redundant_index === undefined ? points : points.filter((_, index) => index !== redundant_index)
}

export function validateTransientExperimentTiming(input: {
  validation_case: ValidationCase
  experiment: CircuitRecord
}): ValidationExecutionError[] {
  if (input.validation_case.analysis.type !== "transient") return []
  const analysis = input.validation_case.analysis
  const expected_start_ms = (analysis.start ?? 0) * 1_000
  const expected_step_ms = analysis.step * 1_000
  const expected_stop_ms = analysis.stop * 1_000
  const start_matches =
    analysis.start === undefined
      ? input.experiment.start_time_ms === undefined ||
        millisecondsApproximatelyEqual(input.experiment.start_time_ms, expected_start_ms)
      : millisecondsApproximatelyEqual(input.experiment.start_time_ms, expected_start_ms)
  if (
    !start_matches ||
    !millisecondsApproximatelyEqual(input.experiment.time_per_step, expected_step_ms) ||
    !millisecondsApproximatelyEqual(input.experiment.end_time_ms, expected_stop_ms)
  ) {
    return [
      simulatorError(
        "viewer_transient_experiment_timing_mismatch",
        `Transient experiment ${input.validation_case.id} does not retain the planned start (${expected_start_ms} ms), step (${expected_step_ms} ms), and stop (${expected_stop_ms} ms) metadata`,
        "analysis",
      ),
    ]
  }
  return []
}

export function validateTransientGraphTiming(input: {
  validation_case: ValidationCase
  observation_id: string
  graph: CircuitRecord
}): ValidationExecutionError[] {
  if (input.validation_case.analysis.type !== "transient") return []
  const analysis = input.validation_case.analysis
  const expected_start_ms = (analysis.start ?? 0) * 1_000
  const expected_step_ms = analysis.step * 1_000
  const expected_stop_ms = analysis.stop * 1_000
  const path = `observations.${input.observation_id}`
  if (
    !spiceSerializedMillisecondsApproximatelyEqual(input.graph.start_time_ms, expected_start_ms) ||
    !spiceSerializedMillisecondsApproximatelyEqual(input.graph.time_per_step, expected_step_ms) ||
    !spiceSerializedMillisecondsApproximatelyEqual(input.graph.end_time_ms, expected_stop_ms)
  ) {
    return [
      simulatorError(
        "viewer_waveform_timing_mismatch",
        `Waveform ${input.observation_id} does not retain the planned start, step, and stop metadata`,
        path,
      ),
    ]
  }
  const graph_start_ms = input.graph.start_time_ms as number
  const graph_step_ms = input.graph.time_per_step as number
  const graph_stop_ms = input.graph.end_time_ms as number
  const timestamps = input.graph.timestamps_ms
  if (!Array.isArray(timestamps)) return []
  const expected = expectedTransientTimestamps({
    start_ms: graph_start_ms,
    step_ms: graph_step_ms,
    stop_ms: graph_stop_ms,
  })
  const exact_coverage =
    timestamps.length === expected.length &&
    timestamps.every((timestamp, index) => millisecondsApproximatelyEqual(timestamp, expected[index]!))
  if (!exact_coverage && redundantTerminalSampleIndex(timestamps, expected) === undefined) {
    return [
      simulatorError(
        "viewer_waveform_coverage_mismatch",
        `Waveform ${input.observation_id} has ${timestamps.length} samples but does not exactly cover the planned ${expected_start_ms} ms to ${expected_stop_ms} ms interval at ${expected_step_ms} ms steps`,
        path,
      ),
    ]
  }
  return []
}
