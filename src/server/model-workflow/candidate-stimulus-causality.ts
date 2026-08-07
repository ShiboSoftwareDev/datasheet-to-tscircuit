import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ModelManifest } from "@/shared/job-types"
import type { ModelContract, ModelReferenceElectricalBinding } from "../modeling"
import {
  hashValidationInputs,
  runSpiceValidation,
  type NgspiceExecutor,
  type ValidationCase,
  type ValidationPlan,
  type ValidationRunResult,
  type ValidationSeriesResult,
  type ValidationStimulusCausalityReceipt,
} from "../spice-validation"

const MIN_NORMALIZED_MAX_DIFFERENCE = 0.5
const MIN_DYNAMIC_NORMALIZED_RMS_DIFFERENCE = 0.35
const MIN_DYNAMIC_POINT_DIFFERENCE = 0.25
const MIN_DYNAMIC_POINT_COVERAGE = 0.75
const MIN_REFERENCE_DYNAMIC_DEVIATION = 0.15
const MIN_REFERENCE_LOCAL_CHANGE = 0.05
const COORDINATE_RELATIVE_TOLERANCE = 1e-9
const COORDINATE_ABSOLUTE_TOLERANCE = 1e-15

export type CandidateStimulusCausalityCheck =
  | { required: false; passed: true }
  | {
      required: true
      passed: true
      receipt: ValidationStimulusCausalityReceipt
    }
  | {
      required: true
      passed: false
      affected_case_count: number
      affected_observation_count: number
    }

function bindingForRequirement(
  contract: ModelContract,
  requirement_id: string,
): ModelReferenceElectricalBinding | undefined {
  return contract.characterization.requirements.find(
    (requirement) =>
      requirement.requirement_id === requirement_id && requirement.support.status === "modeled",
  )?.reference_curve?.electrical_binding
}

function sourceMatchesBinding(
  fixture: ValidationCase["fixtures"][number],
  binding: ModelReferenceElectricalBinding,
): boolean {
  if (binding.stimulus.type === "steady_state") return false
  const source_type = binding.stimulus.type === "voltage_step" ? "voltage_source" : "current_source"
  return (
    fixture.type === source_type &&
    fixture.positive === binding.stimulus.positive &&
    fixture.negative === binding.stimulus.negative &&
    fixture.pulse !== undefined
  )
}

function flattenBoundPulses(input: { plan: ValidationPlan; contract: ModelContract }): {
  plan: ValidationPlan
  relevant_observation_ids_by_case: ReadonlyMap<string, ReadonlySet<string>>
} {
  const relevant_observation_ids_by_case = new Map<string, ReadonlySet<string>>()
  const cases = input.plan.cases.map((validation_case) => {
    const bindings = validation_case.requirement_ids.flatMap((requirement_id) => {
      const binding = bindingForRequirement(input.contract, requirement_id)
      return binding ? [binding] : []
    })
    if (bindings.length === 0) return validation_case
    const relevant_observation_ids = new Set(
      validation_case.observations.flatMap((observation) =>
        observation.role !== "stimulus" && bindingForRequirement(input.contract, observation.requirement_id)
          ? [observation.id]
          : [],
      ),
    )
    relevant_observation_ids_by_case.set(validation_case.id, relevant_observation_ids)
    return {
      ...validation_case,
      fixtures: validation_case.fixtures.map((fixture) => {
        if (
          (fixture.type !== "voltage_source" && fixture.type !== "current_source") ||
          !fixture.pulse ||
          !bindings.some((binding) => sourceMatchesBinding(fixture, binding))
        ) {
          return fixture
        }
        return { ...fixture, pulse: { ...fixture.pulse, high: fixture.pulse.low } }
      }),
    }
  })
  return { plan: { ...input.plan, cases }, relevant_observation_ids_by_case }
}

function contractWithoutElectricalBindings(contract: ModelContract): ModelContract {
  return {
    ...contract,
    characterization: {
      ...contract.characterization,
      requirements: contract.characterization.requirements.map((requirement) =>
        requirement.reference_curve
          ? {
              ...requirement,
              reference_curve: {
                ...requirement.reference_curve,
                electrical_binding: undefined,
              },
            }
          : requirement,
      ),
    },
  }
}

function indexSeries(result: ValidationRunResult): ReadonlyMap<string, ValidationSeriesResult> {
  return new Map(
    result.cases.flatMap((validation_case) =>
      validation_case.series.map(
        (series) => [`${validation_case.case_id}\u0000${series.observation_id}`, series] as const,
      ),
    ),
  )
}

function referenceCurve(
  contract: ModelContract,
  requirement_id: string,
): { points: readonly { x: number; y: number }[]; span: number } | undefined {
  const points = contract.characterization.requirements.find(
    (requirement) => requirement.requirement_id === requirement_id,
  )?.reference_curve?.points
  if (!points || points.length < 2) return undefined
  const values = points.map(({ y }) => y)
  const span = Math.max(...values) - Math.min(...values)
  return Number.isFinite(span) && span > 0 ? { points, span } : undefined
}

function interpolateSeries(points: readonly { x: number; y: number }[], x: number): number | undefined {
  const ordered = [...points].sort((left, right) => left.x - right.x)
  const first = ordered[0]
  const last = ordered.at(-1)
  if (!first || !last || x < first.x || x > last.x) return undefined
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]
    if (!current) return undefined
    if (coordinatesMatch(current.x, x)) return current.y
    const next = ordered[index + 1]
    if (!next || x > next.x) continue
    if (coordinatesMatch(current.x, next.x)) return undefined
    const fraction = (x - current.x) / (next.x - current.x)
    return current.y + fraction * (next.y - current.y)
  }
  return undefined
}

function coordinatesMatch(left: number, right: number): boolean {
  return (
    Math.abs(left - right) <=
    Math.max(
      COORDINATE_ABSOLUTE_TOLERANCE,
      Math.max(Math.abs(left), Math.abs(right)) * COORDINATE_RELATIVE_TOLERANCE,
    )
  )
}

export function materiallyDependsOnStimulus(input: {
  baseline: ValidationSeriesResult | undefined
  flattened: ValidationSeriesResult | undefined
  immutable_reference_curve: { points: readonly { x: number; y: number }[]; span: number } | undefined
}): boolean {
  const { baseline, flattened, immutable_reference_curve } = input
  if (!baseline || !flattened || !immutable_reference_curve) return false
  if (
    baseline.type !== flattened.type ||
    baseline.unit !== flattened.unit ||
    baseline.scale !== flattened.scale ||
    baseline.points.length === 0 ||
    flattened.points.length === 0
  ) {
    return false
  }

  const normalized_differences: number[] = []
  let maximum_difference = 0
  for (const reference_point of immutable_reference_curve.points) {
    const baseline_y = interpolateSeries(baseline.points, reference_point.x)
    const flattened_y = interpolateSeries(flattened.points, reference_point.x)
    if (
      baseline_y === undefined ||
      flattened_y === undefined ||
      !Number.isFinite(baseline_y) ||
      !Number.isFinite(flattened_y)
    ) {
      return false
    }
    const difference = Math.abs(baseline_y - flattened_y)
    maximum_difference = Math.max(maximum_difference, difference)
    normalized_differences.push(difference / immutable_reference_curve.span)
  }
  const normalized_maximum_difference = maximum_difference / immutable_reference_curve.span
  const reference_points = immutable_reference_curve.points
  const initial_reference = reference_points[0]!.y
  const dynamic_indices = reference_points.flatMap((point, index) => {
    const previous = reference_points[index - 1]
    const next = reference_points[index + 1]
    const deviation = Math.abs(point.y - initial_reference) / immutable_reference_curve.span
    const local_change =
      Math.max(previous ? Math.abs(point.y - previous.y) : 0, next ? Math.abs(next.y - point.y) : 0) /
      immutable_reference_curve.span
    return deviation >= MIN_REFERENCE_DYNAMIC_DEVIATION || local_change >= MIN_REFERENCE_LOCAL_CHANGE
      ? [index]
      : []
  })
  if (dynamic_indices.length === 0) return false
  const dynamic_differences = dynamic_indices.map((index) => normalized_differences[index]!)
  const dynamic_normalized_rms_difference = Math.sqrt(
    dynamic_differences.reduce((sum, difference) => sum + difference * difference, 0) /
      dynamic_differences.length,
  )
  const dynamic_point_coverage =
    dynamic_differences.filter((difference) => difference >= MIN_DYNAMIC_POINT_DIFFERENCE).length /
    dynamic_differences.length
  const flattened_fails_reference =
    !flattened.passed && flattened.errors.some(({ code }) => code === "curve_tolerance_exceeded")
  return (
    normalized_maximum_difference >= MIN_NORMALIZED_MAX_DIFFERENCE &&
    dynamic_normalized_rms_difference >= MIN_DYNAMIC_NORMALIZED_RMS_DIFFERENCE &&
    dynamic_point_coverage >= MIN_DYNAMIC_POINT_COVERAGE &&
    flattened_fails_reference
  )
}

/**
 * Replays a candidate against a private server-owned clone of its plan with
 * every requirement-bound PULSE flattened to its low level. A passing model
 * must change substantially relative to the immutable reference-curve span,
 * and the no-step replay must no longer satisfy the reference curve.
 */
export async function checkCandidateStimulusCausality(input: {
  plan: ValidationPlan
  contract: ModelContract
  manifest: ModelManifest
  model_source: string
  baseline_result: ValidationRunResult
  model_dir: string
  signal?: AbortSignal
  ngspice: NgspiceExecutor
  ngspice_path: string
}): Promise<CandidateStimulusCausalityCheck> {
  const flattened = flattenBoundPulses({ plan: input.plan, contract: input.contract })
  const checked_case_count = flattened.relevant_observation_ids_by_case.size
  const checked_observation_count = [...flattened.relevant_observation_ids_by_case.values()].reduce(
    (count, observations) => count + observations.size,
    0,
  )
  if (checked_observation_count === 0) return { required: false, passed: true }

  const expected_hashes = hashValidationInputs({
    plan: input.plan,
    model_source: input.model_source,
    manifest: input.manifest,
  })
  if (JSON.stringify(expected_hashes) !== JSON.stringify(input.baseline_result.hashes)) {
    throw new Error("Candidate stimulus-causality check received a baseline from different model inputs")
  }

  const temporary_directory = await mkdtemp(join(tmpdir(), "model-stimulus-causality-"))
  let flattened_result: ValidationRunResult | undefined
  try {
    flattened_result = await runSpiceValidation({
      plan: flattened.plan,
      manifest: input.manifest,
      model_source: input.model_source,
      model_dir: input.model_dir,
      artifact_directory: join(temporary_directory, "private-validation"),
      model_contract: contractWithoutElectricalBindings(input.contract),
      signal: input.signal,
      ngspice: input.ngspice,
      ngspice_path: input.ngspice_path,
    })
    input.signal?.throwIfAborted()
  } catch (error) {
    input.signal?.throwIfAborted()
    return {
      required: true,
      passed: false,
      affected_case_count: checked_case_count,
      affected_observation_count: checked_observation_count,
    }
  } finally {
    await rm(temporary_directory, { recursive: true, force: true }).catch(() => undefined)
  }

  const baseline_series = indexSeries(input.baseline_result)
  const flattened_series = indexSeries(flattened_result)
  const affected_cases = new Set<string>()
  let affected_observation_count = 0
  for (const validation_case of input.plan.cases) {
    const relevant_ids = flattened.relevant_observation_ids_by_case.get(validation_case.id)
    if (!relevant_ids) continue
    for (const observation of validation_case.observations) {
      if (!relevant_ids.has(observation.id)) continue
      const key = `${validation_case.id}\u0000${observation.id}`
      if (
        materiallyDependsOnStimulus({
          baseline: baseline_series.get(key),
          flattened: flattened_series.get(key),
          immutable_reference_curve: referenceCurve(input.contract, observation.requirement_id),
        })
      ) {
        continue
      }
      affected_cases.add(validation_case.id)
      affected_observation_count += 1
    }
  }

  if (affected_observation_count > 0) {
    return {
      required: true,
      passed: false,
      affected_case_count: affected_cases.size,
      affected_observation_count,
    }
  }
  return {
    required: true,
    passed: true,
    receipt: {
      version: 1,
      method: "bound_pulse_flatten_v2",
      status: "passed",
      hashes: expected_hashes,
      checked_case_count,
      checked_observation_count,
    },
  }
}

export function attachStimulusCausalityCheck(
  result: ValidationRunResult,
  check: CandidateStimulusCausalityCheck,
): ValidationRunResult {
  if (!check.required) return result
  if (check.passed) return { ...result, stimulus_causality: check.receipt }
  return {
    ...result,
    passed: false,
    errors: [
      ...result.errors,
      {
        kind: "comparison",
        code: "bound_stimulus_insensitive",
        message:
          "The generated model response did not materially depend on the server-owned bound electrical stimulus " +
          `(${check.affected_case_count} case(s), ${check.affected_observation_count} observation(s)).`,
      },
    ],
  }
}
