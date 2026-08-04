import type { ModelPublicElectricalEndpoint } from "../types"
import { ApplicationFixtureContractError, type ApplicationFixtureNodeEndpoint } from "./types"

export type UnknownRecord = Record<string, unknown>

export const SHA256_PATTERN = /^[a-f0-9]{64}$/
export const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function record(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApplicationFixtureContractError(`${path} must be an object`)
  }
  return value as UnknownRecord
}

export function exactKeys(value: UnknownRecord, keys: readonly string[], path: string): void {
  const allowed = new Set(keys)
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    throw new ApplicationFixtureContractError(
      `${path} contains unsupported fields: ${unknown.sort().join(", ")}`,
    )
  }
}

export function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApplicationFixtureContractError(`${path} must be a non-empty string`)
  }
  return value.trim()
}

export function safeIdentifier(value: unknown, path: string): string {
  const result = requiredString(value, path)
  if (!SAFE_IDENTIFIER_PATTERN.test(result)) {
    throw new ApplicationFixtureContractError(`${path} must be a safe identifier`)
  }
  return result
}

export function requiredSha256(value: unknown, path: string): string {
  const result = requiredString(value, path)
  if (!SHA256_PATTERN.test(result)) {
    throw new ApplicationFixtureContractError(`${path} must be a lowercase SHA-256 digest`)
  }
  return result
}

export function finitePositive(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ApplicationFixtureContractError(`${path} must be a positive finite number`)
  }
  return Object.is(value, -0) ? 0 : value
}

export function parsePublicEndpoint(value: unknown, path: string): ModelPublicElectricalEndpoint {
  if (value === "gnd") return value
  if (typeof value === "string" && /^dut\.[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    return value as `dut.${string}`
  }
  throw new ApplicationFixtureContractError(`${path} must be gnd or dut.<spice_node>`)
}

export function parseNodeEndpoint(value: unknown, path: string): ApplicationFixtureNodeEndpoint {
  if (value === "gnd") return value
  if (typeof value === "string" && /^net\.[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    return value as `net.${string}`
  }
  throw new ApplicationFixtureContractError(`${path} must be gnd or net.<node_group_id>`)
}

export function parseStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new ApplicationFixtureContractError(`${path} must be an array`)
  }
  const result = value.map((entry, index) => requiredString(entry, `${path}[${index}]`))
  if (new Set(result.map((entry) => entry.toLowerCase())).size !== result.length) {
    throw new ApplicationFixtureContractError(`${path} must contain unique values`)
  }
  return result
}
