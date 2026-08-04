import { createHash } from "node:crypto"

export const OCR_DPI = 600
export const OBSERVER_DPI = 200
export const OCR_SCALE = OCR_DPI / OBSERVER_DPI
export const MAX_TSV_BYTES = 4 * 1024 * 1024
export const ANCHOR_PIXEL_TOLERANCE = 4
export const ORTHOGONAL_ALIGNMENT_TOLERANCE = 8
export const SOURCE_LOCAL_TEXT_GAP_PDF_POINTS = 36

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

export function valuesAgree(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-12, Math.abs(right) * 1e-8)
}
