import type { AnyCircuitElement } from "circuit-json"

export function isCircuitJson(value: unknown): value is AnyCircuitElement[] {
  return (
    Array.isArray(value) &&
    value.every(
      (element) => typeof element === "object" && element !== null && typeof element.type === "string",
    )
  )
}

export function hasRenderablePcb(circuit_json: AnyCircuitElement[]): boolean {
  return circuit_json.some(
    (element) =>
      element.type === "pcb_component" ||
      element.type === "pcb_smtpad" ||
      element.type === "pcb_plated_hole" ||
      element.type === "pcb_hole",
  )
}

export function selectPreferredComponentCircuitJson(
  ...candidates: unknown[]
): AnyCircuitElement[] | undefined {
  const circuit_json_candidates = candidates.filter(isCircuitJson)
  return circuit_json_candidates.find(hasRenderablePcb) ?? circuit_json_candidates[0]
}
