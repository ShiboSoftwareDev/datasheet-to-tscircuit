import type { ModelManifest } from "@/shared/job-types"
import { createModelManifest, type ModelContract, parseModelContract } from "../modeling"
import {
  hashValidationInputs,
  parseValidationPlan,
  type ValidationInputHashes,
  type ValidationPlan,
  type ValidationRunResult,
} from "../spice-validation"

const SHA256_PATTERN = /^[a-f0-9]{64}$/

type UnknownRecord = Record<string, unknown>

export type ModelCompletionIntegrity =
  | {
      valid: true
      contract: ModelContract
      manifest: ModelManifest
      plan: ValidationPlan
      result: ValidationRunResult
    }
  | { valid: false; reason: string }

function record(value: unknown, artifact: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${artifact} must contain a JSON object`)
  }
  return value as UnknownRecord
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`)
  return value
}

function exactKeys(value: UnknownRecord, keys: readonly string[], artifact: string): void {
  const allowed = new Set(keys)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new Error(`${artifact} contains unknown field ${JSON.stringify(unknown[0])}`)
}

function parseManifest(value: unknown, contract: ModelContract, model_source: string): ModelManifest {
  const manifest = record(value, "model-manifest.json")
  exactKeys(
    manifest,
    [
      "version",
      "part_number",
      "dialect",
      "entry_name",
      "model_file",
      "revision",
      "simulator",
      "generated_at",
      "pins",
    ],
    "model-manifest.json",
  )
  if (manifest.version !== 1) throw new Error("model-manifest.json.version must be 1")
  if (manifest.dialect !== "portable" && manifest.dialect !== "ngspice" && manifest.dialect !== "pspice") {
    throw new Error("model-manifest.json.dialect is unsupported")
  }
  if (!Array.isArray(manifest.pins) || manifest.pins.length === 0) {
    throw new Error("model-manifest.json.pins must be a non-empty array")
  }
  const pins = manifest.pins.map((pin_value, index) => {
    const path = `model-manifest.json.pins[${index}]`
    const pin = record(pin_value, path)
    exactKeys(pin, ["component_pin", "spice_node"], path)
    return {
      component_pin: nonEmptyString(pin.component_pin, `${path}.component_pin`),
      spice_node: nonEmptyString(pin.spice_node, `${path}.spice_node`),
    }
  })
  const parsed: ModelManifest = {
    version: 1,
    part_number: nonEmptyString(manifest.part_number, "model-manifest.json.part_number"),
    dialect: manifest.dialect,
    entry_name: nonEmptyString(manifest.entry_name, "model-manifest.json.entry_name"),
    model_file: nonEmptyString(manifest.model_file, "model-manifest.json.model_file"),
    revision: nonEmptyString(manifest.revision, "model-manifest.json.revision"),
    simulator: nonEmptyString(manifest.simulator, "model-manifest.json.simulator"),
    generated_at: nonEmptyString(manifest.generated_at, "model-manifest.json.generated_at"),
    pins,
  }
  if (!Number.isFinite(Date.parse(parsed.generated_at))) {
    throw new Error("model-manifest.json.generated_at must be an ISO timestamp")
  }
  const derived = createModelManifest({
    model_interface: contract.interface,
    model_source,
    simulator: "ngspice",
  })
  const comparisons: Array<[string, unknown, unknown]> = [
    ["part_number", parsed.part_number, derived.part_number],
    ["dialect", parsed.dialect, derived.dialect],
    ["entry_name", parsed.entry_name, derived.entry_name],
    ["model_file", parsed.model_file, derived.model_file],
    ["revision", parsed.revision, derived.revision],
    ["simulator", parsed.simulator, derived.simulator],
    ["pins", parsed.pins, derived.pins],
  ]
  for (const [field, actual, expected] of comparisons) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`model-manifest.json.${field} does not match the current model contract and model.lib`)
    }
  }
  return parsed
}

function parseHashes(value: unknown): ValidationInputHashes {
  const hashes = record(value, "validation-results.json.hashes")
  exactKeys(hashes, ["plan_sha256", "model_sha256", "manifest_sha256"], "validation-results.json.hashes")
  const parsed: ValidationInputHashes = {
    plan_sha256: nonEmptyString(hashes.plan_sha256, "validation-results.json.hashes.plan_sha256"),
    model_sha256: nonEmptyString(hashes.model_sha256, "validation-results.json.hashes.model_sha256"),
    manifest_sha256: nonEmptyString(hashes.manifest_sha256, "validation-results.json.hashes.manifest_sha256"),
  }
  for (const [name, hash] of Object.entries(parsed)) {
    if (!SHA256_PATTERN.test(hash)) throw new Error(`validation-results.json.hashes.${name} is not SHA-256`)
  }
  return parsed
}

function requireEmptyErrors(value: unknown, path: string): void {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  if (value.length > 0) throw new Error(`${path} must be empty for a passing validation result`)
}

function parsePassedResult(value: unknown, plan: ValidationPlan): ValidationRunResult {
  const result = record(value, "validation-results.json")
  exactKeys(result, ["version", "passed", "hashes", "cases", "errors"], "validation-results.json")
  if (result.version !== 1) throw new Error("validation-results.json.version must be 1")
  if (result.passed !== true) throw new Error("validation-results.json does not contain a passing result")
  const hashes = parseHashes(result.hashes)
  requireEmptyErrors(result.errors, "validation-results.json.errors")
  if (!Array.isArray(result.cases)) throw new Error("validation-results.json.cases must be an array")
  if (result.cases.length !== plan.cases.length) {
    throw new Error(
      `validation-results.json.cases has ${result.cases.length} cases; the current plan has ${plan.cases.length}`,
    )
  }
  result.cases.forEach((case_value, case_index) => {
    const path = `validation-results.json.cases[${case_index}]`
    const validation_case = record(case_value, path)
    const planned_case = plan.cases[case_index]
    if (!planned_case || validation_case.case_id !== planned_case.id) {
      throw new Error(`${path}.case_id does not match the current validation plan`)
    }
    if (validation_case.status !== "passed") throw new Error(`${path}.status must be passed`)
    if (validation_case.analysis !== planned_case.analysis.type) {
      throw new Error(`${path}.analysis does not match the current validation plan`)
    }
    requireEmptyErrors(validation_case.errors, `${path}.errors`)
    if (!SHA256_PATTERN.test(nonEmptyString(validation_case.netlist_sha256, `${path}.netlist_sha256`))) {
      throw new Error(`${path}.netlist_sha256 is not SHA-256`)
    }
    if (!SHA256_PATTERN.test(nonEmptyString(validation_case.raw_sha256, `${path}.raw_sha256`))) {
      throw new Error(`${path}.raw_sha256 is not SHA-256`)
    }
    if (!Array.isArray(validation_case.series)) throw new Error(`${path}.series must be an array`)
    if (validation_case.series.length !== planned_case.observations.length) {
      throw new Error(`${path}.series does not cover every current validation-plan observation`)
    }
    validation_case.series.forEach((series_value, series_index) => {
      const series_path = `${path}.series[${series_index}]`
      const series = record(series_value, series_path)
      if (series.observation_id !== planned_case.observations[series_index]?.id) {
        throw new Error(`${series_path}.observation_id does not match the current validation plan`)
      }
      if (series.passed !== true) throw new Error(`${series_path}.passed must be true`)
      requireEmptyErrors(series.errors, `${series_path}.errors`)
      if (!Array.isArray(series.points) || series.points.length === 0) {
        throw new Error(`${series_path}.points must contain simulator output`)
      }
    })
  })
  return { ...(value as ValidationRunResult), hashes }
}

function readableError(error: unknown): string {
  if (error instanceof AggregateError) {
    const details = error.errors
      .map((item) => (item instanceof Error ? item.message : String(item)))
      .filter(Boolean)
    return details[0] ?? error.message
  }
  return error instanceof Error ? error.message : String(error)
}

export function validateModelCompletionIntegrity(input: {
  model_source: string | undefined
  manifest: unknown
  contract: unknown
  plan: unknown
  result: unknown
}): ModelCompletionIntegrity {
  try {
    if (
      typeof input.result !== "object" ||
      input.result === null ||
      Array.isArray(input.result) ||
      !("passed" in input.result) ||
      input.result.passed !== true
    ) {
      throw new Error("no passing server-owned validation result is present")
    }
    if (typeof input.model_source !== "string" || !input.model_source.trim()) {
      throw new Error("model.lib is missing or empty")
    }
    const contract = parseModelContract(input.contract)
    const manifest = parseManifest(input.manifest, contract, input.model_source)
    const plan = parseValidationPlan(input.plan, {
      manifest,
      model_source: input.model_source,
      model_requirements: contract.characterization.requirements,
    })
    const result = parsePassedResult(input.result, plan)
    const current_hashes = hashValidationInputs({
      plan: input.plan,
      model_source: input.model_source,
      manifest,
    })
    const mismatches = (Object.keys(current_hashes) as Array<keyof ValidationInputHashes>).filter(
      (key) => current_hashes[key] !== result.hashes[key],
    )
    if (mismatches.length > 0) {
      throw new Error(
        `validation input hash mismatch for ${mismatches
          .map((key) =>
            key === "plan_sha256"
              ? "validation-plan.json"
              : key === "model_sha256"
                ? "model.lib"
                : "model-manifest.json",
          )
          .join(", ")}`,
      )
    }
    return { valid: true, contract, manifest, plan, result }
  } catch (error) {
    return { valid: false, reason: readableError(error) }
  }
}
