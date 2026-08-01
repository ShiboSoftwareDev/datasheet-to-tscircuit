import type { ExpectedFootprintPad } from "../job-artifact-validator"
import type {
  COMPONENT_EVIDENCE_STATUSES,
  DRAWING_ORIENTATIONS,
  EVIDENCE_CONFIDENCES,
  EVIDENCE_METHODS,
  SCHEMATIC_PIN_ROLES,
} from "./contract"

export type EvidenceConfidence = (typeof EVIDENCE_CONFIDENCES)[number]

export type EvidenceMethod = (typeof EVIDENCE_METHODS)[number]

export type DrawingOrientation = (typeof DRAWING_ORIENTATIONS)[number]

export type SchematicPinRole = (typeof SCHEMATIC_PIN_ROLES)[number]

export interface EvidenceSource {
  page: number
  figure?: string
  method: EvidenceMethod
  confidence: EvidenceConfidence
  image?: string
  render_dpi?: number
  note?: string
}

export interface EvidenceField<T> {
  value: T
  sources: EvidenceSource[]
}

export interface PinEvidence {
  number: string
  labels: string[]
  role: SchematicPinRole
  electrical_attributes?: {
    open_drain?: boolean
  }
  description?: string
  sources: EvidenceSource[]
}

export interface EvidencePad extends ExpectedFootprintPad {
  sources: EvidenceSource[]
}

export interface ComponentEvidence {
  version: 1
  status: (typeof COMPONENT_EVIDENCE_STATUSES)[number]
  part_number: EvidenceField<string>
  ordering_code?: EvidenceField<string>
  package: {
    name: EvidenceField<string>
    code?: EvidenceField<string>
    pin_count: EvidenceField<number>
  }
  pinout: {
    pins: PinEvidence[]
  }
  footprint: {
    view: "pcb_top"
    units: "mm"
    drawing_orientation: EvidenceField<DrawingOrientation>
    pads: EvidencePad[]
  }
  unresolved_ambiguities: string[]
}
