import { createHash } from "node:crypto"
import type { ModelManifest } from "@/shared/job-types"
import type { ValidationInputHashes } from "./types"

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

export function stableStringify(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return JSON.stringify({ $number: String(value) })
    return Object.is(value, -0) ? "0" : JSON.stringify(value)
  }
  if (typeof value === "undefined") return JSON.stringify({ $undefined: true })
  if (typeof value === "bigint") return JSON.stringify({ $bigint: value.toString() })
  if (typeof value === "symbol") return JSON.stringify({ $symbol: value.description ?? "" })
  if (typeof value === "function") return JSON.stringify({ $function: value.name })
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const record = value as Record<string, unknown>
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
  return `{${entries.join(",")}}`
}

export function hashValidationInputs(input: {
  plan: unknown
  model_source: string
  manifest: ModelManifest
}): ValidationInputHashes {
  return {
    plan_sha256: sha256Text(stableStringify(input.plan)),
    model_sha256: sha256Text(input.model_source),
    manifest_sha256: sha256Text(stableStringify(input.manifest)),
  }
}
