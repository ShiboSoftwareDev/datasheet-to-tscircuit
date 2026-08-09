import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ModelContract, ModelInterface } from "../modeling"
import {
  type GeneratedModel,
  parseModelInterface,
  readGeneratedModel,
  validateFreshModelSource,
} from "../modeling"

export type ModelCandidateCheckCode =
  | "model_interface_invalid"
  | "model_artifact_invalid"
  | "model_card_empty"
  | "ngspice_smoke_failed"
  | "visible_training_validation_failed"

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
  readonly checks:
    | readonly ["model_contract", "model_card", "static_source"]
    | readonly ["model_contract", "model_card", "ngspice_smoke"]
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

export function parseModelCandidateCheckReceipt(value: unknown): ModelCandidateCheckReceipt {
  if (!isRecord(value) || value.version !== 1 || value.status !== "passed") {
    throw new ModelCandidateCheckError(
      "model_artifact_invalid",
      "check_model_candidate must return a passed smoke receipt after the final output edit",
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
      "check_model_candidate smoke receipt has an invalid schema",
    )
  }
  if (
    ![
      JSON.stringify(["model_contract", "model_card", "static_source"]),
      JSON.stringify(["model_contract", "model_card", "ngspice_smoke"]),
    ].includes(JSON.stringify(value.checks)) ||
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
      "check_model_candidate smoke receipt has invalid fields",
    )
  }
  return value as unknown as ModelCandidateCheckReceipt
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
  return parseModelCandidateCheckReceipt(value)
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
 * artifacts. Simulation belongs to Run Simulations, never model inference.
 */
export async function checkModelCandidate(input: {
  workspace: string
  model_interface?: ModelInterface
  model_contract?: ModelContract
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
    if (input.model_contract) validateFreshModelSource(generated.source, input.model_contract)
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
  return {
    generated,
    receipt: {
      version: 1,
      status: "passed",
      checks: ["model_contract", "model_card", "static_source"],
      revision: generated.manifest.revision,
      entry_name: generated.manifest.entry_name,
      pin_count: generated.manifest.pins.length,
      model_card_sha256: sha256Text(generated.card),
    },
  }
}
