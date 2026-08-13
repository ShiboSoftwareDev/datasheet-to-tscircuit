/**
 * Canonicalizes one application-graph endpoint at an agent boundary.
 * Component ports stay exact (`U1.VIN`). Printed external labels may contain
 * spaces, which are represented deterministically as underscores (`48V_BATT`).
 */
export function canonicalizeApplicationEndpoint(value: string, path: string): string {
  const endpoint = value.trim()
  // Decimal voltage-domain labels such as `1.8V`, `1.8_V`, and
  // `SYSTEM_CONTROLLER_1.8V_POWER` are external semantic terminals, not
  // component.port endpoints. Component references themselves may contain
  // underscores, so the decimal token followed by an optional SI unit is the
  // relevant distinction.
  if (/(?:^|_)\d+\.\d+(?:[VAW]|_[VAW])?(?:_|$)/i.test(endpoint)) {
    return endpoint.replaceAll(".", "_")
  }
  if (/^[^.\s]+\.[^.\s]+$/.test(endpoint)) return endpoint
  if (/^[^.\s]+$/.test(endpoint)) return endpoint
  if (/^[A-Z0-9][A-Z0-9_+/-]*(?:\s+[A-Z0-9][A-Z0-9_+/-]*)+$/.test(endpoint)) {
    return endpoint.replace(/\s+/g, "_")
  }
  throw new Error(
    `${path} ${JSON.stringify(endpoint)} must use component.port syntax or an external terminal label; spaces in external labels are canonicalized as underscores`,
  )
}

const TSCIRCUIT_NET_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENCODED_NET_PREFIX = "N_X"

/**
 * Maps a documented semantic net/terminal identity to a spelling accepted by
 * tscircuit's `net.*` syntax. The evidence identity remains unchanged; this is
 * only the source-level spelling used by generated TSX and Circuit JSON.
 */
export function applicationSourceNetName(identity: string): string {
  const canonical = identity.trim()
  if (!canonical) throw new Error("application net identity must be non-empty")
  if (TSCIRCUIT_NET_IDENTIFIER.test(canonical) && !canonical.toUpperCase().startsWith(ENCODED_NET_PREFIX)) {
    return canonical
  }
  const encoded = [...canonical]
    .map((character) => character.codePointAt(0)!.toString(16).toUpperCase())
    .join("_")
  return `${ENCODED_NET_PREFIX}${encoded}`
}
