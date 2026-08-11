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

const canonical_footprint_catalog_example = {
  version: 1,
  default_footprint_id: "package-name-2",
  footprints: [
    {
      footprint_id: "package-name-2",
      component_evidence: canonical_component_example,
    },
  ],
}

export const COMPONENT_EVIDENCE_GUIDE = `# Component evidence artifact contract

Schema id: ${COMPONENT_EVIDENCE_SCHEMA_ID}

The JSON representations below are exact. Keep every required version field.
Physical pin identifiers are JSON strings even when they contain only digits.
Do not replace enum values with explanatory prose.

## component-footprint-catalog.json

- version: exactly 1
- default_footprint_id: the lowercase hyphenated id of one entry
- footprints: one entry per distinct, usable physical PCB copper footprint
- footprints[].footprint_id: stable lowercase hyphenated package identity
- footprints[].component_evidence: the exact component evidence shape below

Extractor example (the server adds canonical label/alias metadata):

\`\`\`json
${JSON.stringify(canonical_footprint_catalog_example, null, 2)}
\`\`\`

Do not create separate entries for tape/reel or quantity orderables, package
outline and board-layout views, repeated drawings, or stencil apertures. The
server also compares normalized copper geometry and pad-to-pin mapping under
drawing rotations and merges physical duplicates. Pin labels and roles do not
turn another representation of the same copper pattern into a new footprint.

## footprints[].component_evidence

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

For every catalog entry, resolve an exact orderable part/package. Record every
electrical pin and every physical copper area exactly once. Distinct copper pads
may share one physical electrical pin. An exposed or thermal pad that the
datasheet bonds to an existing pin must reuse that documented physical pin
number; do not invent names such as "thermal-pad". Use null only when the copper
is proven to be mechanically present and electrically unassigned. Coordinates
are millimeters in PCB-top view. Never substitute a
package outline, bottom view, or stencil aperture for a copper land pattern. If
a material fact is ambiguous, use status "unresolved" and explain it instead of
guessing.

Use the cited PDF pages while extracting the evidence. The server discards
agent-authored PNG pixels, renders every cited page itself at 200 DPI, and
publishes trusted full-page renders. The default footprint is also available at
visual-reference/land-pattern.png.
`

export const APPLICATION_EVIDENCE_GUIDE = `# Typical-application evidence artifact contract

This contract is independent of component generation and describes only what is
visibly documented in datasheet.pdf.

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
leave pins explicitly marked no-connect unwired. Spell every U1 endpoint with its
physical pin number from that table (for example U1.1), not a pin-name alias. A plan that omits a connectable
target pin cannot form a complete downstream SPICE application fixture.
Preserve printed reference designators. When the
figure omits them, assign conventional references by kind in deterministic visual
order: top-to-bottom, then left-to-right; the datasheet target is always U1.
Preserve only the target identity text visibly printed in the selected application
figure; do not append a package or ordering suffix found elsewhere. Do not consult
a generated component. The server binds U1 to authoritative component evidence later. Use
verified PCB mode only when every external part and footprint is precisely
sourced (prefer a sourced scalar object for each manufacturer part number and
footprint); otherwise use schematic_only. A not_present plan must omit
pcb_implementation, use empty components/connections, and include the non-empty
searched_sections[] that were checked.

Use the cited PDF pages while extracting the evidence. Agent-authored pdf_visual
sources should omit image and render_dpi. The server discards agent-authored PNG
pixels, renders every cited page itself at 200 DPI, and
publishes a trusted full-page alias at visual-reference/typical-application.png
for a documented application. Trace
every junction and crossing on the cited page before writing the connectivity
graph.
`

export const COMPONENT_EVIDENCE_GUIDE_SHA256 = createHash("sha256")
  .update(COMPONENT_EVIDENCE_GUIDE)
  .digest("hex")

export const APPLICATION_EVIDENCE_GUIDE_SHA256 = createHash("sha256")
  .update(APPLICATION_EVIDENCE_GUIDE)
  .digest("hex")
