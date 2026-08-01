import type { ModelContract } from "./types"

function boundedFeedback(value: string): string {
  const max_characters = 14_000
  if (value.length <= max_characters) return value
  const marker = "[Earlier feedback truncated.]\n"
  return `${marker}${value.slice(-(max_characters - marker.length))}`
}

export function buildCharacterizationPrompt(feedback?: string): string {
  return `Analyze the supplied component for a useful, honest SPICE model.

Read AGENTS.md, model-interface.json, component-evidence.json,
typical-application-plan.json, component.circuit.tsx, and the complete
datasheet.pdf. The application plan is committed datasheet evidence: use it for
documented topology and operating-condition context, but do not invent an
application when availability is not_present. Write only
model-characterization.json and optional retained PNG images under evidence/.
Do not write a model, testbench, TSX, or simulator file.

model-characterization.json is a version-1 object with:
- family: passive, diode, bjt, mosfet, opamp, comparator, regulator,
  power_converter, sensor, digital_mixed_signal, or other
- strategy: equation, behavioral, or hybrid
- requirements[] with stable snake_case requirement_id, title, behavior,
  analysis (operating_point, dc_sweep, or transient), support,
  conditions, expected, optional reference_curve, and sources
- assumptions[] and limitations[]

Each requirement support is either {"status":"modeled"} or
{"status":"documented_only","reason":"..."}. Mark behavior documented_only
when it cannot be observed through the public electrical pins in ordinary
ngspice—for example an unimplemented register protocol, packaging, ESD, or
firmware behavior. Do not invent an analog output for digital-only measurements.

For modeled requirements, convert numeric values to SI base units: expected.unit
and reference_curve.y_unit must be exactly V or A. A DC reference curve must use
x_unit V or A; a transient curve must use x_unit s; operating-point requirements
cannot have a curve. Express gain, resistance, and similar derived quantities as
an observable voltage/current response under explicit conditions, not as V/V,
ohms, mV, or mA values. documented_only requirements may retain their literal
units. expected declares at least one of target/min/max and may contain a positive
absolute tolerance. For modeled behavior, that tolerance cannot exceed half the
largest declared expected magnitude, with a 1 mV floor for voltage or a 1 uA
floor for current. A reference_curve may contain a positive normalized tolerance
no greater than 0.5; the server uses five percent when it is omitted. Conditions
are named scalar values. Every requirement cites exact PDF pages, table/figure
locators, and a concise datasheet statement. When a datasheet graph materially
defines behavior, digitize a modest set of monotonically ordered points into
reference_curve and retain its exact crop under evidence/. A modeled
reference_curve must contain at least five points so the server can reserve
interior samples for independent validation. Scalar specifications are equally
valid; do not force every device into a transient graph workflow.

Vendor-model strategy is disabled until the server has a retained, verified
vendor-artifact ingestion path. A datasheet link to a vendor model may be cited
as a limitation or follow-up lead, but must not be claimed as an available model.
Select the simplest enabled strategy that covers the modeled requirements across
their operating range.
${feedback ? `\nThe previous artifact was rejected. Correct every issue:\n${boundedFeedback(feedback)}\n` : ""}`
}

export function buildValidationPlanPrompt(input: { contract: ModelContract; feedback?: string }): string {
  const modeled_ids = input.contract.characterization.requirements
    .filter(({ support }) => support.status === "modeled")
    .map(({ requirement_id }) => requirement_id)
  return `Design a declarative electrical validation plan for the supplied model contract.

Read AGENTS.md, model-contract.json, model-interface.json,
validation-plan-guide.md, component-evidence.json,
typical-application-plan.json, and component.circuit.tsx. Treat the committed
application plan as topology and operating-condition evidence; when its
availability is not_present, do not invent an application. Write
validation-plan.json only. Never write raw SPICE, .measure statements, TSX,
scripts, or model.lib; the server compiles the plan.

Use exactly model.entry_name and model.pins from model-interface.json. Cases use
stable ids, requirement_ids, named fixture nets/elements, one analysis, and one
or more observations. Every observation names exactly one requirement_id from
its case. Do not write observation.reference: the server derives targets, bounds,
and curves from the immutable model contract. Endpoints are only gnd,
dut.<spice_node>, or
net.<identifier>. Fixture types are resistor, capacitor, inductor,
voltage_source, current_source, and diode. Sources may use a compact physical
PULSE. Observations measure a node voltage or current through a named fixture
element and compare against a target+tolerance, bounds, or sampled reference
curve after the server binds it to the linked requirement.

Cover each modeled requirement at least once: ${modeled_ids.join(", ")}.
Do not create cases for documented_only requirements. Use operating-point and DC
sweeps for static limits, transient only for actual dynamics, and sufficiently
broad ranges to expose interpolation or operating-region errors. Measurements
must depend electrically on X_DUT; do not copy a target into a fixture source or
observe a source that bypasses the device. Keep external circuits small and use
the documented application topology where it matters. The server replaces X_DUT
with a hidden inert baseline and rejects every observation that still passes, so
each comparison must distinguish real device behavior from a passive open circuit.
${input.feedback ? `\nThe previous plan was rejected. Correct every issue:\n${boundedFeedback(input.feedback)}\n` : ""}`
}

export function buildModelGenerationPrompt(input: {
  contract: ModelContract
  strategy_guidance: string
  feedback?: string
}): string {
  const header = `.SUBCKT ${input.contract.interface.entry_name} ${input.contract.interface.pins
    .map(({ spice_node }) => spice_node)
    .join(" ")}`
  return `Create the SPICE model described by model-contract.json.

Read AGENTS.md, model-contract.json, model-interface.json,
component-evidence.json, typical-application-plan.json, and component.circuit.tsx.
The committed application plan supplies documented topology and operating-range
context only; it is not a validation fixture, and availability not_present must
not be replaced with an invented circuit. Write exactly model.lib and
model-card.md. The server deliberately keeps its validation fixtures private
from model generation. For every sufficiently sampled modeled reference curve,
model-contract.json is a deterministic training view: the server has withheld
interior reference samples and will score the finished model against the full
curve. Generalize continuously between the visible samples; do not create or
infer a testbench, guess or enumerate hidden coordinates, or edit the contract,
component source, or evidence. The required public header is:

${header}

The model must expose exactly one public subcircuit with that exact node order.
Self-contained private helper subcircuits and .MODEL definitions are allowed.
Do not use .include, .lib, .end, or shell/control commands. Use
portable ngspice-compatible syntax. ${input.strategy_guidance}

Favor continuous, causal equations and physical state. Fit behavior across the
declared conditions and sweep ranges rather than enumerating case coordinates.
Keep equations bounded and convergence-friendly. Implement only requirements
marked modeled; clearly describe documented_only behavior and all limitations in
model-card.md. Do not claim server validation yourself.

The server—not this agent—owns the independent validation plan, compiles its
fixtures, runs ngspice, compares all numeric series, and attaches the canonical
wrapper. Finish with a usable model even if some behavior is approximate.
${input.feedback ? `\nThe last server run failed. Repair every relevant item below without changing the validation plan:\n${boundedFeedback(input.feedback)}\n` : ""}`
}
