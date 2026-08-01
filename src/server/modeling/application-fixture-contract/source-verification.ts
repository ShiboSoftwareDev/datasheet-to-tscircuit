import { createHash } from "node:crypto"
import { parseComponentEvidence } from "../../component-evidence"
import {
  applicationTargetIdentityFromEvidence,
  parseTypicalApplicationPlan,
} from "../../component-workflow/application-plan"
import type { ModelInterface } from "../types"
import { compileApplicationFixtureContract } from "./compiler"
import { parseApplicationFixtureContract } from "./parser"
import { ApplicationFixtureContractError, type ApplicationFixtureContract } from "./types"
import { stableStringify } from "../../spice-validation/hashing"

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function parseUtf8Json(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
  } catch (error) {
    throw new ApplicationFixtureContractError(`${label} must be valid UTF-8 JSON: ${String(error)}`)
  }
}

/**
 * Rebuilds the fixture from the retained canonical source bytes. This is the
 * publication trust boundary: matching self-declared hashes are insufficient.
 */
export function recompileApplicationFixtureContractFromSources(input: {
  source_plan_bytes: Uint8Array
  source_pdf_bytes: Uint8Array
  source_evidence_bytes: Uint8Array
  model_interface: ModelInterface
  standalone_contract: unknown
  embedded_contract: unknown
}): ApplicationFixtureContract {
  const evidence = parseComponentEvidence(
    parseUtf8Json(input.source_evidence_bytes, "component-evidence.json"),
  )
  const plan = parseTypicalApplicationPlan(
    parseUtf8Json(input.source_plan_bytes, "typical-application-plan.json"),
    applicationTargetIdentityFromEvidence(evidence),
  )
  const recompiled = compileApplicationFixtureContract({
    plan,
    model_interface: input.model_interface,
    source_plan_sha256: sha256(input.source_plan_bytes),
    source_pdf_sha256: sha256(input.source_pdf_bytes),
  })
  const standalone = parseApplicationFixtureContract(input.standalone_contract)
  const embedded = parseApplicationFixtureContract(input.embedded_contract)
  if (
    stableStringify(standalone) !== stableStringify(recompiled) ||
    stableStringify(embedded) !== stableStringify(recompiled)
  ) {
    throw new ApplicationFixtureContractError(
      `publication application fixture does not exactly recompile from retained plan/PDF sources (expected ${recompiled.contract_sha256}, standalone ${standalone.contract_sha256}, embedded ${embedded.contract_sha256})`,
    )
  }
  return recompiled
}
