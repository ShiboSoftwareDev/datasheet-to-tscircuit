import type { AnyCircuitElement } from "circuit-json"
import { isCircuitJson } from "../component-circuit-json"
import type {
  ModelCircuitPreview,
  ModelManifest,
  ModelPreviewOption,
  ModelReferencePreview,
  ModelReferenceSeriesPreview,
  ModelSelectedPreview,
  ModelValidationBenchmark,
  ModelValidationSeries,
  ModelValidationSummary,
} from "@/shared/job-types"
import type {
  FixtureElement,
  SpiceEndpoint,
  ValidationAnalysis,
  ValidationCase,
  ValidationObservation,
  ValidationPlan,
  ValidationRunResult,
  ValidationSeriesPoint,
  ValidationSeriesResult,
} from "../spice-validation"
import type { ModelContract } from "./types"

const MAX_PREVIEW_POINTS = 600

export interface ModelUiProjectionInput {
  plan: ValidationPlan
  result: ValidationRunResult
  manifest: ModelManifest
  model_source: string
  model_card: string
  updated_at: string
  circuit_json_by_case?: Readonly<Record<string, AnyCircuitElement[] | undefined>>
  circuit_build_errors_by_case?: Readonly<Record<string, string | undefined>>
  contract?: ModelContract
  validation_artifact_state?: "candidate" | "accepted"
  preview_generation?: string
}

export interface ModelUiProjection {
  validation: ModelValidationSummary
  preview_options: ModelPreviewOption[]
  selected_previews: Readonly<Record<string, ModelSelectedPreview>>
}

function finiteMetrics(series: ValidationSeriesResult[]): Array<{
  rmse: number
  maximum: number
}> {
  return series.flatMap(({ metrics }) =>
    metrics.normalized_rmse !== undefined && Number.isFinite(metrics.normalized_rmse)
      ? [
          {
            rmse: metrics.normalized_rmse,
            maximum:
              metrics.normalized_max_error !== undefined && Number.isFinite(metrics.normalized_max_error)
                ? metrics.normalized_max_error
                : metrics.normalized_rmse,
          },
        ]
      : [],
  )
}

function observationTolerance(observation: ValidationObservation): number {
  return observation.reference.type === "bounds" ? 0 : observation.reference.tolerance
}

function errorMessage(errors: Array<{ message: string }>): string | undefined {
  const messages = [...new Set(errors.map(({ message }) => message.trim()).filter(Boolean))]
  return messages.length > 0 ? messages.join("; ") : undefined
}

/**
 * Projects the authoritative validation result into the legacy UI summary DTO.
 * Every declared case is critical because the v1 validation contract has no
 * advisory case: a model is accepted only when every case passes.
 */
export function projectModelValidationSummary(
  plan: ValidationPlan,
  result: ValidationRunResult,
  contract?: ModelContract,
): ModelValidationSummary {
  const result_by_case = new Map(
    result.cases.map((validation_case) => [validation_case.case_id, validation_case]),
  )
  const benchmarks: ModelValidationBenchmark[] = plan.cases.map((validation_case) => {
    const case_result = result_by_case.get(validation_case.id)
    const series_by_id = new Map(case_result?.series.map((series) => [series.observation_id, series]) ?? [])
    const series: ModelValidationSeries[] = validation_case.observations.map((observation) => {
      const series_result = series_by_id.get(observation.id)
      return {
        series_id: observation.id,
        title: titleFromIdentifier(observation.id),
        role: "response",
        unit: observation.unit,
        tolerance: observationTolerance(observation),
        normalized_rmse: series_result?.metrics.normalized_rmse,
        normalized_max_error: series_result?.metrics.normalized_max_error,
        passed: series_result?.passed ?? false,
        error_message:
          errorMessage(series_result?.errors ?? []) ??
          (series_result ? undefined : "Validation did not produce this observation."),
      }
    })
    const metrics = finiteMetrics(case_result?.series ?? [])
    const normalized_rmse =
      metrics.length > 0 ? metrics.reduce((sum, metric) => sum + metric.rmse, 0) / metrics.length : undefined
    const normalized_max_error =
      metrics.length > 0 ? Math.max(...metrics.map(({ maximum }) => maximum)) : undefined
    return {
      benchmark_id: validation_case.id,
      title: validation_case.title ?? titleFromIdentifier(validation_case.id),
      critical: true,
      tolerance: Math.max(0, ...validation_case.observations.map(observationTolerance)),
      normalized_rmse,
      normalized_max_error,
      passed: case_result?.status === "passed" && series.every(({ passed }) => passed),
      error_message:
        errorMessage([...(case_result?.errors ?? []), ...result.errors]) ??
        (case_result ? undefined : "Validation did not execute this case."),
      series,
    }
  })
  const scored = benchmarks.flatMap(({ normalized_rmse }) =>
    normalized_rmse !== undefined && Number.isFinite(normalized_rmse) ? [normalized_rmse] : [],
  )
  const maximums = benchmarks.flatMap(({ normalized_max_error }) =>
    normalized_max_error !== undefined && Number.isFinite(normalized_max_error) ? [normalized_max_error] : [],
  )
  const curve_metrics = plan.cases.flatMap((validation_case) => {
    const case_result = result_by_case.get(validation_case.id)
    const series_by_id = new Map(case_result?.series.map((series) => [series.observation_id, series]) ?? [])
    return validation_case.observations.flatMap((observation) => {
      if (observation.reference.type !== "curve") return []
      const series = series_by_id.get(observation.id)
      const normalized_rmse = series?.metrics.normalized_rmse
      if (
        !series ||
        series.points.length === 0 ||
        normalized_rmse === undefined ||
        !Number.isFinite(normalized_rmse)
      ) {
        return []
      }
      const sample_count = Math.max(1, series.metrics.sample_count)
      return [
        {
          normalized_rmse,
          normalized_max_error:
            series.metrics.normalized_max_error !== undefined &&
            Number.isFinite(series.metrics.normalized_max_error)
              ? series.metrics.normalized_max_error
              : normalized_rmse,
          sample_count,
        },
      ]
    })
  })
  const curve_sample_count = curve_metrics.reduce((sum, metric) => sum + metric.sample_count, 0)
  const curve_score =
    curve_sample_count > 0
      ? curve_metrics.reduce((sum, metric) => sum + metric.normalized_rmse * metric.sample_count, 0) /
        curve_sample_count
      : undefined
  const curve_worst_normalized_error =
    curve_metrics.length > 0
      ? Math.max(...curve_metrics.map(({ normalized_max_error }) => normalized_max_error))
      : undefined
  const passing_count = benchmarks.filter(({ passed }) => passed).length
  const scope = contract
    ? (() => {
        const modeled = contract.characterization.requirements.filter(
          ({ support }) => support.status === "modeled",
        )
        const documented_only = contract.characterization.requirements.flatMap((requirement) =>
          requirement.support.status === "documented_only"
            ? [
                {
                  requirement_id: requirement.requirement_id,
                  title: requirement.title,
                  reason: requirement.support.reason,
                },
              ]
            : [],
        )
        const curve_observation_count = plan.cases.reduce(
          (count, validation_case) =>
            count + validation_case.observations.filter(({ reference }) => reference.type === "curve").length,
          0,
        )
        const scalar_observation_count =
          plan.cases.reduce((count, validation_case) => count + validation_case.observations.length, 0) -
          curve_observation_count
        const validated_sample_count = result.cases.reduce(
          (count, validation_case) =>
            count +
            validation_case.series.reduce((series_count, series) => series_count + series.points.length, 0),
          0,
        )
        const swept_case_count = plan.cases.filter(
          ({ analysis }) => analysis.type === "dc_sweep" || analysis.type === "transient",
        ).length
        return {
          total_requirement_count: contract.characterization.requirements.length,
          modeled_requirement_count: modeled.length,
          documented_only_requirement_count: documented_only.length,
          validated_sample_count,
          scalar_observation_count,
          curve_observation_count,
          compared_curve_observation_count: curve_metrics.length,
          curve_sample_count,
          swept_case_count,
          quality:
            curve_metrics.length > 0
              ? ("curve_validated" as const)
              : curve_observation_count > 0
                ? ("curve_attempted" as const)
                : swept_case_count > 0 || validated_sample_count > scalar_observation_count
                  ? ("range_checked" as const)
                  : ("scalar_only" as const),
          documented_only_requirements: documented_only,
          limitations: [...contract.characterization.limitations],
        }
      })()
    : undefined
  return {
    benchmark_count: benchmarks.length,
    passing_count,
    critical_count: benchmarks.length,
    critical_passing_count: passing_count,
    score: scored.length > 0 ? scored.reduce((sum, value) => sum + value, 0) / scored.length : undefined,
    worst_normalized_error: maximums.length > 0 ? Math.max(...maximums) : undefined,
    curve_score,
    curve_worst_normalized_error,
    all_critical_passed: result.passed && benchmarks.length > 0 && passing_count === benchmarks.length,
    all_passed: result.passed && benchmarks.length > 0 && passing_count === benchmarks.length,
    benchmarks,
    ...(scope ? { scope } : {}),
  }
}

function downsample(points: ValidationSeriesPoint[]): ValidationSeriesPoint[] {
  if (points.length <= MAX_PREVIEW_POINTS) return points.map(({ x, y }) => ({ x, y }))
  const stride = Math.ceil(points.length / MAX_PREVIEW_POINTS)
  return points.filter((_, index) => index % stride === 0 || index === points.length - 1)
}

function referencePoints(
  observation: ValidationObservation,
  result_points: ValidationSeriesPoint[],
): ValidationSeriesPoint[] {
  const reference = observation.reference
  if (reference.type === "curve") return reference.points.map(({ x, y }) => ({ x, y }))
  if (reference.type === "bounds") return []
  const x_values = result_points.length > 0 ? result_points.map(({ x }) => x) : [0]
  return x_values.map((x) => ({ x, y: reference.target }))
}

function referenceBounds(observation: ValidationObservation): { min?: number; max?: number } | undefined {
  const reference = observation.reference
  if (reference.type !== "bounds") return undefined
  return {
    ...(reference.min === undefined ? {} : { min: reference.min }),
    ...(reference.max === undefined ? {} : { max: reference.max }),
  }
}

function titleFromIdentifier(identifier: string): string {
  return identifier.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase())
}

function metadataValue(observation: ValidationObservation, ...names: string[]): string | undefined {
  const metadata = observation.evidence?.metadata
  for (const name of names) {
    const value = metadata?.[name]?.trim()
    if (value) return value
  }
  return undefined
}

function analysisAxis(input: { analysis: ValidationAnalysis; fixtures: FixtureElement[] }): {
  label: string
  unit: string
} {
  const analysis = input.analysis
  if (analysis.type === "transient") return { label: "Time", unit: "s" }
  if (analysis.type === "operating_point") return { label: "Operating point", unit: "" }
  const source = input.fixtures.find(({ id }) => id === analysis.source_id)
  return {
    label: titleFromIdentifier(analysis.source_id),
    unit: source?.type === "current_source" ? "A" : "V",
  }
}

function observationQuantity(observation: ValidationObservation): string {
  return (
    metadataValue(observation, "y_quantity", "quantity") ??
    (observation.type === "voltage" ? "voltage" : "current")
  )
}

function observationSourceFile(observation: ValidationObservation): string {
  return observation.evidence?.image ?? "validation-plan.json"
}

function projectReferenceSeries(input: {
  observation: ValidationObservation
  result?: ValidationSeriesResult
}): ModelReferenceSeriesPreview {
  const result_points = downsample(input.result?.points ?? [])
  return {
    series_id: input.observation.id,
    title: titleFromIdentifier(input.observation.id),
    role: "response",
    quantity: observationQuantity(input.observation),
    unit: metadataValue(input.observation, "y_unit") ?? input.observation.unit,
    source_file: observationSourceFile(input.observation),
    result_file: input.result ? "validation-results.json" : undefined,
    y_scale: input.observation.scale,
    reference_points: downsample(referencePoints(input.observation, result_points)),
    reference_bounds: referenceBounds(input.observation),
    result_points: input.result ? result_points : undefined,
    normalized_rmse: input.result?.metrics.normalized_rmse,
    normalized_max_error: input.result?.metrics.normalized_max_error,
    matches_reference: input.result?.passed,
  }
}

export function projectModelReferencePreview(input: {
  validation_case: ValidationCase
  result: ValidationRunResult
  updated_at: string
}): ModelReferencePreview {
  const case_result = input.result.cases.find(({ case_id }) => case_id === input.validation_case.id)
  const result_by_observation = new Map(
    case_result?.series.map((series) => [series.observation_id, series]) ?? [],
  )
  const series = input.validation_case.observations.map((observation) =>
    projectReferenceSeries({
      observation,
      result: result_by_observation.get(observation.id),
    }),
  )
  const primary = series[0]
  const primary_observation = input.validation_case.observations[0]
  if (!primary || !primary_observation) {
    throw new Error(`Validation case ${input.validation_case.id} has no observations`)
  }
  const axis = analysisAxis({
    analysis: input.validation_case.analysis,
    fixtures: input.validation_case.fixtures,
  })
  return {
    benchmark_id: input.validation_case.id,
    title: input.validation_case.title ?? titleFromIdentifier(input.validation_case.id),
    source_file: primary.source_file,
    result_file: case_result ? "validation-results.json" : undefined,
    x_axis_label: metadataValue(primary_observation, "x_quantity") ?? axis.label,
    x_axis_unit: metadataValue(primary_observation, "x_unit") ?? axis.unit,
    y_axis_label: titleFromIdentifier(primary.quantity),
    y_axis_unit: primary.unit,
    x_scale: "linear",
    y_scale: primary.y_scale,
    reference_points: primary.reference_points,
    reference_bounds: primary.reference_bounds,
    result_points: primary.result_points,
    series,
    result_status: case_result?.status === "passed" ? "verified" : case_result?.status,
    result_origin: case_result ? "server_validation" : undefined,
    normalized_rmse: case_result
      ? averageDefined(case_result.series.map(({ metrics }) => metrics.normalized_rmse))
      : undefined,
    normalized_max_error: case_result
      ? maximumDefined(case_result.series.map(({ metrics }) => metrics.normalized_max_error))
      : undefined,
    matches_reference:
      case_result?.status === "cancelled"
        ? undefined
        : case_result
          ? case_result.status === "passed" && case_result.series.every(({ passed }) => passed)
          : undefined,
    is_stale: false,
    updated_at: input.updated_at,
  }
}

function averageDefined(values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number => value !== undefined && Number.isFinite(value))
  return finite.length > 0 ? finite.reduce((sum, value) => sum + value, 0) / finite.length : undefined
}

function maximumDefined(values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number => value !== undefined && Number.isFinite(value))
  return finite.length > 0 ? Math.max(...finite) : undefined
}

function endpointSelector(endpoint: SpiceEndpoint, manifest: ModelManifest): string {
  if (endpoint === "gnd") return "net.GND"
  if (endpoint.startsWith("net.")) return endpoint
  const spice_node = endpoint.slice("dut.".length)
  const mapping = manifest.pins.find((pin) => pin.spice_node === spice_node)
  if (!mapping) throw new Error(`Cannot project unknown DUT node ${spice_node}`)
  return `.DUT > .${mapping.component_pin}`
}

function fixtureTerminals(fixture: FixtureElement): [SpiceEndpoint, SpiceEndpoint] {
  return fixture.type === "diode" ? [fixture.anode, fixture.cathode] : [fixture.positive, fixture.negative]
}

function fixtureElementSource(fixture: FixtureElement, include_pulse: boolean): string {
  const name = JSON.stringify(fixture.id)
  switch (fixture.type) {
    case "resistor":
      return `<resistor name=${name} resistance=${JSON.stringify(`${fixture.resistance_ohms}ohm`)} />`
    case "capacitor":
      return `<capacitor name=${name} capacitance=${JSON.stringify(`${fixture.capacitance_farads}F`)} />`
    case "inductor":
      return `<inductor name=${name} inductance=${JSON.stringify(`${fixture.inductance_henries}H`)} />`
    case "voltage_source": {
      if (fixture.pulse && include_pulse) {
        return `<voltagesource name=${name} voltage=${JSON.stringify(`${fixture.pulse.high}V`)} waveShape="square" pulseDelay=${JSON.stringify(`${fixture.pulse.delay}s`)} riseTime=${JSON.stringify(`${fixture.pulse.rise}s`)} fallTime=${JSON.stringify(`${fixture.pulse.fall}s`)} pulseWidth=${JSON.stringify(`${fixture.pulse.width}s`)} period=${JSON.stringify(`${fixture.pulse.period}s`)} />`
      }
      return `<voltagesource name=${name} voltage=${JSON.stringify(`${fixture.dc_volts}V`)} />`
    }
    case "current_source":
      return `<currentsource name=${name} current=${JSON.stringify(`${fixture.dc_amps}A`)} />`
    case "diode":
      return `<diode name=${name} />`
  }
}

/**
 * The installed tscircuit analog element currently exposes transient analysis,
 * voltage-source pulse timing, voltage probes, and ammeters. It does not expose
 * operating-point/DC-sweep analyses or exact current-source PULSE timing.
 */
function analogProjectionIssue(validation_case: ValidationCase): string | undefined {
  if (validation_case.analysis.type !== "transient") {
    return `tscircuit analogsimulation does not support ${validation_case.analysis.type} analysis`
  }
  const current_observation_counts = new Map<string, number>()
  for (const observation of validation_case.observations) {
    if (observation.type !== "current") continue
    const count = (current_observation_counts.get(observation.element_id) ?? 0) + 1
    current_observation_counts.set(observation.element_id, count)
    if (count > 1) {
      return `multiple current probes on fixture ${observation.element_id} cannot be projected without changing its topology`
    }
  }
  for (const fixture of validation_case.fixtures) {
    if (fixture.type === "current_source" && fixture.pulse) {
      return `tscircuit currentsource does not expose exact PULSE delay, rise, fall, width, and period controls for ${fixture.id}`
    }
    if (
      fixture.type === "voltage_source" &&
      fixture.pulse &&
      (fixture.pulse.low !== 0 || fixture.dc_volts !== fixture.pulse.low)
    ) {
      return `tscircuit voltagesource PULSE requires a zero low/DC level for ${fixture.id}`
    }
  }
  return undefined
}

function analogSimulationSource(analysis: Extract<ValidationAnalysis, { type: "transient" }>): string {
  const start_time = analysis.start === undefined ? "" : ` startTime=${JSON.stringify(`${analysis.start}s`)}`
  return `<analogsimulation name="validation" duration=${JSON.stringify(`${analysis.stop}s`)} timePerStep=${JSON.stringify(`${analysis.step}s`)}${start_time} spiceEngine="ngspice" graphIndependentAxes />`
}

function safeComment(value: string): string {
  return value
    .replace(/\*\//g, "* /")
    .replace(/[\r\n]+/g, " ")
    .trim()
}

/** Generates display TSX from the same plan that the server compiles to SPICE. */
export function renderValidationCaseTsx(input: {
  validation_case: ValidationCase
  manifest: ModelManifest
  model_source: string
  model_card: string
}): string {
  const { validation_case, manifest } = input
  const analog_projection_issue = analogProjectionIssue(validation_case)
  const analog_projection_supported = analog_projection_issue === undefined
  const pin_labels = Object.fromEntries(
    manifest.pins.map(({ component_pin, spice_node }) => [component_pin, spice_node]),
  )
  const spice_pin_mapping = Object.fromEntries(
    manifest.pins.map(({ component_pin, spice_node }) => [spice_node, component_pin]),
  )
  const fixture_elements = validation_case.fixtures.map(
    (fixture) => `      ${fixtureElementSource(fixture, analog_projection_supported)}`,
  )
  const current_observation_by_element = new Map(
    validation_case.observations.flatMap((observation) =>
      observation.type === "current" ? [[observation.element_id, observation] as const] : [],
    ),
  )
  const traces = validation_case.fixtures.flatMap((fixture) => {
    const [positive, negative] = fixtureTerminals(fixture)
    const current_observation = current_observation_by_element.get(fixture.id)
    if (current_observation) {
      return [
        `      <ammeter name=${JSON.stringify(`probe_${current_observation.id}`)} graphDisplayName=${JSON.stringify(current_observation.id)} connections={${JSON.stringify(
          {
            pos: endpointSelector(positive, manifest),
            neg: `.${fixture.id} > .pin1`,
          },
        )}} />`,
        `      <trace from=${JSON.stringify(`.${fixture.id} > .pin2`)} to=${JSON.stringify(endpointSelector(negative, manifest))} />`,
      ]
    }
    return [
      `      <trace from=${JSON.stringify(`.${fixture.id} > .pin1`)} to=${JSON.stringify(endpointSelector(positive, manifest))} />`,
      `      <trace from=${JSON.stringify(`.${fixture.id} > .pin2`)} to=${JSON.stringify(endpointSelector(negative, manifest))} />`,
    ]
  })
  const probes = validation_case.observations.flatMap((observation) =>
    observation.type === "voltage"
      ? [
          `      <voltageprobe name=${JSON.stringify(`probe_${observation.id}`)} graphDisplayName=${JSON.stringify(observation.id)} connectsTo=${JSON.stringify(endpointSelector(observation.positive, manifest))} referenceTo=${JSON.stringify(endpointSelector(observation.negative, manifest))} />`,
        ]
      : [],
  )
  const analog_simulation =
    analog_projection_supported && validation_case.analysis.type === "transient"
      ? [`      ${analogSimulationSource(validation_case.analysis)}`]
      : []
  const card_title =
    input.model_card
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find(Boolean) ?? "Generated SPICE model"
  const requirement_ids = validation_case.requirement_ids.join(", ")
  const observation_ids = validation_case.observations.map(({ id }) => id).join(", ")
  return `/*
 * Deterministic schematic projection of validation case: ${safeComment(validation_case.id)}
 * Requirements: ${safeComment(requirement_ids)}
 * Analysis: ${safeComment(validation_case.analysis.type)}
 * Observations: ${safeComment(observation_ids)}
 * Model revision: ${safeComment(manifest.revision)}
 * Model card: ${safeComment(card_title).slice(0, 160)}
 * Analog preview: ${safeComment(analog_projection_issue ?? "faithful transient projection")}
 * Numeric validation is executed from the server-compiled SPICE netlist.
 */
const modelSource = ${JSON.stringify(input.model_source)}
const validationCaseContract = ${JSON.stringify(validation_case, null, 2)} as const

export default function ValidationCasePreview() {
  void validationCaseContract
  return (
    <board routingDisabled>
      <chip
        name="DUT"
        manufacturerPartNumber=${JSON.stringify(manifest.part_number)}
        pinLabels={${JSON.stringify(pin_labels, null, 2)}}
        spiceModel={(
          <spicemodel
            source={modelSource}
            spicePinMapping={${JSON.stringify(spice_pin_mapping, null, 2)}}
          />
        )}
      />
${[...fixture_elements, ...traces, ...probes, ...analog_simulation].join("\n")}
    </board>
  )
}
`
}

export function projectModelCircuitPreview(input: {
  validation_case: ValidationCase
  manifest: ModelManifest
  model_source: string
  model_card: string
  updated_at: string
  circuit_json?: AnyCircuitElement[]
  circuit_build_error?: string
}): ModelCircuitPreview {
  const projection_issue = analogProjectionIssue(input.validation_case)
  // Unsupported in-browser analog analysis must not suppress a valid
  // schematic/Code snapshot. Server ngspice results remain authoritative.
  const circuit_json = input.circuit_build_error
    ? undefined
    : isCircuitJson(input.circuit_json)
      ? input.circuit_json
      : undefined
  const build_error = input.circuit_build_error?.trim()
  return {
    source_file: `validation/cases/${input.validation_case.id}.circuit.tsx`,
    code: renderValidationCaseTsx(input),
    build_status: build_error ? "failed" : circuit_json ? "ready" : "source_ready",
    updated_at: input.updated_at,
    circuit_json,
    snapshot_origin: circuit_json ? "server_validation" : undefined,
    is_stale: false,
    error_message: build_error
      ? `Circuit preview build failed: ${build_error}`
      : projection_issue
        ? `Analog preview is source-only: ${projection_issue}. The server validation result remains authoritative.`
        : input.circuit_json
          ? "Circuit preview build produced no renderable Circuit JSON; benchmark TSX remains available."
          : undefined,
  }
}

export function projectModelPreviewOptions(
  plan: ValidationPlan,
  result?: ValidationRunResult,
): ModelPreviewOption[] {
  const completed_cases = new Set(result?.cases.map(({ case_id }) => case_id) ?? [])
  return plan.cases.map((validation_case) => ({
    benchmark_id: validation_case.id,
    title: validation_case.title ?? titleFromIdentifier(validation_case.id),
    circuit_file: `validation/cases/${validation_case.id}.circuit.tsx`,
    reference_file:
      validation_case.observations.find(({ evidence }) => evidence?.image)?.evidence?.image ??
      "validation-plan.json",
    result_file: completed_cases.has(validation_case.id) ? "validation-results.json" : undefined,
  }))
}

export function projectModelUi(input: ModelUiProjectionInput): ModelUiProjection {
  const selected_previews = Object.fromEntries(
    input.plan.cases.map((validation_case) => [
      validation_case.id,
      {
        circuit_preview: projectModelCircuitPreview({
          validation_case,
          manifest: input.manifest,
          model_source: input.model_source,
          model_card: input.model_card,
          updated_at: input.updated_at,
          circuit_json: input.circuit_json_by_case?.[validation_case.id],
          circuit_build_error: input.circuit_build_errors_by_case?.[validation_case.id],
        }),
        reference_preview: projectModelReferencePreview({
          validation_case,
          result: input.result,
          updated_at: input.updated_at,
        }),
      },
    ]),
  )
  return {
    validation: {
      ...projectModelValidationSummary(input.plan, input.result, input.contract),
      artifact_state: input.validation_artifact_state ?? "candidate",
      model_revision: input.manifest.revision,
      ...(input.preview_generation ? { preview_generation: input.preview_generation } : {}),
    },
    preview_options: projectModelPreviewOptions(input.plan, input.result),
    selected_previews,
  }
}
