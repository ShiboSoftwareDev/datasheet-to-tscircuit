import { MAX_TRACE_POINTS } from "./schema"

function correctionBlock(feedback?: string): string {
  if (!feedback) return ""
  return `

This is a correction attempt. Read the seeded artifact first and make only the
smallest edits required by the final rejection block. Preserve every graph,
crop, binding, channel, trace point, color, and axis value that the final block
does not name. Earlier rejection blocks are history, not current instructions.
When the final block reports off-trace points together with the declared color,
tolerance, and nearest color distance, the color and tolerance are named: if
the points visibly lie on the same plotted hue, correct that calibration rather
than moving valid centerline points or inventing intermediate pixels.

Validation history (the final block is current):
${feedback}`
}

export function buildFoundReferenceGraphObserverPrompt(feedback?: string): string {
  const prompt = `Find every printed elapsed-time graph in the complete datasheet.

Read datasheet.pdf from first page to last page and time-graph-hints.json. Write
only model-reference-observation.json.

Return the version-1 source_pdf_sha256, reviewed_hints[], and graphs[] contract.
Review every deterministic hint exactly once. A caption-proven transient hint
must be classified as a graph; only a proximity-only printed-axis hint may be
not_time_graph after visual inspection. Include additional elapsed-time graphs
only when their operating conditions are source-grounded.

Each graph contains graph_id, page, locator, literal x_axis:"time",
time_axis_evidence, response_quantity (voltage/current/other),
public_pin_observable, fixture_reproducible, reason, and one exact 200-DPI crop
{page,render_dpi:200,x_px,y_px,width_px,height_px}. The crop must contain the
complete plot, every plotted line, axes, scope controls, and adjacent figure
number/caption, without a neighboring figure.

This task discovers references only. Every graph must omit electrical_binding
and channels. Calibration, plotted-channel inventory, trace points, and all
numeric comparison data belong exclusively to Create Comparison Graphs.

Use time-graph-hints.json as the authority for simulator eligibility. An
elapsed-time graph is reproducible only when its deterministic hint has a
complete transient_fixture_evidence receipt and no unsupported fixture
condition. Supported fixtures are pulsed/DC voltage or current sources and
resistors, capacitors, inductors, and diodes connected to public DUT pins.
Steady-state stimuli are not reproducible for causal elapsed-time switching.
Register programming, digital protocols, inaccessible state, unsupported
temperature/frequency/parasitic controls, and incomplete printed conditions
make a graph ineligible. Never invent or omit an input to make it eligible.

Use these exact property names. Example:
{
  "version": 1,
  "source_pdf_sha256": "COPY_FROM_TIME_GRAPH_HINTS",
  "reviewed_hints": [{
    "hint_id": "time_graph_001",
    "disposition": "graph",
    "graph_id": "figure_4_elapsed_time",
    "reason": "Visually confirmed the elapsed-time graph."
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
    "reason": "Public output under a completely specified step experiment.",
    "crop": {"page":12,"render_dpi":200,"x_px":100,"y_px":100,"width_px":600,"height_px":500}
  }]
}`
  return `${prompt}${correctionBlock(feedback)}`
}

export function buildReferenceGraphObserverPrompt(feedback?: string): string {
  const prompt = `Complete numeric comparison data for the eligible elapsed-time
graphs in model-reference-observation.json.

Read the seeded observation, datasheet.pdf, model-interface.json,
application-fixture-contract.json, and time-graph-hints.json. Inspect each exact
crop at its original 200-DPI pixel dimensions. Write only
model-reference-observation.json.

For a single-graph task, reference-graph.png is the exact server-rendered crop
at its original dimensions. Read that image directly; do not re-render or crop
the PDF with a helper script.

Discovery is immutable input. Do not add, remove, rename, reclassify, or move a
graph. Do not change reviewed_hints, crop rectangles, figure locators, pages,
reproducibility decisions, or discovery reasons. Add only electrical_binding
and channels to each eligible graph. Ineligible graphs must omit both.

electrical_binding is one immutable experiment shared by all plotted channels:
{response:{type:"voltage",positive,negative,nominal_volts},
stimulus:{type:"voltage_step"|"current_step",positive,negative,pulse:{low,high,delay,rise,fall,width,period}},
auxiliary_fixtures:[...]}. Every auxiliary fixture must use exactly one of these
four shapes and exact value-field names:

- {"type":"dc_voltage","positive":endpoint,"negative":endpoint,"dc_volts":number}
- {"type":"dc_current","positive":endpoint,"negative":endpoint,"dc_amps":number}
- {"type":"logic_state","endpoint":endpoint,"reference":endpoint,"state":"low"|"high"}
- {"type":"resistor","positive":endpoint,"negative":endpoint,"resistance_ohms":positive_number}

There is no generic value, voltage, volts, current, or resistance field. Copy
source kind, endpoints, values, and timing from the graph's
printed_experiment_conditions_v3 hint. Endpoints are gnd or dut.<spice_node>
from model-interface.json. Do not author application fixture digests; the
server injects them.

A low logic state references gnd. A high logic state must reference the exact
positive public input-supply endpoint from the single printed dc_voltage
auxiliary fixture; it must not reference gnd.

The source receipt fixes pulse low, high, rise, and fall. Derive its remaining
timing only from the visible elapsed-time plot: delay is the first plotted
stimulus edge; when a second edge is visible, width places that entire edge in
the calibrated window; otherwise width holds the stepped level through the end
of the window. Set period beyond the calibrated window and beyond both edges so
the plot contains no invented repeat. Never leave an edge straddling the end of
the calibrated window.

Inventory every visually distinct plotted line in the source plot. Create
exactly one channels[] entry for every line that tscircuit can simulate:

- A public voltage line uses measurement
  {type:"voltage",positive:"dut.<spice_node>",negative:"gnd"} (or the exact
  printed differential public endpoints).
- A current line through the pulsed source uses measurement
  {type:"current",element_id:"stimulus",direction:"positive_to_negative"}.
- A current line through a canonical application passive uses that passive's
  exact id from application-fixture-contract.json, such as an inductor id, and
  the direction visible in the source experiment.

Do not omit stimulus lines. Do not merge lines, choose only a representative,
or create one comparison per figure. Omit a line only when it cannot be bound
to a public voltage or a current through a concrete supported fixture element;
never invent a private DUT node or fictitious element to include it. Scope
labels, axes, cursors, and UI decorations are not plotted lines.

Each channel is:
{
  "channel_id":"stable_snake_case_id",
  "label":"printed line label",
  "role":"response"|"stimulus",
  "measurement":{...},
  "digitized_curve":{...}
}

There must be exactly one response channel whose voltage measurement equals
electrical_binding.response. When the bound stimulus is visibly plotted, it
must appear exactly once with role:"stimulus" and the matching measurement; do
not invent a stimulus channel when the plot does not show it. Other simulated
lines use role:"response". Channel ids must be unique within the graph.

digitized_curve uses:

- method:"manual_pixel_trace" or "image_color_trace"
- x_quantity:"time", x_unit:"s"
- y_quantity:"voltage", y_unit:"V" for voltage measurements
- y_quantity:"current", y_unit:"A" for current measurements
- x_range/y_range {min,max} in base SI units
- x_axis/y_axis {scale:"linear",first:{pixel,value},second:{pixel,value}}
- trace_color {r,g,b,tolerance}, with integer RGB and tolerance 4 through 120
- points[] containing crop-local pixel_x and pixel_y only; the server derives
  x and y values from the axis anchors

All channels in one plot share the exact same time axis, so their x_range and
x_axis must be identical. Translate a pre-trigger screen to elapsed time
starting at 0 while preserving visible spans and transition offsets. Use two
visible, widely separated grid positions for each axis, with minimum-value
anchor first and maximum-value anchor second. Y-axis values use volts or amps
as declared by that channel.

Trace each line's visible centerline independently from left to right. Supply
at least min(${MAX_TRACE_POINTS},max(8,ceil(horizontal_axis_pixel_span/14))) and at most ${MAX_TRACE_POINTS}
strictly time-progressing points, cover at least 90% of the calibrated x axis,
and leave no gap over 20%. Points must touch the declared-color connected line;
do not trace labels, axes, another same-colored line, or an invented smooth
curve.

Choose one representative trace color for the whole rendered line, not merely
its darkest or most saturated pixel. Set tolerance high enough to include that
line's antialiasing and brightness variations across the complete plot, while
remaining narrow enough to exclude other channels, labels, grid lines, and the
background. If a correction reports that visually correct same-hue points have
a nearest color distance just above the declared tolerance, recalibrate the
representative RGB or widen tolerance (up to 120); do not move those points off
the rendered centerline to preserve an overly narrow color declaration.

The polyline between consecutive points must follow the rendered line rather
than taking a shortcut around it. Preserve every visible spike, dip, edge,
local maximum, and local minimum. Put intermediate points through steep or
oscillating features; if the ${MAX_TRACE_POINTS}-point limit requires redistribution, remove
points only from genuinely flat spans away from transitions. A correction must
never flatten or reduce a visible feature merely to pass continuity checks.

A near-vertical plotted edge may be rasterized as verified colored pre-edge and
post-edge endpoints with no colored intermediate pixels. Keep those two points
adjacent in the point list and very close in pixel_x; do not invent off-trace
points between them. Preserve the endpoint at every visible extremum and sample
the recovery or return separately. This narrowly represents a rasterized edge;
it does not permit a longer horizontal shortcut around a spike, dip, or curve.

The property names are exact. Do not use graph-level digitized_curve, plots,
series, pdf_page, figure, or other aliases. A minimal eligible graph extension
looks like:
{
  "electrical_binding": {
    "response":{"type":"voltage","positive":"dut.OUT","negative":"gnd","nominal_volts":3.3},
    "stimulus":{"type":"current_step","positive":"dut.OUT","negative":"gnd","pulse":{"low":0.1,"high":1,"delay":0.0002,"rise":0.000001,"fall":0.000001,"width":0.0008,"period":0.002}},
    "auxiliary_fixtures":[]
  },
  "channels": [
    {
      "channel_id":"output_voltage",
      "label":"Vo",
      "role":"response",
      "measurement":{"type":"voltage","positive":"dut.OUT","negative":"gnd"},
      "digitized_curve": {
        "method":"image_color_trace","x_quantity":"time","x_unit":"s",
        "y_quantity":"voltage","y_unit":"V",
        "x_range":{"min":0,"max":0.001},"y_range":{"min":3.2,"max":3.4},
        "x_axis":{"scale":"linear","first":{"pixel":30,"value":0},"second":{"pixel":530,"value":0.001}},
        "y_axis":{"scale":"linear","first":{"pixel":300,"value":3.2},"second":{"pixel":100,"value":3.4}},
        "trace_color":{"r":40,"g":80,"b":240,"tolerance":40},
        "points":[
          {"pixel_x":30,"pixel_y":200},
          {"pixel_x":44,"pixel_y":198},
          {"pixel_x":58,"pixel_y":196},
          {"pixel_x":72,"pixel_y":194},
          {"pixel_x":86,"pixel_y":192},
          {"pixel_x":100,"pixel_y":190},
          {"pixel_x":114,"pixel_y":188},
          {"pixel_x":128,"pixel_y":186}
        ]
      }
    }
  ]
}`
  return `${prompt}${correctionBlock(feedback)}`
}

export function buildComparisonReferenceGraphObserverPrompt(feedback?: string): string {
  return buildReferenceGraphObserverPrompt(feedback)
}

export function buildSingleComparisonReferenceGraphObserverPrompt(
  graph_id: string,
  feedback?: string,
): string {
  return `Create comparison channels for exactly one immutable discovered graph: ${graph_id}.

model-reference-graph.json contains that one graph object, not the full observation.
Read reference-graph-preflight.json before inspecting the exact source crop. It
contains bounded server-derived facts from the immutable PDF: figure identity,
candidate grid lines, printed division scales and source units-per-pixel. Use
listed grid lines for axis-anchor pixels, preferring recommended_anchor_pixels
when present. Copy the matching required_anchor_value_span_candidates value
exactly; it is the server-computed product of source units-per-pixel and that
anchor pair. Do not estimate it from rounded grid positions. When multiple voltage-scale
candidates are listed, use the printed control nearest the channel being traced.
The preflight is guidance only; the server will still verify the submitted crop,
axes, and pixels independently.

Inspect the graph and exact source crop, then add electrical_binding and channels
in place. Write only model-reference-graph.json and keep it as one graph object.
Do not edit any discovery field. The server combines independently completed
graphs; you are not responsible for any other figure.

The detailed comparison rules below apply to this graph. Where they refer to a
full model-reference-observation.json, use model-reference-graph.json instead.

${buildReferenceGraphObserverPrompt(feedback)}`
}
