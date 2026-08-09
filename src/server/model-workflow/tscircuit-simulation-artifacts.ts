import type { AnyCircuitElement } from "circuit-json"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { isCircuitJson } from "../component-circuit-json"
import { readBoundedJsonArtifact } from "../infrastructure/artifacts"
import type { GeneratedModel } from "../modeling"
import { hashValidationInputs, sha256Text, stableStringify } from "../spice-validation/hashing"
import type { ValidationPlan } from "../spice-validation/types"
import type { TscircuitSimulationBuild } from "./validation-circuit-previews"

export const TSCIRCUIT_SIMULATION_RECEIPT = "tscircuit-simulation-results.json"

const MAX_CIRCUIT_JSON_BYTES = 64 * 1024 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const CASE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/

type SimulationFailureKind = "build" | "simulation"

interface CompletedSimulationCaseReceipt {
  case_id: string
  status: "completed"
  file: string
  circuit_json_sha256: string
}

interface FailedSimulationCaseReceipt {
  case_id: string
  status: "failed"
  failure_kind: SimulationFailureKind
  error: string
  file?: string
  circuit_json_sha256?: string
}

type SimulationCaseReceipt = CompletedSimulationCaseReceipt | FailedSimulationCaseReceipt

interface TscircuitSimulationReceipt {
  version: 1
  hashes: ReturnType<typeof hashValidationInputs>
  cases: SimulationCaseReceipt[]
}

function simulationHashes(input: { plan: ValidationPlan; generated: GeneratedModel }) {
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
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${path} must contain exactly ${wanted.join(", ")}`)
  }
}

function readHash(value: unknown, path: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${path} must be a lowercase SHA-256 digest`)
  }
  return value
}

function parseReceipt(value: unknown): TscircuitSimulationReceipt {
  if (!isRecord(value)) throw new Error(`${TSCIRCUIT_SIMULATION_RECEIPT} must be an object`)
  assertExactKeys(value, ["version", "hashes", "cases"], TSCIRCUIT_SIMULATION_RECEIPT)
  if (value.version !== 1) throw new Error(`${TSCIRCUIT_SIMULATION_RECEIPT}.version must be 1`)
  if (!isRecord(value.hashes)) {
    throw new Error(`${TSCIRCUIT_SIMULATION_RECEIPT}.hashes must be an object`)
  }
  assertExactKeys(
    value.hashes,
    ["plan_sha256", "model_sha256", "manifest_sha256"],
    `${TSCIRCUIT_SIMULATION_RECEIPT}.hashes`,
  )
  const hashes: TscircuitSimulationReceipt["hashes"] = {
    plan_sha256: readHash(value.hashes.plan_sha256, `${TSCIRCUIT_SIMULATION_RECEIPT}.hashes.plan_sha256`),
    model_sha256: readHash(value.hashes.model_sha256, `${TSCIRCUIT_SIMULATION_RECEIPT}.hashes.model_sha256`),
    manifest_sha256: readHash(
      value.hashes.manifest_sha256,
      `${TSCIRCUIT_SIMULATION_RECEIPT}.hashes.manifest_sha256`,
    ),
  }
  if (!Array.isArray(value.cases)) {
    throw new Error(`${TSCIRCUIT_SIMULATION_RECEIPT}.cases must be an array`)
  }
  const cases = value.cases.map((entry, index): SimulationCaseReceipt => {
    const path = `${TSCIRCUIT_SIMULATION_RECEIPT}.cases[${index}]`
    if (!isRecord(entry)) throw new Error(`${path} must be an object`)
    if (typeof entry.case_id !== "string" || !CASE_ID_PATTERN.test(entry.case_id)) {
      throw new Error(`${path}.case_id is invalid`)
    }
    const expected_file = `cases/${entry.case_id}.circuit.json`
    if (entry.status === "completed") {
      assertExactKeys(entry, ["case_id", "status", "file", "circuit_json_sha256"], path)
      if (entry.file !== expected_file) throw new Error(`${path}.file must be ${expected_file}`)
      return {
        case_id: entry.case_id,
        status: "completed",
        file: expected_file,
        circuit_json_sha256: readHash(entry.circuit_json_sha256, `${path}.circuit_json_sha256`),
      }
    }
    if (entry.status !== "failed") throw new Error(`${path}.status must be completed or failed`)
    const has_file = entry.file !== undefined || entry.circuit_json_sha256 !== undefined
    assertExactKeys(
      entry,
      has_file
        ? ["case_id", "status", "failure_kind", "error", "file", "circuit_json_sha256"]
        : ["case_id", "status", "failure_kind", "error"],
      path,
    )
    if (entry.failure_kind !== "build" && entry.failure_kind !== "simulation") {
      throw new Error(`${path}.failure_kind must be build or simulation`)
    }
    if (typeof entry.error !== "string" || !entry.error.trim() || entry.error.length > 8_000) {
      throw new Error(`${path}.error must be a bounded non-empty string`)
    }
    if (!has_file) {
      return {
        case_id: entry.case_id,
        status: "failed",
        failure_kind: entry.failure_kind,
        error: entry.error,
      }
    }
    if (entry.file !== expected_file) throw new Error(`${path}.file must be ${expected_file}`)
    return {
      case_id: entry.case_id,
      status: "failed",
      failure_kind: entry.failure_kind,
      error: entry.error,
      file: expected_file,
      circuit_json_sha256: readHash(entry.circuit_json_sha256, `${path}.circuit_json_sha256`),
    }
  })
  if (new Set(cases.map(({ case_id }) => case_id)).size !== cases.length) {
    throw new Error(`${TSCIRCUIT_SIMULATION_RECEIPT}.cases contains duplicate case ids`)
  }
  return { version: 1, hashes, cases }
}

export async function writeTscircuitSimulationArtifacts(input: {
  simulation_dir: string
  plan: ValidationPlan
  generated: GeneratedModel
  simulations: TscircuitSimulationBuild
}): Promise<string> {
  await mkdir(join(input.simulation_dir, "cases"), { recursive: true })
  const cases: SimulationCaseReceipt[] = []
  for (const validation_case of input.plan.cases) {
    const case_id = validation_case.id
    const circuit_json = input.simulations.circuit_json_by_case[case_id]
    const build_error = input.simulations.circuit_build_errors_by_case[case_id]
    const simulation_error = input.simulations.simulation_errors_by_case[case_id]
    const error = build_error ?? simulation_error
    const file = `cases/${case_id}.circuit.json`
    const stored = circuit_json
      ? {
          file,
          circuit_json_sha256: sha256Text(stableStringify(circuit_json)),
        }
      : undefined
    if (circuit_json) {
      await Bun.write(join(input.simulation_dir, file), `${JSON.stringify(circuit_json, null, 2)}\n`)
    }
    if (error) {
      cases.push({
        case_id,
        status: "failed",
        failure_kind: build_error ? "build" : "simulation",
        error,
        ...stored,
      })
    } else if (stored) {
      cases.push({ case_id, status: "completed", ...stored })
    } else {
      cases.push({
        case_id,
        status: "failed",
        failure_kind: "build",
        error: "tsci produced no saved Circuit JSON",
      })
    }
  }
  const receipt: TscircuitSimulationReceipt = {
    version: 1,
    hashes: simulationHashes(input),
    cases,
  }
  const receipt_path = join(input.simulation_dir, TSCIRCUIT_SIMULATION_RECEIPT)
  await Bun.write(receipt_path, `${JSON.stringify(receipt, null, 2)}\n`)
  return receipt_path
}

export async function readTscircuitSimulationArtifacts(input: {
  receipt_path: string
  plan: ValidationPlan
  generated: GeneratedModel
}): Promise<TscircuitSimulationBuild> {
  const receipt = parseReceipt(
    await readBoundedJsonArtifact({
      path: input.receipt_path,
      max_bytes: 256 * 1024,
      max_depth: 16,
      max_nodes: 20_000,
    }),
  )
  const expected_hashes = simulationHashes(input)
  for (const key of Object.keys(expected_hashes) as Array<keyof typeof expected_hashes>) {
    if (receipt.hashes[key] !== expected_hashes[key]) {
      throw new Error(`${TSCIRCUIT_SIMULATION_RECEIPT}.${key} does not match the executed TSX inputs`)
    }
  }
  const expected_case_ids = input.plan.cases.map(({ id }) => id).sort()
  const actual_case_ids = receipt.cases.map(({ case_id }) => case_id).sort()
  if (JSON.stringify(actual_case_ids) !== JSON.stringify(expected_case_ids)) {
    throw new Error(`${TSCIRCUIT_SIMULATION_RECEIPT} must describe every validation case`)
  }

  const simulation_dir = dirname(input.receipt_path)
  const circuit_json_by_case: Record<string, AnyCircuitElement[] | undefined> = Object.create(null)
  const circuit_build_errors_by_case: Record<string, string | undefined> = Object.create(null)
  const simulation_errors_by_case: Record<string, string | undefined> = Object.create(null)
  for (const entry of receipt.cases) {
    if (entry.file && entry.circuit_json_sha256) {
      const value = await readBoundedJsonArtifact({
        path: join(simulation_dir, entry.file),
        max_bytes: MAX_CIRCUIT_JSON_BYTES,
        max_depth: 128,
        max_nodes: 2_000_000,
      })
      if (!isCircuitJson(value)) throw new Error(`${entry.file} is not Circuit JSON`)
      if (sha256Text(stableStringify(value)) !== entry.circuit_json_sha256) {
        throw new Error(`${entry.file} does not match its tscircuit simulation receipt`)
      }
      circuit_json_by_case[entry.case_id] = value
    }
    if (entry.status === "failed") {
      if (entry.failure_kind === "build") circuit_build_errors_by_case[entry.case_id] = entry.error
      else simulation_errors_by_case[entry.case_id] = entry.error
    }
  }
  return { circuit_json_by_case, circuit_build_errors_by_case, simulation_errors_by_case }
}
