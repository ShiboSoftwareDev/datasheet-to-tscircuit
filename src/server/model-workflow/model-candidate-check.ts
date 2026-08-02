import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ModelInterface } from "../modeling"
import { parseModelInterface, readGeneratedModel, type GeneratedModel } from "../modeling"
import { ProcessError } from "../infrastructure/process"
import type { NgspiceExecutor } from "../spice-validation"
import { assertNgspiceAcceptsModelCandidate } from "./model-candidate-smoke"

export type ModelCandidateCheckCode =
  | "model_interface_invalid"
  | "model_artifact_invalid"
  | "model_card_empty"
  | "ngspice_smoke_failed"

export class ModelCandidateCheckError extends Error {
  readonly code: ModelCandidateCheckCode

  constructor(code: ModelCandidateCheckCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ModelCandidateCheckError"
    this.code = code
  }
}

export interface ModelCandidateCheckReceipt {
  readonly version: 1
  readonly status: "passed"
  readonly checks: readonly ["model_contract", "model_card", "ngspice_smoke"]
  readonly revision: string
  readonly entry_name: string
  readonly pin_count: number
  readonly model_card_sha256: string
}

export const MODEL_CANDIDATE_CHECK_RECEIPT_FILE = ".candidate-check.json"

export interface CheckedModelCandidate {
  readonly generated: GeneratedModel
  readonly receipt: ModelCandidateCheckReceipt
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reads the receipt emitted by the trusted check_model_candidate tool. */
export async function readModelCandidateCheckReceipt(workspace: string): Promise<ModelCandidateCheckReceipt> {
  let value: unknown
  try {
    const text = await readFile(join(workspace, MODEL_CANDIDATE_CHECK_RECEIPT_FILE), "utf8")
    if (text.length > 16_000) throw new Error("receipt is unexpectedly large")
    value = JSON.parse(text)
  } catch (error) {
    throw new ModelCandidateCheckError(
      "model_artifact_invalid",
      `check_model_candidate must be called after the final output edit: ${messageOf(error)}`,
      { cause: error },
    )
  }
  if (!isRecord(value) || value.version !== 1 || value.status !== "passed") {
    throw new ModelCandidateCheckError(
      "model_artifact_invalid",
      "check_model_candidate must return a passed receipt after the final output edit",
    )
  }
  const expected_keys = [
    "checks",
    "entry_name",
    "model_card_sha256",
    "pin_count",
    "revision",
    "status",
    "version",
  ]
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected_keys)) {
    throw new ModelCandidateCheckError(
      "model_artifact_invalid",
      "check_model_candidate receipt has an invalid schema",
    )
  }
  if (
    JSON.stringify(value.checks) !== JSON.stringify(["model_contract", "model_card", "ngspice_smoke"]) ||
    typeof value.revision !== "string" ||
    !/^[a-f0-9]{16}$/.test(value.revision) ||
    typeof value.entry_name !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.entry_name) ||
    typeof value.pin_count !== "number" ||
    !Number.isInteger(value.pin_count) ||
    value.pin_count < 1 ||
    typeof value.model_card_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.model_card_sha256)
  ) {
    throw new ModelCandidateCheckError(
      "model_artifact_invalid",
      "check_model_candidate receipt has invalid fields",
    )
  }
  return value as unknown as ModelCandidateCheckReceipt
}

export function assertModelCandidateCheckReceiptMatches(
  receipt: ModelCandidateCheckReceipt,
  checked: CheckedModelCandidate,
): void {
  if (
    receipt.revision !== checked.receipt.revision ||
    receipt.entry_name !== checked.receipt.entry_name ||
    receipt.pin_count !== checked.receipt.pin_count ||
    receipt.model_card_sha256 !== checked.receipt.model_card_sha256
  ) {
    throw new ModelCandidateCheckError(
      "model_artifact_invalid",
      "model.lib or model-card.md changed after check_model_candidate passed; rerun the check after the final edit",
    )
  }
}

async function readCandidateInterface(workspace: string): Promise<ModelInterface> {
  try {
    return parseModelInterface(JSON.parse(await readFile(join(workspace, "model-interface.json"), "utf8")))
  } catch (error) {
    throw new ModelCandidateCheckError(
      "model_interface_invalid",
      `The server-owned model interface could not be read: ${messageOf(error)}`,
      { cause: error },
    )
  }
}

/**
 * The single public candidate gate shared by the constrained model agent and
 * the authoritative post-agent artifact stage. It checks only agent-visible
 * artifacts and a server-owned zero-bias harness; held-out validation cases do
 * not enter this workspace or its diagnostics.
 */
export async function checkModelCandidate(input: {
  workspace: string
  model_interface?: ModelInterface
  ngspice: NgspiceExecutor
  ngspice_path: string
  signal: AbortSignal
}): Promise<CheckedModelCandidate> {
  input.signal.throwIfAborted()
  const model_interface = input.model_interface ?? (await readCandidateInterface(input.workspace))
  let generated: GeneratedModel
  try {
    generated = await readGeneratedModel({
      model_dir: input.workspace,
      model_interface,
    })
  } catch (error) {
    throw new ModelCandidateCheckError(
      "model_artifact_invalid",
      `The candidate model artifacts are invalid: ${messageOf(error)}`,
      { cause: error },
    )
  }
  if (!generated.card.trim()) {
    throw new ModelCandidateCheckError("model_card_empty", "model-card.md must not be empty")
  }
  try {
    await assertNgspiceAcceptsModelCandidate({
      workspace: input.workspace,
      manifest: generated.manifest,
      ngspice: input.ngspice,
      ngspice_path: input.ngspice_path,
      signal: input.signal,
    })
  } catch (error) {
    // Process/infrastructure errors retain their original type so the artifact
    // runner can stop without spending another model-generation attempt.
    if (!(error instanceof ProcessError)) {
      throw new ModelCandidateCheckError(
        "ngspice_smoke_failed",
        messageOf(error),
        error instanceof Error ? { cause: error } : undefined,
      )
    }
    throw error
  }
  return {
    generated,
    receipt: {
      version: 1,
      status: "passed",
      checks: ["model_contract", "model_card", "ngspice_smoke"],
      revision: generated.manifest.revision,
      entry_name: generated.manifest.entry_name,
      pin_count: generated.manifest.pins.length,
      model_card_sha256: sha256Text(generated.card),
    },
  }
}
