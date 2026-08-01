export const COMPONENT_EVIDENCE_VERSION = 1 as const
export const COMPONENT_EVIDENCE_SCHEMA_ID = "component-evidence/v1" as const

export const COMPONENT_EVIDENCE_STATUSES = ["resolved", "unresolved"] as const

export const EVIDENCE_METHODS = ["pdf_text", "pdf_visual", "calculated", "package_standard"] as const

export const EVIDENCE_CONFIDENCES = ["high", "medium", "low"] as const

export const DRAWING_ORIENTATIONS = ["pcb_top", "package_top", "package_bottom", "side", "unknown"] as const

export const SCHEMATIC_PIN_ROLES = [
  "power_input",
  "power_output",
  "ground",
  "input",
  "output",
  "bidirectional",
  "passive",
  "no_connect",
  "other",
] as const

export const EVIDENCE_PAD_KINDS = ["smt", "plated_hole"] as const
