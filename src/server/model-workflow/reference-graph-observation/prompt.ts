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
A graph is also ineligible when its hint has any condition_conflicts entry or
transient_fixture_evidence:null. A typed condition_conflict means the retained summary row
and graph-local caption disagree; never choose a preferred source. Null evidence otherwise
means the server could not prove one complete experiment: a printed non-flat public-pin
voltage/current step with numeric levels and rise/fall timing, the response nominal, and
all printed static conditions. Never invent a pulse or omit an auxiliary condition. When
printed_experiment_conditions_v2 evidence is present, copy its response, stimulus, and
auxiliary conditions exactly into the public-pin binding; the server resolves and checks
every signal.
A hint whose reason names a transient/timing caption is an authoritative graph inventory
entry and must use disposition graph. Only a proximity-only hint whose reason is a
printed-time-axis marker may use not_time_graph after visual inspection.

Every eligible graph (response_quantity voltage, public_pin_observable true, and
fixture_reproducible true) must contain electrical_binding and digitized_curve.
electrical_binding is the graph's immutable public-pin test identity:
{response:{type:"voltage",positive,negative,nominal_volts},
stimulus:{type,positive,negative,pulse:{low,high,delay,rise,fall,width,period}},
auxiliary_fixtures:[...]}. A dc_voltage auxiliary uses
{type:"dc_voltage",positive,negative,dc_volts}; dc_current uses
{type:"dc_current",positive,negative,dc_amps}; and a logic state uses
{type:"logic_state",endpoint,reference,state}. Map a printed load current as a sink
from the response output to ground. Map logic low as a zero-volt tie to ground and logic
high as a zero-volt tie to the one printed public input-supply endpoint. If that endpoint
is not unique, the graph is ineligible. nominal_volts constrains the observed response;
never create a voltage-source auxiliary across the response endpoints.
Do not write application_fixture_sha256 or application_topology_sha256. Those fields
are computed and injected by the server after it resolves the printed conditions
against application-fixture-contract.json; they are never agent-authored.
Each endpoint must be gnd or dut.<spice_node>, where the SPICE node appears exactly
in model-interface.json. Response endpoints are the plotted voltage polarity, not a
convenient substitute. Stimulus type is voltage_step or current_step and its
endpoints are the orientation of the one ordinary pulsed source that reproduces the
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
  Pixel coordinates are relative to the exact graph crop, not the full PDF page.
  Put the minimum-value anchor first and maximum-value anchor second. Use two visible,
  widely separated tick/grid positions on each axis.
- trace_color as integer RGB plus tolerance from 4 through 120
- points[] with pixel_x,pixel_y,x,y. Supply finite x/y values; the server owns and
  canonicalizes them from the exact pixel coordinates and two axis anchors in
  seconds/volts, so pixel_x/pixel_y and the visible anchors are authoritative.

Trace the visible response centerline from the left edge through the right edge. Supply
at least min(48,max(8,ceil(horizontal_axis_pixel_span/14))) and at most 48 points,
strictly progressing across time, covering at least 90% of the calibrated axis, with
no gap over 20%. Do not trace labels, axes, stimulus channels, or an invented smooth
curve. The server independently recomputes every numeric value from the pixel-axis
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
      "graph_id": "figure_10_21",
      "reason": "Visually confirmed the hinted elapsed-time graph."
    }
  ],
  "graphs": [
    {
      "graph_id": "figure_10_21",
      "page": 25,
      "locator": "Figure 10-21. Load Transient",
      "x_axis": "time",
      "time_axis_evidence": "100 us/div",
      "response_quantity": "voltage",
      "public_pin_observable": true,
      "fixture_reproducible": false,
      "reason": "State the source-backed eligibility decision.",
      "crop": {
        "page": 25,
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
    ? `${base}\n\nCorrect every retained-candidate error below before returning the artifact:\n${feedback}`
    : base
}
