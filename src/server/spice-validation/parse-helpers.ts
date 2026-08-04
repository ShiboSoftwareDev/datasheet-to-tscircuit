import type { ValidationPathError } from "./types"

export type UnknownRecord = Record<string, unknown>

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export class ValidationCollector {
  readonly errors: ValidationPathError[] = []

  add(path: string, code: string, message: string): void {
    this.errors.push({ path, code, message })
  }

  record(value: unknown, path: string): UnknownRecord {
    if (isRecord(value)) return value
    this.add(path, "invalid_type", "must be an object")
    return {}
  }

  array(value: unknown, path: string): unknown[] {
    if (Array.isArray(value)) return value
    this.add(path, "invalid_type", "must be an array")
    return []
  }

  string(value: unknown, path: string): string {
    if (typeof value === "string" && value.trim() !== "") return value
    this.add(path, "invalid_string", "must be a non-empty string")
    return ""
  }

  optionalString(value: unknown, path: string): string | undefined {
    if (value === undefined) return undefined
    return this.string(value, path)
  }

  finite(value: unknown, path: string): number {
    if (typeof value === "number" && Number.isFinite(value)) return value
    this.add(path, "invalid_number", "must be a finite number")
    return 0
  }

  positive(value: unknown, path: string): number {
    const parsed = this.finite(value, path)
    if (typeof value === "number" && Number.isFinite(value) && parsed <= 0) {
      this.add(path, "out_of_range", "must be greater than zero")
    }
    return parsed
  }

  nonNegative(value: unknown, path: string): number {
    const parsed = this.finite(value, path)
    if (typeof value === "number" && Number.isFinite(value) && parsed < 0) {
      this.add(path, "out_of_range", "must be zero or greater")
    }
    return parsed
  }

  rejectUnknownKeys(record: UnknownRecord, allowed: readonly string[], path: string): void {
    const allowed_keys = new Set(allowed)
    for (const key of Object.keys(record).sort()) {
      if (!allowed_keys.has(key)) {
        this.add(`${path}.${key}`, "unknown_field", "is not part of ValidationPlan version 1")
      }
    }
  }
}
