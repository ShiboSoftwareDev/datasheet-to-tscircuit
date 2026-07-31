import type { ModelContract } from "../modeling"
import { createModelManifest } from "../modeling"
import {
  runSpiceValidation,
  type NgspiceExecutor,
  type ValidationPlan,
  type ValidationRunResult,
} from "../spice-validation"

function createInertModelSource(contract: ModelContract): string {
  const { entry_name, pins } = contract.interface
  const pin_names = pins.map(({ spice_node }) => spice_node)
  const weak_ground_paths = pin_names.map((spice_node, index) => `R_INERT_${index + 1} ${spice_node} 0 1e15`)
  return [
    "* Server-owned inert-DUT sensitivity baseline",
    `.SUBCKT ${entry_name}${pin_names.length > 0 ? ` ${pin_names.join(" ")}` : ""}`,
    ...weak_ground_paths,
    `.ENDS ${entry_name}`,
    "",
  ].join("\n")
}

function baselineExecutionFailures(result: ValidationRunResult): string[] {
  return result.errors.flatMap((error) =>
    error.kind !== "comparison"
      ? [`${error.code}${error.path ? ` at ${error.path}` : ""}: ${error.message}`]
      : [],
  )
}

/**
 * Runs a server-owned, deliberately inert replacement for X_DUT through the
 * proposed fixtures. Any observation that still passes is independent of the
 * model behavior and therefore cannot validate the linked requirement.
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
  const model_source = createInertModelSource(input.contract)
  const manifest = createModelManifest({
    model_interface: input.contract.interface,
    model_source,
    simulator: "ngspice",
  })
  const result = await runSpiceValidation({
    plan: input.plan,
    manifest,
    model_source,
    model_dir: input.model_dir,
    artifact_directory: input.artifact_directory,
    model_contract: input.contract,
    signal: input.signal,
    ngspice: input.ngspice,
    ngspice_path: input.ngspice_path,
  })
  input.signal?.throwIfAborted()

  const execution_failures = baselineExecutionFailures(result)
  if (execution_failures.length > 0) {
    throw new Error(
      `The hidden inert-DUT sensitivity baseline could not execute reliably:\n${execution_failures.join("\n")}`,
    )
  }

  const insensitive_observations = result.cases.flatMap((validation_case) =>
    validation_case.series.flatMap((series) =>
      series.passed ? [`${validation_case.case_id}/${series.observation_id}`] : [],
    ),
  )
  if (insensitive_observations.length > 0) {
    throw new Error(
      "Validation observations pass with an inert DUT and therefore do not prove model behavior: " +
        insensitive_observations.join(", "),
    )
  }
}
