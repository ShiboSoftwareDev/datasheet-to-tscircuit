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
typical-application-plan.json, application-fixture-contract.json,
component.circuit.tsx, time-graph-hints.json,
model-reference-observation.json, and the complete datasheet.pdf from first page
to last page. Inspect the PDF itself, including its printed figures; do not rely
only on extracted text, the application plan, or pages already cited by another
artifact. The application plan is committed
datasheet evidence: use it for documented topology and operating-condition
context, but do not invent an application when availability is not_present.
Write only model-characterization.json. Do not write a model, testbench, TSX,
simulator file, or claimed validation result.

model-characterization.json is a version-1 object with:
- family: passive, diode, bjt, mosfet, opamp, comparator, regulator,
  power_converter, sensor, digital_mixed_signal, or other
- strategy: equation, behavioral, or hybrid
- requirements[] with stable snake_case requirement_id, title, behavior,
  analysis (operating_point, dc_sweep, or transient), support, conditions,
  expected, optional reference_curve, and sources
- assumptions[] and limitations[]

Each requirement support is either {"status":"modeled"} or
{"status":"documented_only","reason":"..."}. Mark behavior documented_only
when it cannot be observed through the public electrical pins in ordinary
ngspice—for example an unimplemented register protocol, packaging, ESD, or
firmware behavior. Do not invent an analog output for digital-only measurements.

A fresh executable modeled requirement is allowed only when the datasheet prints
an observable elapsed-time waveform through the component's public electrical
pins. Every requirement with support.status "modeled" must:
- use analysis "transient"; operating_point and dc_sweep requirements may only
  be documented_only
- contain reference_curve with x_quantity exactly "time", x_unit exactly "s",
  y_quantity exactly "voltage", y_unit exactly V, and a well-distributed
  monotonically ordered voltage trace
- copy the matched graph's electrical_binding exactly into reference_curve. This
  immutable binding names the plotted voltage terminals and nominal, the one
  reproducible voltage_step or current_step source and full observer-owned SI PULSE,
  and every printed auxiliary DC voltage/current or logic-state fixture
- contain reference_curve.crop with exactly
  {"page":<PDF page>,"render_dpi":200,"x_px":<left>,"y_px":<top>,
  "width_px":<width>,"height_px":<height>}
- cite that same crop page as the primary sources[0] entry

model-reference-observation.json is a sanitized candidate-independent inventory
produced from the canonical PDF. Create one modeled requirement for every eligible
public-pin/reproducible voltage graph in that inventory. Each modeled requirement
must match its graph by PDF page and figure locator, and its crop must
substantially overlap the independently observed rectangle. The server has
deliberately withheld that observer's axis calibration, pixel trace, numeric
points, ranges, colors, and curve digest, but intentionally exposes its independently
derived electrical_binding, including the exact PULSE and static fixtures required to reproduce the plot.
Copy that binding exactly; never substitute another response pin, reference terminal,
nominal, stimulus, auxiliary endpoint/value/state, pulse level, or timing. Digitize the source yourself from the
complete PDF; do not try to infer private values from retry feedback. The server
will compare your curve numerically against the withheld independent trace. Do
not edit, ignore, or reinterpret the sanitized observation. time-graph-hints.json
records the server's complete-PDF text scan; the independent observer has
explicitly reviewed every hint.

Crop coordinates are integer pixels in a pdftoppm rendering at exactly 200 DPI,
measured from the rendered page's top-left corner. Inspect the rendered page and
identify the graph rectangle precisely. The crop must be in bounds, have positive
width and height, be at least 96x64 pixels, and exclude unrelated page content; a whole-page crop is
rejected. Do not set reference_curve.image: the server renders the cited source
page and materializes the canonical crop as
evidence/figures/<requirement_id>.png.
Digitize at least min(48, max(8, ceil(width_px / 12))) points distributed across
the graph's full elapsed-time range. This is never fewer than eight points and
lets the server reserve meaningful interior samples for independent validation.

Tables, headline specifications, calculated values, operating points, DC curves,
and prose-only limits are not executable evidence in this workflow. Record them
as documented_only when useful. Do not turn a scalar value into a synthetic
waveform, invent time coordinates, or relabel a non-time x-axis. If the complete
PDF contains no suitable printed elapsed-time graph, report the honest
documented_only characterization; do not use a scalar requirement as an escape
hatch to force model generation.

For modeled requirements, convert numeric values to SI base units. expected.unit
and reference_curve.y_unit must be exactly V. The installed tscircuit runtime
does not currently emit transient current graphs, so current-only plots are
documented_only. Express derived quantities as an observable voltage response
under explicit conditions. expected must
declare target, min, or max and may contain a positive absolute tolerance. A
target combined with min/max must lie inside those hard bounds. For modeled
behavior, the tolerance cannot exceed half the largest declared expected
magnitude, with a 1 mV floor for voltage or a 1 uA floor for current. A
reference_curve may contain a positive normalized tolerance no greater than 0.1;
the server uses five percent when omitted. Conditions are named scalar values.
Every requirement cites exact PDF pages, figure/table locators, and a concise
datasheet statement. Digitize the printed waveform faithfully; the server may
withhold interior samples for independent validation. documented_only
requirements may retain literal datasheet units.

For a regulator or power_converter, prefer printed startup, load-transient,
line-transient, or other elapsed-time response plots with explicit operating
conditions. Static regulation tables and DC efficiency/load graphs remain
documented_only under this executable-evidence policy.

The server retains every cited modeled-requirement page as a full source image
and separately derives the exact canonical graph crop from reference_curve.crop.

Vendor-model strategy is disabled until the server has a retained, verified
vendor-artifact ingestion path. A datasheet link to a vendor model may be cited
as a limitation or follow-up lead, but must not be claimed as an available model.
Select the simplest enabled strategy that covers the modeled requirements across
their operating range.
${feedback ? `\nThe previous artifact was rejected. Correct every issue:\n${boundedFeedback(feedback)}\n` : ""}`
}

export function buildValidationPlanPrompt(input: { contract: ModelContract; feedback?: string }): string {
  const modeled_requirements = input.contract.characterization.requirements.filter(
    ({ support }) => support.status === "modeled",
  )
  const modeled_ids = modeled_requirements.map(({ requirement_id }) => requirement_id)
  const is_time_domain_contract =
    modeled_requirements.length > 0 &&
    modeled_requirements.every(
      ({ analysis, reference_curve }) =>
        analysis === "transient" && reference_curve?.x_quantity === "time" && reference_curve.x_unit === "s",
    )
  const requires_range_case =
    !is_time_domain_contract &&
    (input.contract.characterization.family === "regulator" ||
      input.contract.characterization.family === "power_converter")
  const analysis_guidance = is_time_domain_contract
    ? `Every case must use transient analysis because this fresh contract contains
only elapsed-time waveforms and the current tscircuit analog viewer cannot verify
operating-point, DC-sweep, or current-graph output. Use voltage observations only
and do not turn a scalar specification into a flat waveform. Set the transient
range to cover the complete reference-curve time range and choose a sufficiently
fine step to resolve its transitions.`
    : `Use operating-point and DC sweeps for static compatibility requirements,
and transient only for actual dynamics. A DC sweep may strengthen an
operating-point check when the same scalar target/bounds apply at every sample.
Do not turn a scalar specification into a synthetic transient waveform.`
  return `Design a declarative electrical validation plan for the supplied model contract.

Read AGENTS.md, model-contract.json, model-interface.json,
validation-plan-guide.md, component-evidence.json,
typical-application-plan.json, application-fixture-contract.json, and
component.circuit.tsx. Treat the committed application plan and its compiled
fixture contract as topology and operating-condition evidence; when availability
is not_present, do not invent an application. Write
validation-plan.json only. Never write raw SPICE, .measure statements, TSX,
scripts, or model.lib; the server compiles the plan.

Use exactly model.entry_name and model.pins from model-interface.json. Cases use
stable ids, requirement_ids, named fixture nets/elements, one analysis, and one
or more observations. Every observation names exactly one requirement_id from
its case. Do not write observation.reference or observation.evidence: both are
server-owned output fields. The server derives targets, bounds, curves, and the
canonical datasheet page from the immutable model contract. Endpoints are only gnd,
dut.<spice_node>, or
net.<identifier>. Fixture types are resistor, capacitor, inductor,
voltage_source, current_source, and diode. Sources may use a compact physical
PULSE. Observations measure a node voltage or current through a named fixture
element. The server binds every observation to its linked requirement's sampled
elapsed-time reference curve.

For a requirement with reference_curve.electrical_binding, the observation must be
voltage at exactly response.positive minus response.negative. The case must contain
the declared stimulus as a non-flat PULSE source: voltage_step means voltage_source,
current_step means current_source, with exactly the declared positive/negative
endpoints and all seven declared pulse values. These terminals, source kind, levels,
and timing are server-checked and cannot be redefined by the validation plan. Set
dc_volts or dc_amps to the declared pulse.low, and make transient stop cover both
delay+rise and the complete reference-curve time range. Put exactly one bound modeled
requirement in each case, and make every observation in that case name it.
Also instantiate every electrical_binding.auxiliary_fixtures entry exactly once.
dc_voltage and dc_current map to non-pulsed sources with their exact endpoints/value.
logic_state maps to a non-pulsed zero-volt voltage source from endpoint to reference.
Do not add another independent source touching any bound response, stimulus, or
auxiliary public endpoint, and never clamp the response with a voltage source.
When electrical_binding contains application fixture digests, omit application_fixture,
the application node-group nets, and all documented application passives from your
proposal. The server injects those canonical fields after parsing the proposal. Supply
only the exact stimulus and auxiliary sources above. Extra resistors, capacitors,
inductors, diodes, or ideal sources are topology changes and will be rejected.

Cover each modeled requirement at least once: ${modeled_ids.join(", ")}.
${requires_range_case ? "This device family requires at least one meaningful DC sweep or transient case; isolated operating points will be rejected.\n" : ""}
Do not create cases for documented_only requirements. Group requirements into
one case only when their canonical sources in model-contract.json use the same
datasheet page/image; split differently sourced requirements into separate
cases. ${analysis_guidance}
Measurements must depend electrically on X_DUT; do not copy a target into a
fixture source or observe a source that bypasses the device. For positive current
entering a DUT pin, orient a series resistor or zero-volt sense source from the
external net toward the DUT pin; fixture current follows
first-terminal-to-second-terminal sign. Keep external circuits small and use the
documented application topology where it matters. For every observation, the
server compares finite series from hidden weak/inert and active/load-injection
DUT probes. A probe may legitimately pass a one-sided requirement; the
observation must instead change materially when DUT behavior changes.
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
Keep equations bounded and convergence-friendly. Transient behavior must be
caused by voltages/currents at public pins and by causal C/L/device state. Never
read ngspice's built-in time variable in a behavioral, parameter, or helper
expression, and never place an independent PWL, PULSE, SIN, EXP, SFFM, AM,
TRRANDOM, or TRNOISE source inside model.lib. XSPICE A/code-model devices,
scripted .IC/device IC state, and autonomous random/noise expressions are also
disallowed; server-owned fixtures must establish every transient stimulus and
the public pins must establish every dynamic state.
A pin or node literally named TIME remains an ordinary electrical node when read
as V(TIME). Implement only requirements marked modeled; clearly describe
documented_only behavior and all limitations in model-card.md. For each dynamic
behavior, model-card.md must name the public electrical stimulus and the physical
or causal state that produces the response. Do not claim server validation
yourself.

The server—not this agent—owns the independent validation plan, compiles its
fixtures, runs ngspice, compares all numeric series, and attaches the canonical
wrapper. Finish with a usable model even if some behavior is approximate.
${input.feedback ? `\nThe last server run failed. Repair every relevant item below without changing the validation plan:\n${boundedFeedback(input.feedback)}\n` : ""}`
}
