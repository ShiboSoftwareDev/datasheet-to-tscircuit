export function buildFoundReferenceGraphObserverPrompt(feedback?: string): string {
  const base = `Find the printed elapsed-time graphs in the complete datasheet.

Read datasheet.pdf from first page to last page, model-interface.json,
application-fixture-contract.json, and time-graph-hints.json. Write
model-reference-observation.json only.

Return the version-1 source_pdf_sha256, reviewed_hints[], and graphs[] contract.
Review every deterministic hint exactly once. A caption-proven transient hint must be
classified as a graph; only a proximity-only printed-axis hint may be not_time_graph
after visual inspection. Include additional elapsed-time graphs only when they are tied
to source-grounded operating conditions.

Each graph contains graph_id, page, locator, literal x_axis:"time",
time_axis_evidence, response_quantity (voltage/current/other),
public_pin_observable, fixture_reproducible, reason, and one exact 200-DPI crop
{page,render_dpi:200,x_px,y_px,width_px,height_px}. The crop must contain the complete
printed graph, axes, traces, axis labels or scope controls, and its adjacent figure
number/caption, without including neighboring figures. Coordinates are relative to the
canonical rendered PDF page.

This task discovers source references only. Every graph must omit electrical_binding and
digitized_curve. Numeric axis calibration, trace points, and comparison data belong
exclusively to Create Comparison Graphs.

Use time-graph-hints.json as the authority for simulator eligibility. A public voltage
graph can be fixture_reproducible only when its deterministic hint has non-null
printed_experiment_conditions_v3 transient_fixture_evidence and no unsupported fixture
condition. Supported tscircuit fixtures are steady-state or pulsed/DC voltage/current
sources plus resistors, capacitors, inductors, and diodes connected to public DUT pins.
For reference comparison, an elapsed-time graph with a steady_state stimulus is not
reproducible: the causal model runtime forbids autonomous time-driven switching behavior.
Graphs requiring register programming, a digital protocol, inaccessible internal state,
unsupported temperature/frequency/parasitic control, or incompletely recovered operating
conditions are not reproducible. Never invent or omit an input to make a graph eligible.
The server re-derives this decision and will override an agent classification that
conflicts with the source-owned fixture evidence.

The property names are exact. Do not invent aliases. Example:
{
  "version": 1,
  "source_pdf_sha256": "COPY_FROM_TIME_GRAPH_HINTS",
  "reviewed_hints": [{
    "hint_id": "time_graph_001",
    "disposition": "graph",
    "graph_id": "figure_4_elapsed_time",
    "reason": "Visually confirmed the printed elapsed-time graph."
  }],
  "graphs": [{
    "graph_id": "figure_4_elapsed_time",
    "page": 12,
    "locator": "Figure 4. Transient Response",
    "x_axis": "time",
    "time_axis_evidence": "50 us/div",
    "response_quantity": "voltage",
    "public_pin_observable": true,
    "fixture_reproducible": true,
    "reason": "Public output voltage under a completely specified load step.",
    "crop": {"page":12,"render_dpi":200,"x_px":100,"y_px":100,"width_px":600,"height_px":500}
  }]
}`
  return feedback
    ? `${base}\n\nThis is a correction attempt. The previous candidate is already seeded. Make only
the smallest changes required by the final rejection block, preserve all unmentioned
entries, and do not add comparison fields.\n\nValidation history (final block is current):\n${feedback}`
    : base
}

export function buildReferenceGraphObserverPrompt(feedback?: string): string {
  const base = `Independently inventory elapsed-time graphs in the complete datasheet.

Read datasheet.pdf from first page to last page, model-interface.json,
application-fixture-contract.json, and time-graph-hints.json. Do not infer anything from another agent's characterization;
it is deliberately absent. Write model-reference-observation.json only.

Return a version-1 object with source_pdf_sha256 copied exactly from the hint file,
reviewed_hints[], and graphs[]. Review every hint exactly once as graph or
not_time_graph. Inventory additional elapsed-time plots even when no text hint found
them. Each graph needs a snake_case graph_id, exact PDF page and figure locator,
literal x_axis:"time", the visible printed time scale or horizontal-axis text in
time_axis_evidence, response_quantity voltage/current/other, whether an ordinary
simulation can observe it through the public electrical pins, whether its stimulus
is reproducible using only resistors, capacitors, inductors, diodes, and pulsed/DC
voltage or current sources in fixture_reproducible, a concrete reason, and the exact
200-DPI crop
{page,render_dpi:200,x_px,y_px,width_px,height_px}. Coordinates start at the rendered
page's top-left. Include the complete axes, trace, and its immediately adjacent
figure-number caption so the server can bind the rectangle to the right plot; exclude
unrelated page content and neighboring plots. Classify
the plotted response, not a stimulus channel: a load-current step with output voltage
response is a voltage graph. The current tscircuit runtime can publish transient
voltage graphs only. Set fixture_reproducible false when reproducing the plot requires
register programming, a digital protocol, an inaccessible internal state, or another
stimulus outside the listed fixture elements. Do not call a static/DC x-axis a time graph.
The server-extracted operating_condition_evidence and unsupported_fixture_conditions in
time-graph-hints.json are authoritative. A graph can be eligible only when it is tied to
a deterministic hint and that hint has no unsupported fixture condition. Never override,
omit, or reinterpret a listed blocker; classify that graph fixture_reproducible false.
The versioned graph_local_conditions receipt is also authoritative. Every retained passive
value must resolve uniquely and match the server-owned application fixture exactly;
temperature, frequency, and parasitic requirements are currently fixture-ineligible.
A graph is also ineligible when its hint has transient_fixture_evidence:null. A retained
condition_conflicts entry is diagnostic: graph-local conditions own executable values and
the summary table supplies only conditions omitted beside the graph. Never reverse that
precedence. Null evidence means the server could not prove one complete tscircuit-supported
transient setup. Never invent a pulse or omit an auxiliary condition. When
printed_experiment_conditions_v3 evidence is present, copy its response, stimulus, and
auxiliary conditions exactly into the public-pin binding; the server resolves and checks
every signal. A printed elapsed-time switching waveform whose stimulus is steady_state
is fixture-ineligible because the causal model runtime cannot generate autonomous
time-driven switching behavior.
A hint whose reason names a transient/timing caption is an authoritative graph inventory
entry and must use disposition graph. Only a proximity-only hint whose reason is a
printed-time-axis marker may use not_time_graph after visual inspection.

Every eligible graph (response_quantity voltage, public_pin_observable true, and
fixture_reproducible true) must contain electrical_binding and digitized_curve.
electrical_binding is the graph's immutable public-pin test identity:
{response:{type:"voltage",positive,negative,nominal_volts},
stimulus:{type:"steady_state"} or
stimulus:{type,positive,negative,pulse:{low,high,delay,rise,fall,width,period}},
auxiliary_fixtures:[...]}. A dc_voltage auxiliary uses
{type:"dc_voltage",positive,negative,dc_volts}; dc_current uses
{type:"dc_current",positive,negative,dc_amps}; and a logic state uses
{type:"logic_state",endpoint,reference,state}; a resistive load uses
{type:"resistor",positive,negative,resistance_ohms}. Map a printed load current as a sink
from the response output to ground. Map logic low as a zero-volt tie to ground and logic
high as a zero-volt tie to the one printed public input-supply endpoint. If that endpoint
is not unique, the graph is ineligible. nominal_volts constrains the observed response;
never create a voltage-source auxiliary across the response endpoints.
Do not write application_fixture_sha256 or application_topology_sha256. Those fields
are computed and injected by the server after it resolves the printed conditions
against application-fixture-contract.json; they are never agent-authored.
Each endpoint must be gnd or dut.<spice_node>, where the SPICE node appears exactly
in model-interface.json. Response endpoints are the plotted voltage polarity, not a
convenient substitute. Stimulus type is steady_state, voltage_step, or current_step.
steady_state has no endpoints or pulse and every printed static condition belongs in
auxiliary_fixtures. A step's endpoints are the orientation of the pulsed source that reproduces the
printed waveform. Low/high, edge direction, and visible edge timing must be justified
by the printed graph, caption, test conditions, or surrounding datasheet text. All
pulse values use SI units; low and high must differ; delay/rise/fall are non-negative;
width/period are positive; and width+rise+fall cannot exceed period. Oscilloscope
plots commonly show one edge without printing a repetition period. In that case,
encode a deterministic single-event harness: place the documented edge at its visible
position, hold the new level through the end of the calibrated graph, and choose a
period beyond the entire displayed/simulated window so no second edge occurs. This
width/period canonicalization is testbench timing, not a claimed device specification.
If the source kind, orientation, levels, edge direction, or visible transition time
cannot be justified, set fixture_reproducible false instead of inventing them.
Endpoints must be distinct and include a public DUT pin. Ineligible graphs must omit electrical_binding. Ineligible voltage
graphs may omit digitized_curve; current/other graphs must omit it. digitized_curve uses:
- method manual_pixel_trace or image_color_trace
- x_quantity:"time", x_unit:"s", y_quantity:"voltage", y_unit:"V"
- x_range and y_range as {min,max} in base seconds and volts
- tscircuit simulation time is elapsed time beginning at zero. If a scope plot
  shows negative pre-trigger labels, translate the complete x calibration so the
  crop's leftmost calibrated time is 0 s while preserving the displayed span and
  edge offsets. Never emit a negative x range, x anchor, traced x value, or PULSE delay.
- x_axis and y_axis as {scale:"linear",first:{pixel,value},second:{pixel,value}}.
  Each pixel is one finite scalar, never an {x,y} object: x_axis.pixel is the
  crop-local horizontal x coordinate and y_axis.pixel is the crop-local vertical
  y coordinate. Pixel coordinates are relative to the exact graph crop, not the full PDF page.
  Put the minimum-value anchor first and maximum-value anchor second. Use two visible,
  widely separated tick/grid positions on each axis.
- trace_color as integer RGB plus tolerance from 4 through 120
- points[] with pixel_x,pixel_y only. The server derives seconds and volts from
  the exact pixel coordinates and the two visible axis anchors.

Trace the visible response centerline from the left edge through the right edge. Supply
at least min(48,max(8,ceil(horizontal_axis_pixel_span/14))) and at most 48 points,
strictly progressing across time, covering at least 90% of the calibrated axis, with
no gap over 20%. Do not trace labels, axes, stimulus channels, or an invented smooth
curve. Render and inspect the exact 200-DPI crop at its original pixel dimensions before
writing points. For image_color_trace, sample the declared trace color across evenly
spaced x positions and follow the connected response centerline; do not estimate a
waveform from the surrounding text or from a resized preview. The server independently
recomputes every numeric value from the pixel-axis
calibration and privately compares this trace with the characterization agent's points.

The property names are exact. Do not invent aliases such as pdf_page, figure,
figure_locator, or fixture_reproducible_reason. Use this canonical shape:

{
  "version": 1,
  "source_pdf_sha256": "COPY_FROM_TIME_GRAPH_HINTS",
  "reviewed_hints": [
    {
      "hint_id": "time_graph_001",
      "disposition": "graph",
      "graph_id": "transient_response_1",
      "reason": "Visually confirmed the hinted elapsed-time graph."
    }
  ],
  "graphs": [
    {
      "graph_id": "transient_response_1",
      "page": 12,
      "locator": "Figure 4. Transient Response",
      "x_axis": "time",
      "time_axis_evidence": "50 us/div",
      "response_quantity": "voltage",
      "public_pin_observable": true,
      "fixture_reproducible": false,
      "reason": "State the source-backed eligibility decision.",
      "crop": {
        "page": 12,
        "render_dpi": 200,
        "x_px": 100,
        "y_px": 100,
        "width_px": 600,
        "height_px": 500
      }
    }
  ]
}

Every reviewed_hints[] entry requires reason. A graph disposition requires graph_id;
a not_time_graph disposition must omit graph_id. Add electrical_binding and
digitized_curve to an eligible graph using the exact nested property names described
above. On a correction attempt, delete every field named as unsupported in the server
feedback; do not replace it with a guessed synonym.`
  return feedback
    ? `${base}\n\nThis is a correction attempt. model-reference-observation.json is already seeded with the
previous rejected candidate. Read that retained file first; do not repeat the full PDF inventory
or replace the artifact. Make the smallest edit that resolves only the graph ids and fields named
in the latest validation error. Preserve every unmentioned graph and every unmentioned field,
including reviewed hints, crop rectangles, electrical bindings, trace points, trace colors, and axis
values. A candidate graph omitted from
the latest source-verification rejection already passed that verification and must not be changed.
Server-recognized grid coordinates apply to the retained crop exactly, so keep its origin fixed unless
the latest feedback explicitly says a printed scale or panel is clipped. In that case follow the
feedback's crop-edge and coordinate-translation formula exactly so every source-image position is preserved.
When feedback reports a server-required axis-anchor value span, use that exact numeric span; the
rounded grid coordinates are supporting evidence, not a value to estimate from. When feedback names
weak point-to-point trace segments, inspect the original-resolution crop and replace every point within
those segment bounds as needed so consecutive samples densely follow one continuous response centerline.
Do not join corrected endpoints with guessed straight interpolation or switch to another same-colored
scope channel. Preserve the server-required point count, 90% axis coverage, and maximum-gap rule;
relocate existing points first, and only remove a redundant flat-span point one-for-one with an added
transition point when the 48-point limit requires room.
If a high logic_state reference is rejected, replace reference:"gnd" with
the positive dut.<spice_node> endpoint of the single printed input-supply dc_voltage fixture; preserve
the logic endpoint, state, and every other fixture.
The final "Rejected attempt N" block below is the only current validation result. Earlier rejected-attempt
blocks are history and regression guards: do not reapply an old correction, restore an old value, or edit a
graph merely because an earlier block named it. Correct every error in the final block only. Preserve the
current retained value for every graph and field that the final block does not name.\n\nValidation history (final block is current):\n${feedback}`
    : base
}

export function buildComparisonReferenceGraphObserverPrompt(feedback?: string): string {
  return `Complete numeric curve calibration for the already-found references in the seeded
model-reference-observation.json. The Find Reference Graphs output is immutable input:
do not add, remove, rename, reclassify, or move a graph, and do not change reviewed_hints,
crop rectangles, figure locators, pages, or reproducibility decisions. Add only the exact
electrical_binding and digitized_curve required for each eligible graph. This numeric work
belongs to Create Comparison Graphs.

The following artifact rules define those comparison fields. Where they discuss doing a
fresh inventory, the immutable seeded discovery above takes precedence.

${buildReferenceGraphObserverPrompt(feedback)}`
}
