import type { AnyCircuitElement } from "circuit-json"
import { scoreObservation } from "../../spice-validation/scoring"
import type { ValidationCase, ValidationExecutionError } from "../../spice-validation/types"
import { validateApplicationNodeGroups } from "./application-topology"
import { asRecord, failedSeries, simulatorError } from "./errors"
import { validateFixture } from "./fixture-topology"
import {
  normalizeTransientBoundaryPoint,
  validateTransientExperimentTiming,
  validateTransientGraphTiming,
} from "./timing"
import type { CircuitRecord, ViewerSimulationValidation } from "./types"
import {
  currentProbeForObservation,
  graphPoints,
  graphsForProbe,
  probeForObservation,
} from "./waveform-probes"

/**
 * Verifies the exact Circuit JSON consumed by Runframe, then scores its
 * time-domain samples against the immutable datasheet curve contract.
 */
export function validateViewerSimulation(input: {
  validation_case: ValidationCase
  circuit_json: readonly AnyCircuitElement[]
}): ViewerSimulationValidation {
  const { validation_case, circuit_json } = input
  const errors: ValidationExecutionError[] = []
  if (validation_case.analysis.type !== "transient") {
    errors.push(
      simulatorError(
        "viewer_analysis_not_transient",
        `Validation case ${validation_case.id} uses ${validation_case.analysis.type}; tscircuit model comparisons require elapsed time on the x-axis`,
        "analysis.type",
      ),
    )
  }
  for (const observation of validation_case.observations) {
    if (observation.reference.type !== "curve") {
      errors.push(
        simulatorError(
          "viewer_reference_not_time_curve",
          `Observation ${observation.id} is ${observation.reference.type}-based; publishable tscircuit comparisons require a digitized time-domain reference curve`,
          `observations.${observation.id}.reference.type`,
        ),
      )
    }
  }
  for (const fixture of validation_case.fixtures) {
    const current_observation = validation_case.observations.find(
      (observation): observation is Extract<typeof observation, { type: "current" }> =>
        observation.type === "current" && observation.element_id === fixture.id,
    )
    errors.push(...validateFixture({ fixture, circuit_json, current_observation }))
  }
  errors.push(...validateApplicationNodeGroups({ validation_case, circuit_json }))

  const all_experiments = circuit_json.flatMap((element) => {
    const record = asRecord(element)
    return record.type === "simulation_experiment" ? [record] : []
  })
  const experiments = all_experiments.filter(
    ({ experiment_type }) => experiment_type === "spice_transient_analysis",
  )
  if (all_experiments.length !== 1 || experiments.length !== 1) {
    errors.push(
      simulatorError(
        "viewer_experiment_set_mismatch",
        `Validation case ${validation_case.id} produced ${all_experiments.length} total simulation experiments (${experiments.length} transient); exactly one transient experiment and no other experiments are supported`,
        "circuit_json",
      ),
    )
  }
  if (experiments.length !== 1) {
    errors.push(
      simulatorError(
        "viewer_transient_experiment_count",
        `Validation case ${validation_case.id} produced ${experiments.length} transient experiments; exactly one is required`,
        "circuit_json",
      ),
    )
  }
  const experiment_id = experiments[0]?.simulation_experiment_id
  if (typeof experiment_id !== "string") {
    errors.push(
      simulatorError(
        "viewer_transient_experiment_missing_id",
        `Validation case ${validation_case.id} has no traceable transient experiment id`,
        "circuit_json",
      ),
    )
  }
  if (experiments.length === 1) {
    errors.push(
      ...validateTransientExperimentTiming({
        validation_case,
        experiment: experiments[0]!,
      }),
    )
  }
  const simulator_failures = circuit_json.filter(
    (element) => element.type === "simulation_unknown_experiment_error",
  )
  for (const failure of simulator_failures) {
    const record = asRecord(failure)
    errors.push(
      simulatorError(
        "viewer_simulator_error",
        typeof record.message === "string"
          ? record.message
          : "tscircuit reported an unknown simulation error",
        "circuit_json",
      ),
    )
  }

  const simulation_graphs = circuit_json.flatMap((element) => {
    const record = asRecord(element)
    return typeof record.type === "string" &&
      record.type.startsWith("simulation_") &&
      record.type.endsWith("_graph")
      ? [record]
      : []
  })
  const supported_graphs = simulation_graphs.filter(
    ({ type }) =>
      type === "simulation_transient_voltage_graph" || type === "simulation_transient_current_graph",
  )
  const unsupported_graphs = simulation_graphs.filter(
    ({ type }) =>
      type !== "simulation_transient_voltage_graph" && type !== "simulation_transient_current_graph",
  )
  if (unsupported_graphs.length > 0) {
    errors.push(
      simulatorError(
        "viewer_unsupported_simulation_graph",
        `Validation case ${validation_case.id} produced unsupported simulation graph types: ${[
          ...new Set(unsupported_graphs.map(({ type }) => String(type))),
        ].join(", ")}; only planned transient voltage/current graphs may be exposed to Runframe`,
        "circuit_json",
      ),
    )
  }

  const matched_graphs = new Set<CircuitRecord>()
  const series = validation_case.observations.map((observation) => {
    if (typeof experiment_id !== "string") {
      return failedSeries(
        observation,
        simulatorError(
          "viewer_waveform_missing_experiment",
          `Cannot resolve waveform ${observation.id} without a transient experiment`,
          `observations.${observation.id}`,
        ),
      )
    }
    const probe_resolution =
      observation.type === "voltage"
        ? probeForObservation({ circuit_json, observation })
        : currentProbeForObservation({ circuit_json, observation })
    if (probe_resolution.error) return failedSeries(observation, probe_resolution.error)
    const probe_id =
      observation.type === "voltage"
        ? "simulation_voltage_probe_id" in probe_resolution.probe
          ? probe_resolution.probe.simulation_voltage_probe_id
          : undefined
        : "simulation_current_probe_id" in probe_resolution.probe
          ? probe_resolution.probe.simulation_current_probe_id
          : undefined
    if (typeof probe_id !== "string") {
      return failedSeries(
        observation,
        simulatorError(
          "viewer_probe_missing_id",
          `Cannot resolve the tscircuit ${observation.type} probe id for ${observation.id}`,
          `observations.${observation.id}`,
        ),
      )
    }
    const graphs = graphsForProbe({
      circuit_json,
      experiment_id,
      probe_id,
      observation_type: observation.type,
    })
    if (graphs.length !== 1) {
      return failedSeries(
        observation,
        simulatorError(
          "viewer_waveform_count",
          `Observation ${observation.id} resolved to ${graphs.length} tscircuit waveforms linked to its verified probe; exactly one is required`,
          `observations.${observation.id}`,
        ),
      )
    }
    matched_graphs.add(graphs[0]!)
    errors.push(
      ...validateTransientGraphTiming({
        validation_case,
        observation_id: observation.id,
        graph: graphs[0]!,
      }),
    )
    const points = graphPoints(graphs[0]!, observation)
    if (!Array.isArray(points)) return failedSeries(observation, points)
    return scoreObservation(observation, normalizeTransientBoundaryPoint(validation_case, points, graphs[0]!))
  })
  const unexpected_graphs = supported_graphs.filter((graph) => !matched_graphs.has(graph))
  if (unexpected_graphs.length > 0) {
    errors.push(
      simulatorError(
        "viewer_unexpected_simulation_graph",
        `Validation case ${validation_case.id} produced ${unexpected_graphs.length} transient graph(s) that are not the one-to-one waveform of a planned, electrically bound observation`,
        "circuit_json",
      ),
    )
  }
  const series_errors = series.flatMap(({ errors: observation_errors }) => observation_errors)
  const all_errors = [...errors, ...series_errors]
  const simulation_valid =
    all_errors.every(({ kind }) => kind === "comparison") &&
    series.length === validation_case.observations.length &&
    series.every(({ points }) => points.length >= 2)
  return {
    simulation_valid,
    passed: simulation_valid && series.every(({ passed }) => passed),
    series,
    errors: all_errors,
  }
}
