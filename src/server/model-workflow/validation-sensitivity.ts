import { join } from "node:path"
import type { ModelContract } from "../modeling"
import { createModelManifest } from "../modeling"
import {
  runSpiceValidation,
  type NgspiceExecutor,
  type ValidationPlan,
  type ValidationRunResult,
  type ValidationSeriesResult,
} from "../spice-validation"

const ACTIVE_PROBE_RESISTANCE_OHMS = 1_000
const MATERIAL_RELATIVE_DIFFERENCE = 1e-6
const MATERIAL_ABSOLUTE_DIFFERENCE = Object.freeze({ V: 1e-6, A: 1e-12 })
// Probe values are intentionally outside the real-device contract. Ordinary
// reference mismatches and finite samples outside a requested log domain do not
// make probe execution unreliable.
const VALUE_COMPARISON_FAILURES = new Set([
  "target_tolerance_exceeded",
  "bounds_exceeded",
  "curve_tolerance_exceeded",
  "invalid_log_sample",
])

function subcircuitHeader(contract: ModelContract): {
  entry_name: string
  pin_names: string[]
  header: string
} {
  const { entry_name, pins } = contract.interface
  const pin_names = pins.map(({ spice_node }) => spice_node)
  return {
    entry_name,
    pin_names,
    header: `.SUBCKT ${entry_name}${pin_names.length > 0 ? ` ${pin_names.join(" ")}` : ""}`,
  }
}

function createInertModelSource(contract: ModelContract): string {
  const { entry_name, pin_names, header } = subcircuitHeader(contract)
  const weak_ground_paths = pin_names.map((spice_node, index) => `R_INERT_${index + 1} ${spice_node} 0 1e15`)
  return [
    "* Server-owned weak/inert DUT sensitivity probe",
    header,
    ...weak_ground_paths,
    `.ENDS ${entry_name}`,
    "",
  ].join("\n")
}

function createActiveModelSource(contract: ModelContract): string {
  const { entry_name, pin_names, header } = subcircuitHeader(contract)
  const denominator = pin_names.length + 1
  const reserved_nodes = new Set(pin_names.map((pin_name) => pin_name.toLowerCase()))
  const active_paths = pin_names.flatMap((spice_node, index) => {
    // Unique, bounded Thevenin voltages avoid symmetric differential-pin
    // responses while keeping every probe between 0.25 V and 1.25 V.
    const probe_voltage = 0.25 + (index + 1) / denominator
    let probe_node = `N_SENSITIVITY_ACTIVE_${index + 1}`
    while (reserved_nodes.has(probe_node.toLowerCase())) probe_node += "_PRIVATE"
    reserved_nodes.add(probe_node.toLowerCase())
    return [
      `V_ACTIVE_${index + 1} ${probe_node} 0 DC ${probe_voltage}`,
      `R_ACTIVE_${index + 1} ${spice_node} ${probe_node} ${ACTIVE_PROBE_RESISTANCE_OHMS}`,
    ]
  })
  return [
    "* Server-owned active/load-injection DUT sensitivity probe",
    header,
    ...active_paths,
    `.ENDS ${entry_name}`,
    "",
  ].join("\n")
}

function diagnostic(error: ValidationRunResult["errors"][number]): string {
  return `${error.code}${error.path ? ` at ${error.path}` : ""}: ${error.message}`
}

function probeExecutionFailures(result: ValidationRunResult): string[] {
  const failures = result.errors.flatMap((error) =>
    error.kind === "comparison" && VALUE_COMPARISON_FAILURES.has(error.code) ? [] : [diagnostic(error)],
  )
  for (const validation_case of result.cases) {
    for (const series of validation_case.series) {
      const path = `${validation_case.case_id}/${series.observation_id}`
      if (series.points.length === 0)
        failures.push(`${path}: simulation produced an empty observation series`)
      if (series.points.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y))) {
        failures.push(`${path}: simulation produced a non-finite observation sample`)
      }
    }
  }
  return [...new Set(failures)]
}

function seriesKey(case_id: string, observation_id: string): string {
  return `${case_id}/${observation_id}`
}

function indexProbeSeries(input: {
  label: string
  plan: ValidationPlan
  result: ValidationRunResult
}): Map<string, ValidationSeriesResult> {
  const failures = probeExecutionFailures(input.result)
  const expected_keys = new Set(
    input.plan.cases.flatMap((validation_case) =>
      validation_case.observations.map((observation) => seriesKey(validation_case.id, observation.id)),
    ),
  )
  const series_by_key = new Map<string, ValidationSeriesResult>()
  for (const validation_case of input.result.cases) {
    for (const series of validation_case.series) {
      const key = seriesKey(validation_case.case_id, series.observation_id)
      if (!expected_keys.has(key)) failures.push(`${key}: probe returned an unexpected observation`)
      if (series_by_key.has(key)) failures.push(`${key}: probe returned the observation more than once`)
      series_by_key.set(key, series)
    }
  }
  for (const key of expected_keys) {
    if (!series_by_key.has(key)) failures.push(`${key}: probe did not return the required observation`)
  }
  if (failures.length > 0) {
    throw new Error(
      `The hidden ${input.label} DUT sensitivity probe could not execute reliably:\n${[
        ...new Set(failures),
      ].join("\n")}`,
    )
  }
  return series_by_key
}

function coordinatesMatch(left: number, right: number): boolean {
  const tolerance = Math.max(1e-15, Math.max(Math.abs(left), Math.abs(right)) * 1e-9)
  return Math.abs(left - right) <= tolerance
}

function valuesMateriallyDiffer(left: number, right: number, unit: "V" | "A"): boolean {
  const absolute_floor = MATERIAL_ABSOLUTE_DIFFERENCE[unit]
  const relative_floor = Math.max(Math.abs(left), Math.abs(right)) * MATERIAL_RELATIVE_DIFFERENCE
  return Math.abs(left - right) > Math.max(absolute_floor, relative_floor)
}

function observationMateriallyDiffers(input: {
  key: string
  inert: ValidationSeriesResult
  active: ValidationSeriesResult
}): boolean {
  if (
    input.inert.type !== input.active.type ||
    input.inert.unit !== input.active.unit ||
    input.inert.scale !== input.active.scale
  ) {
    throw new Error(`${input.key}: hidden DUT probes returned incompatible observation metadata`)
  }
  if (input.inert.points.length !== input.active.points.length) {
    throw new Error(
      `${input.key}: hidden DUT probes returned different sample counts ` +
        `(${input.inert.points.length} and ${input.active.points.length})`,
    )
  }
  for (let index = 0; index < input.inert.points.length; index += 1) {
    const inert_point = input.inert.points[index]
    const active_point = input.active.points[index]
    if (!inert_point || !active_point) {
      throw new Error(`${input.key}: hidden DUT probe series could not be aligned`)
    }
    if (!coordinatesMatch(inert_point.x, active_point.x)) {
      throw new Error(
        `${input.key}: hidden DUT probes returned mismatched x coordinates at sample ${index} ` +
          `(${inert_point.x} and ${active_point.x})`,
      )
    }
    if (valuesMateriallyDiffer(inert_point.y, active_point.y, input.inert.unit)) return true
  }
  return false
}

async function runProbe(input: {
  label: "weak/inert" | "active/load-injection"
  model_source: string
  plan: ValidationPlan
  contract: ModelContract
  model_dir: string
  artifact_directory: string
  signal?: AbortSignal
  ngspice: NgspiceExecutor
  ngspice_path: string
}): Promise<ValidationRunResult> {
  const manifest = createModelManifest({
    model_interface: input.contract.interface,
    model_source: input.model_source,
    simulator: "ngspice",
  })
  const result = await runSpiceValidation({
    plan: input.plan,
    manifest,
    model_source: input.model_source,
    model_dir: input.model_dir,
    artifact_directory: join(input.artifact_directory, input.label === "weak/inert" ? "inert" : "active"),
    model_contract: input.contract,
    signal: input.signal,
    ngspice: input.ngspice,
    ngspice_path: input.ngspice_path,
  })
  input.signal?.throwIfAborted()
  return result
}

/**
 * Proves that every observation responds to X_DUT by comparing two deterministic
 * server-owned probe models. Passing or failing the requirement is irrelevant:
 * the extracted finite series must change materially when DUT behavior changes.
 */
export async function assertValidationPlanSensitiveToDut(input: {
  plan: ValidationPlan
  contract: ModelContract
  model_dir: string
  artifact_directory: string
  signal?: AbortSignal
  ngspice: NgspiceExecutor
  ngspice_path: string
}): Promise<void> {
  const inert_result = await runProbe({
    ...input,
    label: "weak/inert",
    model_source: createInertModelSource(input.contract),
  })
  const inert_series = indexProbeSeries({ label: "weak/inert", plan: input.plan, result: inert_result })

  const active_result = await runProbe({
    ...input,
    label: "active/load-injection",
    model_source: createActiveModelSource(input.contract),
  })
  const active_series = indexProbeSeries({
    label: "active/load-injection",
    plan: input.plan,
    result: active_result,
  })

  const insensitive_observations: string[] = []
  for (const [key, inert] of inert_series) {
    const active = active_series.get(key)
    if (!active) throw new Error(`${key}: active DUT sensitivity probe did not return the observation`)
    if (!observationMateriallyDiffers({ key, inert, active })) insensitive_observations.push(key)
  }
  if (insensitive_observations.length > 0) {
    throw new Error(
      "Validation observations do not materially respond to server-owned DUT sensitivity probes: " +
        insensitive_observations.join(", "),
    )
  }
}
