import { createHash } from "node:crypto"
import { stableStringify } from "../../spice-validation/hashing"
import type {
  ApplicationFixtureContract,
  ApplicationFixtureContractPayload,
  ResolvedApplicationFixture,
  ResolvedApplicationFixturePayload,
} from "./types"

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex")
}

function contractPayload(contract: ApplicationFixtureContract): ApplicationFixtureContractPayload {
  const { contract_sha256: _contract_sha256, ...payload } = contract
  return payload
}

function resolvedPayload(resolved: ResolvedApplicationFixture): ResolvedApplicationFixturePayload {
  const { topology_sha256: _topology_sha256, ...payload } = resolved
  return payload
}

export function hashApplicationFixtureContract(
  contract: ApplicationFixtureContract | ApplicationFixtureContractPayload,
): string {
  return "contract_sha256" in contract ? sha256(contractPayload(contract)) : sha256(contract)
}

export function hashResolvedApplicationFixture(
  resolved: ResolvedApplicationFixture | ResolvedApplicationFixturePayload,
): string {
  return "topology_sha256" in resolved ? sha256(resolvedPayload(resolved)) : sha256(resolved)
}
