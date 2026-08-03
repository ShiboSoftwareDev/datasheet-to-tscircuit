import type { ViewerSimulationValidation } from "../modeling"
import type {
  ValidationCaseResult,
  ValidationObservation,
  ValidationPlan,
  ValidationSeriesPoint,
  ValidationSeriesResult,
} from "../spice-validation"
import type { ModelContract } from "../modeling"

const MAX_REPORTED_SAMPLES = 48

export interface ModelTrainingValidationSample {
  readonly x: number
  readonly reference_y: number
  readonly simulated_y?: number
  readonly error?: number
}

export interface ModelTrainingValidationSeriesReport {
  readonly observation_id: string
  readonly status: "passed" | "failed"
  readonly metrics: ValidationSeriesResult["metrics"]
  readonly samples: readonly ModelTrainingValidationSample[]
  readonly error_codes: readonly string[]
}

export interface ModelTrainingValidationCaseReport {
  readonly case_id: string
  readonly status: "passed" | "failed"
  readonly server_series: readonly ModelTrainingValidationSeriesReport[]
  readonly viewer_series: readonly ModelTrainingValidationSeriesReport[]
  readonly error_codes: readonly string[]
}

export interface ModelTrainingValidationReport {
  readonly version: 1
  readonly status: "passed" | "failed"
  readonly cases: readonly ModelTrainingValidationCaseReport[]
  readonly error_codes: readonly string[]
}

/**
 * Produces the model-agent validation plan from the immutable server plan.
 * Fixture topology stays exact, while curve comparisons contain only the
 * samples already present in the agent-visible training contract.
 */
export function createModelTrainingValidationPlan(input: {
  plan: ValidationPlan
  training_contract: ModelContract
}): ValidationPlan {
  // Both inputs are persisted JSON contracts. A JSON round trip deliberately
  // drops runtime-only metadata and produces an agent-workspace-safe value.
  const cloned_plan = JSON.parse(JSON.stringify(input.plan)) as ValidationPlan
  const requirement_by_id = new Map(
    input.training_contract.characterization.requirements.map((requirement) => [
      requirement.requirement_id,
      requirement,
    ]),
  )
  return {
    ...cloned_plan,
    cases: cloned_plan.cases.map((validation_case) => ({
      ...validation_case,
      observations: validation_case.observations.map((observation) => {
        if (observation.reference.type !== "curve") return observation
        const training_curve = requirement_by_id.get(observation.requirement_id)?.reference_curve
        if (!training_curve) {
          throw new Error(`Training contract has no reference curve for ${observation.requirement_id}`)
        }
        return {
          ...observation,
          reference: {
            ...observation.reference,
            points: training_curve.points.map(({ x, y }) => ({ x, y })),
          },
        }
      }),
    })),
  }
}

function interpolate(points: readonly ValidationSeriesPoint[], x: number): number | undefined {
  if (points.length === 0) return undefined
  const ordered = [...points].sort((a, b) => a.x - b.x)
  const first = ordered[0]
  const last = ordered.at(-1)
  if (!first || !last || x < first.x || x > last.x) return undefined
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]
    if (!current) return undefined
    if (current.x === x) return current.y
    const next = ordered[index + 1]
    if (!next || x > next.x) continue
    const fraction = (x - current.x) / (next.x - current.x)
    return current.y + fraction * (next.y - current.y)
  }
  return undefined
}

function evenlyBounded<T>(values: readonly T[]): readonly T[] {
  if (values.length <= MAX_REPORTED_SAMPLES) return values
  return Array.from({ length: MAX_REPORTED_SAMPLES }, (_, index) => {
    const source_index = Math.round((index * (values.length - 1)) / (MAX_REPORTED_SAMPLES - 1))
    return values[source_index]!
  })
}

function samplesForObservation(
  observation: ValidationObservation,
  series: ValidationSeriesResult,
): readonly ModelTrainingValidationSample[] {
  if (observation.reference.type === "curve") {
    return evenlyBounded(observation.reference.points).map(({ x, y: reference_y }) => {
      const simulated_y = interpolate(series.points, x)
      return {
        x,
        reference_y,
        ...(simulated_y === undefined ? {} : { simulated_y, error: simulated_y - reference_y }),
      }
    })
  }
  const reference_y =
    observation.reference.type === "target"
      ? observation.reference.target
      : (observation.reference.min ?? observation.reference.max ?? 0)
  return evenlyBounded(series.points).map(({ x, y: simulated_y }) => ({
    x,
    reference_y,
    simulated_y,
    error: simulated_y - reference_y,
  }))
}

function reportSeries(
  observations: readonly ValidationObservation[],
  series: readonly ValidationSeriesResult[],
): readonly ModelTrainingValidationSeriesReport[] {
  const observation_by_id = new Map(observations.map((observation) => [observation.id, observation]))
  return series.map((entry) => {
    const observation = observation_by_id.get(entry.observation_id)
    return {
      observation_id: entry.observation_id,
      status: entry.passed ? "passed" : "failed",
      metrics: { ...entry.metrics },
      samples: observation ? samplesForObservation(observation, entry) : [],
      error_codes: entry.errors.map(({ code }) => code),
    }
  })
}

/**
 * Converts public-training server/viewer results into bounded numeric feedback.
 * Every reference sample in this report was already visible to the model agent;
 * private causality results and withheld samples are never accepted here.
 */
export function createModelTrainingValidationReport(input: {
  plan: ValidationPlan
  server_cases: readonly ValidationCaseResult[]
  server_passed: boolean
  server_error_codes?: readonly string[]
  viewer_validation_by_case?: Readonly<Record<string, ViewerSimulationValidation | undefined>>
  viewer_errors_by_case?: Readonly<Record<string, string | undefined>>
  viewer_model_errors_by_case?: Readonly<Record<string, string | undefined>>
}): ModelTrainingValidationReport {
  const server_case_by_id = new Map(input.server_cases.map((entry) => [entry.case_id, entry]))
  const cases = input.plan.cases.map((validation_case): ModelTrainingValidationCaseReport => {
    const server_case = server_case_by_id.get(validation_case.id)
    const viewer = input.viewer_validation_by_case?.[validation_case.id]
    const viewer_error = input.viewer_errors_by_case?.[validation_case.id]
    const viewer_model_error = input.viewer_model_errors_by_case?.[validation_case.id]
    const server_series = server_case ? reportSeries(validation_case.observations, server_case.series) : []
    const viewer_series = viewer ? reportSeries(validation_case.observations, viewer.series) : []
    const error_codes = [
      ...(server_case?.errors.map(({ code }) => code) ?? []),
      ...(viewer?.errors.map(({ code }) => code) ?? []),
      ...(viewer_model_error
        ? ["viewer_simulation_failed"]
        : viewer_error && !viewer
          ? ["viewer_validation_unavailable"]
          : []),
    ]
    const passed =
      server_case?.status === "passed" &&
      viewer?.simulation_valid === true &&
      viewer.passed === true &&
      !viewer_error
    return {
      case_id: validation_case.id,
      status: passed ? "passed" : "failed",
      server_series,
      viewer_series,
      error_codes: [...new Set(error_codes)],
    }
  })
  const error_codes = [
    ...(input.server_error_codes ?? []),
    ...cases.flatMap((validation_case) => validation_case.error_codes),
  ]
  const passed = input.server_passed && cases.every(({ status }) => status === "passed")
  return {
    version: 1,
    status: passed ? "passed" : "failed",
    cases,
    error_codes: [...new Set(error_codes)],
  }
}
