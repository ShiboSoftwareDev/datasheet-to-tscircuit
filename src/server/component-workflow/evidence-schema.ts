export const COMPONENT_EVIDENCE_GUIDE = `# Evidence artifacts

Write component-evidence.json as a version-1 object:

- status: resolved or unresolved
- part_number: evidenceField<string>; optional ordering_code uses the same shape
- package: name, optional code, and pin_count as evidence fields
- pinout.pins[]: number, labels[], role, optional electrical_attributes.open_drain,
  optional description, and sources[]
- footprint: view "pcb_top", units "mm", drawing_orientation evidence field,
  and pads[] with pin|null, kind, x, y, width, height, optional hole dimensions,
  and sources[]
- unresolved_ambiguities[]

An evidenceField is {"value": value, "sources": evidenceSource[]}.
An evidenceSource is {"page": positive integer, "figure"?: string,
"method": "pdf_text"|"pdf_visual"|"calculated"|"package_standard",
"confidence": "high"|"medium"|"low", "image"?: workspace-relative string,
"render_dpi"?: number, "note"?: string}. pdf_visual sources must reference an
inspected image rendered at exactly 200 DPI. Calculated and package-standard
sources require a note.

Pin roles are power_input, power_output, ground, input, output, bidirectional,
passive, no_connect, or other. Mark open_drain only when explicitly documented.
Use one exact orderable part/package. Record every electrical pin and copper pad.
Coordinates are millimeters in PCB-top view. Never substitute a package outline,
bottom view, or stencil aperture for a copper land pattern. If a material fact is
ambiguous, use status unresolved and explain it instead of guessing.

Write typical-application-plan.json version 4 with availability documented or
not_present, title, description, source_references[], components[], and
connections[]. A documented plan must set pcb_implementation to verified or
schematic_only. A not_present plan must omit pcb_implementation, use empty
components/connections, and include the non-empty searched_sections[] that were
checked. Components have reference, kind, optional value/purpose,
manufacturer_part_number/footprint and their source references. Connections are
{"net": string, "pins": ["component.port", ...]}. Include target U1. Do not
invent terminal pseudo-components. Use verified PCB mode only when every external
part and footprint is precisely sourced; otherwise use schematic_only.

Save the inspected PCB land-pattern crop at visual-reference/land-pattern.png.
For a documented application also save the inspected circuit crop at
visual-reference/typical-application.png.
`
