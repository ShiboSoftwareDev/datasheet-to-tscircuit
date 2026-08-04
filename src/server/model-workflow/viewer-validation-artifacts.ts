import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import { isCircuitJson } from "../component-circuit-json"
import { readBoundedJsonArtifact } from "../infrastructure/artifacts"
import { assertValidationCircuitEmbedsModel, type GeneratedModel } from "../modeling"
import { hashValidationInputs, sha256Text, stableStringify } from "../spice-validation/hashing"
import type { ValidationPlan } from "../spice-validation/types"

const RECEIPT_FILE = "viewer-validation.json"
const MAX_CIRCUIT_JSON_BYTES = 64 * 1024 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/

interface ViewerCaseReceipt {
  case_id: string
  file: string
  circuit_json_sha256: string
}

interface ViewerValidationReceipt {
  version: 1
  hashes: ReturnType<typeof hashValidationInputs>
  cases: ViewerCaseReceipt[]
}

function hashViewerInputs(input: { plan: ValidationPlan; generated: GeneratedModel }) {
  return hashValidationInputs({
    plan: JSON.parse(JSON.stringify(input.plan)),
    model_source: input.generated.source,
    manifest: JSON.parse(JSON.stringify(input.generated.manifest)),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort()
  const sorted_expected = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(sorted_expected)) {
    throw new Error(`${path} must contain exactly ${sorted_expected.join(", ")}`)
  }
}

function parseReceipt(value: unknown): ViewerValidationReceipt {
  if (!isRecord(value)) throw new Error(`${RECEIPT_FILE} must be an object`)
  assertExactKeys(value, ["version", "hashes", "cases"], RECEIPT_FILE)
  if (value.version !== 1) throw new Error(`${RECEIPT_FILE}.version must be 1`)
  if (!isRecord(value.hashes)) throw new Error(`${RECEIPT_FILE}.hashes must be an object`)
  assertExactKeys(value.hashes, ["plan_sha256", "model_sha256", "manifest_sha256"], `${RECEIPT_FILE}.hashes`)
  const hash_record = value.hashes
  const readHash = (key: "plan_sha256" | "model_sha256" | "manifest_sha256"): string => {
    const hash = hash_record[key]
    if (typeof hash !== "string" || !SHA256_PATTERN.test(hash)) {
      throw new Error(`${RECEIPT_FILE}.hashes.${key} must be a lowercase SHA-256 digest`)
    }
    return hash
  }
  const hashes: ViewerValidationReceipt["hashes"] = {
    plan_sha256: readHash("plan_sha256"),
    model_sha256: readHash("model_sha256"),
    manifest_sha256: readHash("manifest_sha256"),
  }
  if (!Array.isArray(value.cases)) throw new Error(`${RECEIPT_FILE}.cases must be an array`)
  const cases = value.cases.map((entry, index): ViewerCaseReceipt => {
    const path = `${RECEIPT_FILE}.cases[${index}]`
    if (!isRecord(entry)) throw new Error(`${path} must be an object`)
    assertExactKeys(entry, ["case_id", "file", "circuit_json_sha256"], path)
    if (typeof entry.case_id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(entry.case_id)) {
      throw new Error(`${path}.case_id is invalid`)
    }
    const expected_file = `cases/${entry.case_id}.circuit.json`
    if (entry.file !== expected_file) throw new Error(`${path}.file must be ${expected_file}`)
    if (typeof entry.circuit_json_sha256 !== "string" || !SHA256_PATTERN.test(entry.circuit_json_sha256)) {
      throw new Error(`${path}.circuit_json_sha256 must be a lowercase SHA-256 digest`)
    }
    return {
      case_id: entry.case_id,
      file: expected_file,
      circuit_json_sha256: entry.circuit_json_sha256,
    }
  })
  if (new Set(cases.map(({ case_id }) => case_id)).size !== cases.length) {
    throw new Error(`${RECEIPT_FILE}.cases contains duplicate case ids`)
  }
  return { version: 1, hashes, cases }
}

export async function writeViewerValidationArtifacts(input: {
  validation_dir: string
  plan: ValidationPlan
  generated: GeneratedModel
  circuit_json_by_case: Readonly<Record<string, AnyCircuitElement[] | undefined>>
}): Promise<void> {
  await mkdir(join(input.validation_dir, "cases"), { recursive: true })
  const cases: ViewerCaseReceipt[] = []
  for (const validation_case of input.plan.cases) {
    const circuit_json = input.circuit_json_by_case[validation_case.id]
    if (!circuit_json) continue
    const file = `cases/${validation_case.id}.circuit.json`
    await Bun.write(join(input.validation_dir, file), `${JSON.stringify(circuit_json, null, 2)}\n`)
    cases.push({
      case_id: validation_case.id,
      file,
      circuit_json_sha256: sha256Text(stableStringify(circuit_json)),
    })
  }
  const receipt: ViewerValidationReceipt = {
    version: 1,
    hashes: hashViewerInputs(input),
    cases,
  }
  await Bun.write(join(input.validation_dir, RECEIPT_FILE), `${JSON.stringify(receipt, null, 2)}\n`)
}

export async function readVerifiedViewerCircuitJson(input: {
  validation_dir: string
  plan: ValidationPlan
  generated: GeneratedModel
}): Promise<Readonly<Record<string, AnyCircuitElement[]>>> {
  const receipt = parseReceipt(
    await readBoundedJsonArtifact({
      path: join(input.validation_dir, RECEIPT_FILE),
      max_bytes: 256 * 1024,
      max_depth: 16,
      max_nodes: 10_000,
    }),
  )
  const expected_hashes = hashViewerInputs(input)
  for (const key of Object.keys(expected_hashes) as Array<keyof typeof expected_hashes>) {
    if (receipt.hashes[key] !== expected_hashes[key]) {
      throw new Error(`${RECEIPT_FILE}.${key} does not match the validated model inputs`)
    }
  }
  const expected_case_ids = input.plan.cases.map(({ id }) => id).sort()
  const actual_case_ids = receipt.cases.map(({ case_id }) => case_id).sort()
  if (JSON.stringify(actual_case_ids) !== JSON.stringify(expected_case_ids)) {
    throw new Error(`${RECEIPT_FILE} must retain Circuit JSON for every validation case`)
  }

  const circuit_json_by_case: Record<string, AnyCircuitElement[]> = Object.create(null)
  for (const validation_case of input.plan.cases) {
    const entry = receipt.cases.find(({ case_id }) => case_id === validation_case.id)!
    const value = await readBoundedJsonArtifact({
      path: join(input.validation_dir, entry.file),
      max_bytes: MAX_CIRCUIT_JSON_BYTES,
      max_depth: 128,
      max_nodes: 2_000_000,
    })
    if (!isCircuitJson(value)) throw new Error(`${entry.file} is not Circuit JSON`)
    if (sha256Text(stableStringify(value)) !== entry.circuit_json_sha256) {
      throw new Error(`${entry.file} does not match its viewer-validation receipt`)
    }
    assertValidationCircuitEmbedsModel(value, input.generated.source, input.generated.manifest)
    circuit_json_by_case[validation_case.id] = value
  }
  return circuit_json_by_case
}
