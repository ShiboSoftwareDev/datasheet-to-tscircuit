import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  assertModelCandidateCheckReceiptMatches,
  ModelCandidateCheckError,
  parseModelCandidateCheckReceipt,
  type CheckedModelCandidate,
  type ModelCandidateCheckReceipt,
} from "./model-candidate-check"
import type { ModelTrainingValidationReport } from "./model-training-validation"

export const MODEL_TRAINING_CHECK_RECEIPT_FILE = ".candidate-training-check.json"
const MAX_TRAINING_RECEIPT_BYTES = 512 * 1024

export interface ModelTrainingCheckReceipt {
  readonly version: 1
  readonly status: "passed" | "failed"
  readonly candidate: ModelCandidateCheckReceipt
  readonly training_plan_sha256: string
  readonly training_validation: ModelTrainingValidationReport
}

const USABLE_COMPARISON_ERROR_CODES = new Set([
  "bounds_exceeded",
  "curve_tolerance_exceeded",
  "target_tolerance_exceeded",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function parseStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined
}

function isTrainingSeries(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["observation_id", "status", "metrics", "samples", "error_codes"])
  ) {
    return false
  }
  if (
    typeof value.observation_id !== "string" ||
    (value.status !== "passed" && value.status !== "failed") ||
    !isRecord(value.metrics) ||
    !Object.values(value.metrics).every(isFiniteNumber) ||
    !parseStringArray(value.error_codes) ||
    !Array.isArray(value.samples)
  ) {
    return false
  }
  return value.samples.every((sample) => {
    if (!isRecord(sample)) return false
    const keys = Object.keys(sample)
    if (!keys.every((key) => ["x", "reference_y", "simulated_y", "error"].includes(key))) return false
    if (!keys.includes("x") || !keys.includes("reference_y")) return false
    return (
      isFiniteNumber(sample.x) &&
      isFiniteNumber(sample.reference_y) &&
      (sample.simulated_y === undefined || isFiniteNumber(sample.simulated_y)) &&
      (sample.error === undefined || isFiniteNumber(sample.error))
    )
  })
}

function parseTrainingValidationReport(value: unknown): ModelTrainingValidationReport {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "status", "cases", "error_codes"]) ||
    value.version !== 1 ||
    (value.status !== "passed" && value.status !== "failed") ||
    !Array.isArray(value.cases) ||
    !parseStringArray(value.error_codes)
  ) {
    throw new Error("training validation report has an invalid schema")
  }
  for (const validation_case of value.cases) {
    if (
      !isRecord(validation_case) ||
      !hasExactKeys(validation_case, [
        "case_id",
        "status",
        "server_series",
        "viewer_series",
        "error_codes",
      ]) ||
      typeof validation_case.case_id !== "string" ||
      (validation_case.status !== "passed" && validation_case.status !== "failed") ||
      !Array.isArray(validation_case.server_series) ||
      !validation_case.server_series.every(isTrainingSeries) ||
      !Array.isArray(validation_case.viewer_series) ||
      !validation_case.viewer_series.every(isTrainingSeries) ||
      !parseStringArray(validation_case.error_codes)
    ) {
      throw new Error("training validation case has an invalid schema")
    }
  }
  const report = value as unknown as ModelTrainingValidationReport
  const all_cases_pass = report.cases.every((validation_case) => validation_case.status === "passed")
  if (
    (report.status === "passed" && !all_cases_pass) ||
    (report.status === "failed" && all_cases_pass && report.error_codes.length === 0)
  ) {
    throw new Error("training validation status disagrees with its case results")
  }
  return report
}

async function trainingPlanSha256(workspace: string): Promise<string> {
  const plan = await readFile(join(workspace, "model-training-plan.json"))
  return createHash("sha256").update(plan).digest("hex")
}

export async function createModelTrainingCheckReceipt(input: {
  workspace: string
  candidate: ModelCandidateCheckReceipt
  training_validation: ModelTrainingValidationReport
}): Promise<ModelTrainingCheckReceipt> {
  return {
    version: 1,
    status: input.training_validation.status,
    candidate: input.candidate,
    training_plan_sha256: await trainingPlanSha256(input.workspace),
    training_validation: input.training_validation,
  }
}

export async function readModelTrainingCheckReceipt(workspace: string): Promise<ModelTrainingCheckReceipt> {
  let value: unknown
  try {
    const text = await readFile(join(workspace, MODEL_TRAINING_CHECK_RECEIPT_FILE), "utf8")
    if (Buffer.byteLength(text) > MAX_TRAINING_RECEIPT_BYTES) {
      throw new Error("training receipt is unexpectedly large")
    }
    value = JSON.parse(text)
  } catch (error) {
    throw new ModelCandidateCheckError(
      "visible_training_validation_failed",
      `check_model_candidate must pass the final model through public ngspice and tscircuit-viewer training validation: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? { cause: error } : undefined,
    )
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "status", "candidate", "training_plan_sha256", "training_validation"])
  ) {
    throw new ModelCandidateCheckError(
      "visible_training_validation_failed",
      "check_model_candidate public-training receipt has an invalid schema",
    )
  }
  try {
    const candidate = parseModelCandidateCheckReceipt(value.candidate)
    const training_validation = parseTrainingValidationReport(value.training_validation)
    if (
      value.version !== 1 ||
      (value.status !== "passed" && value.status !== "failed") ||
      value.status !== training_validation.status ||
      typeof value.training_plan_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.training_plan_sha256)
    ) {
      throw new Error("public-training receipt has invalid fields")
    }
    return { ...value, candidate, training_validation } as ModelTrainingCheckReceipt
  } catch (error) {
    if (error instanceof ModelCandidateCheckError) throw error
    throw new ModelCandidateCheckError(
      "visible_training_validation_failed",
      error instanceof Error ? error.message : String(error),
      error instanceof Error ? { cause: error } : undefined,
    )
  }
}

async function assertModelTrainingCheckReceiptIntegrityMatches(input: {
  workspace: string
  receipt: ModelTrainingCheckReceipt
  checked: CheckedModelCandidate
  allow_missing_viewer_series?: boolean
}): Promise<void> {
  assertModelCandidateCheckReceiptMatches(input.receipt.candidate, input.checked)
  if (input.receipt.training_plan_sha256 !== (await trainingPlanSha256(input.workspace))) {
    throw new ModelCandidateCheckError(
      "visible_training_validation_failed",
      "The public training plan changed after check_model_candidate ran; rerun the check",
    )
  }
  let expected_cases: Array<{ id: string; observation_ids: string[] }>
  try {
    const plan = JSON.parse(await readFile(join(input.workspace, "model-training-plan.json"), "utf8")) as {
      cases?: Array<{ id?: unknown; observations?: Array<{ id?: unknown }> }>
    }
    if (
      !Array.isArray(plan.cases) ||
      plan.cases.some(
        ({ id, observations }) =>
          typeof id !== "string" ||
          !Array.isArray(observations) ||
          observations.some(({ id: observation_id }) => typeof observation_id !== "string"),
      )
    ) {
      throw new Error("public training plan has invalid cases")
    }
    expected_cases = plan.cases.map(({ id, observations }) => ({
      id: id as string,
      observation_ids: observations!.map(({ id: observation_id }) => observation_id as string),
    }))
  } catch (error) {
    throw new ModelCandidateCheckError(
      "visible_training_validation_failed",
      `The server-owned public training plan could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? { cause: error } : undefined,
    )
  }
  const expected_case_ids = expected_cases.map(({ id }) => id)
  const reported_case_ids = input.receipt.training_validation.cases.map(({ case_id }) => case_id)
  if (JSON.stringify(reported_case_ids) !== JSON.stringify(expected_case_ids)) {
    throw new ModelCandidateCheckError(
      "visible_training_validation_failed",
      "check_model_candidate did not validate every case in the exact public training plan",
    )
  }
  for (const [index, expected_case] of expected_cases.entries()) {
    const reported_case = input.receipt.training_validation.cases[index]!
    for (const [engine, series] of [
      ["ngspice", reported_case.server_series],
      ["tscircuit viewer", reported_case.viewer_series],
    ] as const) {
      const observation_ids = series.map(({ observation_id }) => observation_id)
      if (
        engine === "tscircuit viewer" &&
        input.allow_missing_viewer_series &&
        observation_ids.every((observation_id) => expected_case.observation_ids.includes(observation_id)) &&
        new Set(observation_ids).size === observation_ids.length
      ) {
        continue
      }
      if (JSON.stringify(observation_ids) !== JSON.stringify(expected_case.observation_ids)) {
        throw new ModelCandidateCheckError(
          "visible_training_validation_failed",
          `check_model_candidate did not return every ${engine} series for public case ${expected_case.id}`,
        )
      }
    }
  }
}

export async function assertModelTrainingCheckReceiptMatches(input: {
  workspace: string
  receipt: ModelTrainingCheckReceipt
  checked: CheckedModelCandidate
}): Promise<void> {
  await assertModelTrainingCheckReceiptIntegrityMatches(input)
  if (input.receipt.status !== "passed") {
    const codes = input.receipt.training_validation.error_codes.join(", ") || "comparison_failed"
    throw new ModelCandidateCheckError(
      "visible_training_validation_failed",
      `The final candidate failed public ngspice or tscircuit-viewer training validation (${codes}); repair it and rerun check_model_candidate`,
    )
  }
}

/**
 * A generation/repair seed may miss numeric tolerances, but it must be a real,
 * complete direct-and-viewer run. This lets authoritative validation build the
 * visible TSX/reference comparisons without weakening final publication.
 */
export async function assertModelTrainingCheckReceiptUsable(input: {
  workspace: string
  receipt: ModelTrainingCheckReceipt
  checked: CheckedModelCandidate
}): Promise<void> {
  await assertModelTrainingCheckReceiptIntegrityMatches({
    ...input,
    allow_missing_viewer_series: true,
  })
  const report = input.receipt.training_validation
  if (report.cases.some(({ server_series }) => server_series.length === 0)) {
    throw new ModelCandidateCheckError(
      "visible_training_validation_failed",
      "The candidate did not produce a public ngspice comparison series and cannot seed authoritative validation",
    )
  }
  const all_error_codes = [
    ...report.error_codes,
    ...report.cases.flatMap(({ error_codes }) => error_codes),
    ...report.cases.flatMap(({ server_series, viewer_series }) =>
      [...server_series, ...viewer_series].flatMap(({ error_codes }) => error_codes),
    ),
  ]
  const has_complete_server_case_set =
    report.cases.length > 0 && report.cases.every(({ server_series }) => server_series.length > 0)
  const inspectable_candidate_errors = new Set([
    ...USABLE_COMPARISON_ERROR_CODES,
    ...(has_complete_server_case_set ? ["viewer_validation_unavailable", "viewer_simulation_failed"] : []),
  ])
  const non_comparison_errors = [...new Set(all_error_codes)].filter(
    (code) => !inspectable_candidate_errors.has(code),
  )
  if (non_comparison_errors.length > 0) {
    throw new ModelCandidateCheckError(
      "visible_training_validation_failed",
      `The candidate failed public ngspice or tscircuit-viewer training validation because the development run was not fully executable (${non_comparison_errors.join(", ")}); repair simulator/model execution before authoritative validation`,
    )
  }
  for (const validation_case of report.cases) {
    for (const series of validation_case.server_series) {
      if (
        !Number.isFinite(series.metrics.normalized_max_error) ||
        !Number.isFinite(series.metrics.normalized_rmse) ||
        series.samples.length === 0 ||
        series.samples.some(
          ({ simulated_y, error }) => !Number.isFinite(simulated_y) || !Number.isFinite(error),
        )
      ) {
        throw new ModelCandidateCheckError(
          "visible_training_validation_failed",
          `Public case ${validation_case.case_id}/${series.observation_id} did not produce a complete finite comparison series`,
        )
      }
    }
  }
}
