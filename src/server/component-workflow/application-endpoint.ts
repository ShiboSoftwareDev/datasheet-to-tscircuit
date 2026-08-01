/**
 * Canonicalizes one application-graph endpoint at an agent boundary.
 * Component ports stay exact (`U1.VIN`). Printed external labels may contain
 * spaces, which are represented deterministically as underscores (`48V_BATT`).
 */
export function canonicalizeApplicationEndpoint(value: string, path: string): string {
  const endpoint = value.trim()
  if (/^[^.\s]+\.[^.\s]+$/.test(endpoint)) return endpoint
  if (/^[^.\s]+$/.test(endpoint)) return endpoint
  if (/^[A-Z0-9][A-Z0-9_+/-]*(?:\s+[A-Z0-9][A-Z0-9_+/-]*)+$/.test(endpoint)) {
    return endpoint.replace(/\s+/g, "_")
  }
  throw new Error(
    `${path} ${JSON.stringify(endpoint)} must use component.port syntax or an external terminal label; spaces in external labels are canonicalized as underscores`,
  )
}
