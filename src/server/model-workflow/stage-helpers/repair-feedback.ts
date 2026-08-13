import type { ViewerSimulationValidation } from "../../modeling"
import type { ValidationRunResult } from "../../spice-validation"
import type { CandidateStimulusCausalityCheck } from "../candidate-stimulus-causality"
import type { ModelRepairAction, ModelRepairFeedback, ModelRepairFeedbackCategory } from "../types"

const REPAIR_FEEDBACK_CATEGORY_ORDER: readonly ModelRepairFeedbackCategory[] = [
  "target_mismatch",
  "bounds_violation",
  "curve_mismatch",
  "viewer_curve_mismatch",
  "stimulus_insensitive",
  "invalid_log_output",
  "non_finite_output",
  "convergence_failure",
  "simulator_rejected_model",
  "comparison_failure",
  "validation_failure",
]

const REPAIR_FEEDBACK_DESCRIPTIONS: Readonly<Record<ModelRepairFeedbackCategory, string>> = {
  target_mismatch: "one or more outputs missed a required target tolerance",
  bounds_violation: "one or more outputs fell outside required bounds",
  curve_mismatch: "one or more output curves exceeded their normalized comparison tolerance",
  viewer_curve_mismatch: "one or more tscircuit viewer waveforms exceeded their curve tolerance",
  stimulus_insensitive:
    "one or more dynamic outputs did not materially depend on the server-owned bound electrical stimulus",
  invalid_log_output: "the model produced a value outside the valid logarithmic domain",
  non_finite_output: "the model produced a non-finite output",
  convergence_failure: "the model caused the simulator to fail convergence",
  simulator_rejected_model: "the simulator rejected the generated model",
  comparison_failure: "one or more server-owned comparisons failed",
  validation_failure: "server-owned validation did not pass",
}

const REPAIR_ACTIONS: Readonly<Record<ModelRepairFeedbackCategory, readonly ModelRepairAction[]>> = {
  target_mismatch: ["recalibrate_continuous_transfer"],
  bounds_violation: ["enforce_declared_output_limits", "bound_internal_state"],
  curve_mismatch: ["retune_dynamic_response", "recalibrate_continuous_transfer"],
  viewer_curve_mismatch: ["retune_dynamic_response", "preserve_viewer_portability"],
  stimulus_insensitive: ["couple_response_to_public_stimulus"],
  invalid_log_output: ["guard_logarithmic_domain", "bound_internal_state"],
  non_finite_output: ["bound_internal_state", "improve_numerical_convergence"],
  convergence_failure: ["improve_numerical_convergence", "bound_internal_state"],
  simulator_rejected_model: ["replace_unsupported_ngspice_syntax"],
  comparison_failure: ["review_model_equations"],
  validation_failure: ["review_model_equations"],
}

const REPAIR_ACTION_DESCRIPTIONS: Readonly<Record<ModelRepairAction, string>> = {
  recalibrate_continuous_transfer:
    "recalibrate continuous gain, offset, or transfer equations against the visible training constraints",
  enforce_declared_output_limits:
    "add smooth limiting that respects the declared output range without hard-coding validation samples",
  retune_dynamic_response:
    "retune causal time constants, damping, or state equations across the visible transient range",
  preserve_viewer_portability:
    "keep the public response compatible with the tscircuit viewer, including a neutral public output when dynamic state begins at zero instead of a pre-solved DC operating point",
  couple_response_to_public_stimulus:
    "derive the response and dynamic state from public-pin voltage or current instead of autonomous behavior",
  guard_logarithmic_domain:
    "keep logarithmic inputs and outputs finite and strictly inside their valid domain",
  bound_internal_state: "bound internal equations and state so every simulated output remains finite",
  improve_numerical_convergence:
    "remove discontinuities and ideal singularities; add smooth transitions or finite stabilizing impedances",
  replace_unsupported_ngspice_syntax:
    "replace rejected syntax with portable ngspice-compatible primitives or behavioral expressions",
  review_model_equations:
    "review the model equations and public-pin behavior against every visible modeled requirement",
}

function simulatorRejectedSource(message: string): boolean {
  return /\b(?:yyparse|syntax error|parse error|unknown (?:device|model|subcircuit)|undefined parameter|no such (?:function|model)|unrecognized|unsupported syntax)\b/i.test(
    message,
  )
}

function repairFeedbackCategory(error: ValidationRunResult["errors"][number]): ModelRepairFeedbackCategory {
  if (simulatorRejectedSource(error.message)) return "simulator_rejected_model"
  if (error.kind === "convergence") return "convergence_failure"
  if (error.kind === "simulator" && error.code === "ngspice_failed") {
    return "simulator_rejected_model"
  }
  if (error.kind !== "comparison") return "validation_failure"
  switch (error.code) {
    case "target_tolerance_exceeded":
      return "target_mismatch"
    case "bounds_exceeded":
      return "bounds_violation"
    case "curve_tolerance_exceeded":
      return "curve_mismatch"
    case "bound_stimulus_insensitive":
      return "stimulus_insensitive"
    case "invalid_log_sample":
      return "invalid_log_output"
    case "non_finite_series":
      return "non_finite_output"
    default:
      return "comparison_failure"
  }
}

/**
 * Builds the only validation information that may cross into an agent repair
 * workspace. The output is deliberately derived from a closed enum and
 * aggregate counts, and closed-enum actions: simulator output, paths, fixture
 * values, points, hashes, metrics, and validation identifiers never enter it.
 */
export function createModelRepairFeedback(
  result: ValidationRunResult,
  viewer_validation_by_case?: Readonly<Record<string, ViewerSimulationValidation | undefined>>,
  stimulus_causality?: CandidateStimulusCausalityCheck,
  viewer_model_errors_by_case?: Readonly<Record<string, string | undefined>>,
): ModelRepairFeedback {
  const aggregate = new Map<ModelRepairFeedbackCategory, { cases: Set<number>; observations: Set<string> }>()
  const add = (category: ModelRepairFeedbackCategory, case_index?: number, series_index?: number): void => {
    const current = aggregate.get(category) ?? { cases: new Set<number>(), observations: new Set<string>() }
    if (case_index !== undefined) current.cases.add(case_index)
    if (case_index !== undefined && series_index !== undefined) {
      current.observations.add(`${case_index}:${series_index}`)
    }
    aggregate.set(category, current)
  }

  result.cases.forEach((validation_case, case_index) => {
    if (validation_case.status === "passed") return
    validation_case.series.forEach((series, series_index) => {
      if (series.passed) return
      if (series.errors.length === 0) {
        add("comparison_failure", case_index, series_index)
        return
      }
      for (const error of series.errors) {
        add(repairFeedbackCategory(error), case_index, series_index)
      }
    })
    for (const error of validation_case.errors) {
      add(repairFeedbackCategory(error), case_index)
    }
    if (validation_case.errors.length === 0 && validation_case.series.every(({ passed }) => passed)) {
      add("validation_failure", case_index)
    }
  })
  for (const error of result.errors) add(repairFeedbackCategory(error))
  Object.values(viewer_validation_by_case ?? {}).forEach((validation, case_index) => {
    if (!validation?.simulation_valid || validation.passed) return
    const failed_series = validation.series.flatMap((series, series_index) =>
      series.passed ? [] : [series_index],
    )
    if (failed_series.length === 0) {
      add("viewer_curve_mismatch", case_index)
      return
    }
    for (const series_index of failed_series) {
      add("viewer_curve_mismatch", case_index, series_index)
    }
  })
  Object.values(viewer_model_errors_by_case ?? {}).forEach((message, case_index) => {
    if (message) {
      add(simulatorRejectedSource(message) ? "simulator_rejected_model" : "convergence_failure", case_index)
    }
  })
  if (stimulus_causality?.required && !stimulus_causality.passed) {
    const current = aggregate.get("stimulus_insensitive") ?? {
      cases: new Set<number>(),
      observations: new Set<string>(),
    }
    for (let index = 0; index < stimulus_causality.affected_case_count; index += 1) {
      current.cases.add(index)
    }
    for (let index = 0; index < stimulus_causality.affected_observation_count; index += 1) {
      current.observations.add(`aggregate:${index}`)
    }
    aggregate.set("stimulus_insensitive", current)
  }
  if (aggregate.size === 0) add("validation_failure")

  return {
    version: 1,
    status: "failed",
    issues: REPAIR_FEEDBACK_CATEGORY_ORDER.flatMap((category) => {
      const value = aggregate.get(category)
      return value
        ? [
            {
              category,
              affected_cases: value.cases.size,
              affected_observations: value.observations.size,
              recommended_actions: REPAIR_ACTIONS[category],
            },
          ]
        : []
    }),
  }
}

export function formatModelRepairFeedback(feedback: ModelRepairFeedback): string {
  return [
    "Server-owned redacted validation summary:",
    ...feedback.issues.map(
      ({ category, affected_cases, affected_observations, recommended_actions }) =>
        `- ${category}: ${REPAIR_FEEDBACK_DESCRIPTIONS[category]}. ` +
        `Affected cases: ${affected_cases}; affected observations: ${affected_observations}. ` +
        `Recommended actions: ${recommended_actions
          .map((action) => `${action} (${REPAIR_ACTION_DESCRIPTIONS[action]})`)
          .join("; ")}.`,
    ),
  ].join("\n")
}

export function validationFailureFeedback(
  result: ValidationRunResult,
  viewer_validation_by_case?: Readonly<Record<string, ViewerSimulationValidation | undefined>>,
): string {
  return formatModelRepairFeedback(createModelRepairFeedback(result, viewer_validation_by_case))
}
