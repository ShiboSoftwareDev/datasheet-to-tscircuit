import { createHash } from "node:crypto"
import {
  COMPONENT_EVIDENCE_SCHEMA_ID,
  COMPONENT_EVIDENCE_VERSION,
  DRAWING_ORIENTATIONS,
  EVIDENCE_PAD_KINDS,
  SCHEMATIC_PIN_ROLES,
} from "../component-evidence"
import {
  PCB_IMPLEMENTATION_MODES,
  TYPICAL_APPLICATION_AVAILABILITIES,
  TYPICAL_APPLICATION_PLAN_VERSION,
} from "./application-plan"

const canonical_component_example = {
  version: COMPONENT_EVIDENCE_VERSION,
  status: "resolved",
  part_number: {
    value: "BASE-PART-NUMBER",
    sources: [{ page: 1, method: "pdf_text", confidence: "high" }],
  },
  ordering_code: {
    value: "BASE-PART-NUMBER-A",
    sources: [{ page: 2, method: "pdf_text", confidence: "high" }],
  },
  package: {
    name: {
      value: "PACKAGE-NAME",
      sources: [{ page: 2, method: "pdf_text", confidence: "high" }],
    },
    pin_count: {
      value: 2,
      sources: [{ page: 2, method: "pdf_text", confidence: "high" }],
    },
  },
  pinout: {
    pins: [
      {
        number: "1",
        labels: ["IN"],
        role: "input",
        sources: [{ page: 3, method: "pdf_text", confidence: "high" }],
      },
      {
        number: "2",
        labels: ["GND"],
        role: "ground",
        sources: [{ page: 3, method: "pdf_text", confidence: "high" }],
      },
    ],
  },
  footprint: {
    view: "pcb_top",
    units: "mm",
    drawing_orientation: {
      value: "pcb_top",
      sources: [
        {
          page: 4,
          figure: "Recommended land pattern",
          method: "pdf_visual",
          confidence: "high",
          image: "visual-reference/land-pattern.png",
          render_dpi: 200,
        },
      ],
    },
    pads: [
      {
        pin: "1",
        kind: "smt",
        x: -0.5,
        y: 0,
        width: 0.4,
        height: 0.8,
        sources: [
          {
            page: 4,
            figure: "Recommended land pattern",
            method: "pdf_visual",
            confidence: "high",
            image: "visual-reference/land-pattern.png",
            render_dpi: 200,
          },
        ],
      },
      {
        pin: "2",
        kind: "smt",
        x: 0.5,
        y: 0,
        width: 0.4,
        height: 0.8,
        sources: [
          {
            page: 4,
            figure: "Recommended land pattern",
            method: "pdf_visual",
            confidence: "high",
            image: "visual-reference/land-pattern.png",
            render_dpi: 200,
          },
        ],
      },
    ],
  },
  unresolved_ambiguities: [],
}

const canonical_application_example = {
  version: TYPICAL_APPLICATION_PLAN_VERSION,
  availability: "documented",
  pcb_implementation: "schematic_only",
  title: "Documented typical application",
  description: "Describe only the circuit shown in the cited figure.",
  source_references: [
    {
      page: 5,
      figure: "Typical application",
      method: "pdf_visual",
      confidence: "high",
      image: "visual-reference/typical-application.png",
      render_dpi: 200,
    },
  ],
  components: [
    {
      reference: "U1",
      kind: "integrated_circuit",
      value: "BASE-PART-NUMBER",
      manufacturer_part_number: "BASE-PART-NUMBER-A",
    },
    { reference: "C1", kind: "capacitor", value: "100 nF" },
  ],
  connections: [
    { net: "INPUT", pins: ["U1.IN", "C1.1", "INPUT"] },
    { net: "GND", pins: ["U1.GND", "C1.2", "GND"] },
  ],
}

export const COMPONENT_EVIDENCE_GUIDE = `# Evidence artifact contract

Schema id: ${COMPONENT_EVIDENCE_SCHEMA_ID}

The JSON representations below are exact. Keep every required version field.
Physical pin identifiers are JSON strings even when they contain only digits.
Do not replace enum values with explanatory prose.

## component-evidence.json

- version: exactly ${COMPONENT_EVIDENCE_VERSION}
- status: ${["resolved", "unresolved"].map((value) => `"${value}"`).join(" | ")}
- pinout.pins[].number: non-empty JSON string
- pinout.pins[].role: ${SCHEMATIC_PIN_ROLES.map((value) => `"${value}"`).join(" | ")}
- footprint.view: exactly "pcb_top"; units: exactly "mm"
- footprint.drawing_orientation.value: ${DRAWING_ORIENTATIONS.map((value) => `"${value}"`).join(" | ")}
- footprint.pads[].pin: non-empty JSON string, or null only for a mechanical pad
- footprint.pads[].kind: ${EVIDENCE_PAD_KINDS.map((value) => `"${value}"`).join(" | ")}

Canonical example:

\`\`\`json
${JSON.stringify(canonical_component_example, null, 2)}
\`\`\`

An evidence field is {"value": value, "sources": evidenceSource[]}.
An evidence source is {"page": positive integer, "figure"?: string,
"method": "pdf_text"|"pdf_visual"|"calculated"|"package_standard",
"confidence": "high"|"medium"|"low", "image"?: workspace-relative string,
"render_dpi"?: number, "note"?: string}. A pdf_visual source must reference an
existing PNG below visual-reference/ rendered at exactly 200 DPI. Calculated and
package-standard sources require a note.

Part number, ordering code, package name/code/pin count, and every physical pin
must each cite medium- or high-confidence pdf_text or pdf_visual evidence. Keep
the identities distinct: part_number is the base device/family printed throughout
the datasheet (for example ABC123), while ordering_code is the exact selected
purchasable package/carrier variant (for example ABC123QFNTR). When present,
ordering_code must be a distinct extension of the
base part_number after punctuation is removed. Omit it when both identities are
identical.
Calculated and package-standard sources cannot establish those facts. They are
allowed for pad geometry only when the same PDF page has a medium- or
high-confidence pdf_visual footprint citation anchoring the derivation.

Resolve one exact orderable part/package. Record every electrical pin and every
copper pad. Coordinates are millimeters in PCB-top view. Never substitute a
package outline, bottom view, or stencil aperture for a copper land pattern. If
a material fact is ambiguous, use status "unresolved" and explain it instead of
guessing.

## typical-application-plan.json

- version: exactly ${TYPICAL_APPLICATION_PLAN_VERSION}
- availability: ${TYPICAL_APPLICATION_AVAILABILITIES.map((value) => `"${value}"`).join(" | ")}
- pcb_implementation for documented plans: ${PCB_IMPLEMENTATION_MODES.map((value) => `"${value}"`).join(" | ")}
- canonical component value, purpose, manufacturer_part_number, and footprint:
  strings; omit an unknown optional field instead of writing null. At the agent
  boundary, any of these may instead be {"value": string, "sources":
  evidenceSource[]} and the server moves those citations into the canonical
  source arrays
- top-level source_references: the documented application figure sources
- components[].source_references and components[].footprint_source_references:
  component-scoped arrays of source objects. Never write footprint_source_references
  at the plan root.
- connections: {"net": string, "pins": ["component.port" | "EXTERNAL_TERMINAL", ...]}

Canonical example:

\`\`\`json
${JSON.stringify(canonical_application_example, null, 2)}
\`\`\`

A documented plan must include target U1 and every net must contain at least one
component.port endpoint. A bare endpoint is the semantic identity of a real
external terminal such as INPUT, OUTPUT, or GND. Do not turn it into a component
or discard it as a net label. External terminal labels are one JSON token: replace
printed whitespace with underscores (for example "48V BATT" becomes "48V_BATT").
Arrows, bus wedges, braces, interface labels, and annotations such as "To MCU"
are not components and do not short distinct outgoing signals together. Use one
bare external terminal per outgoing signal (for example SCL, SDA, and ALERT), and
never reuse the same bare endpoint on different nodes. Inventory every visible
switch contact. An SPDT symbol has one common and two throws on three distinct
nodes; open contacts do not merge the load and charger branches.
Before returning a documented plan, cross-check the complete datasheet pin table.
Account for every electrically connectable U1 pin exactly once in connections and
leave pins explicitly marked no-connect unwired. A plan that omits a connectable
target pin cannot form a complete downstream SPICE application fixture.
Preserve printed reference designators. When the
figure omits them, assign conventional references by kind in deterministic visual
order: top-to-bottom, then left-to-right; the datasheet target is always U1. Use
the target's base part_number as U1 value. When manufacturer_part_number is
included for U1, use the selected exact ordering_code, never the unsuffixed family
name. The server binds canonical U1 to that authoritative selected identity. Use
verified PCB mode only when every external part and footprint is precisely
sourced (prefer a sourced scalar object for each manufacturer part number and
footprint); otherwise use schematic_only. A not_present plan must omit
pcb_implementation, use empty components/connections, and include the non-empty
searched_sections[] that were checked.

Use the cited PDF pages while extracting the evidence. The server discards
agent-authored PNG pixels, renders every cited page itself at 200 DPI, and
publishes trusted full-page aliases at visual-reference/land-pattern.png and,
for a documented application, visual-reference/typical-application.png. Trace
every junction and crossing on the cited page before writing the connectivity
graph.
`

export const COMPONENT_EVIDENCE_GUIDE_SHA256 = createHash("sha256")
  .update(COMPONENT_EVIDENCE_GUIDE)
  .digest("hex")
