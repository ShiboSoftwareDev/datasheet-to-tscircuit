export function buildModelSetupPrompt(validation_feedback?: string): string {
  const correction = validation_feedback
    ? `

The server rejected the previous evidence package. Correct every item in this
exact validation feedback without deleting eligible figures or visible traces:

<server-evidence-validation-feedback>
${validation_feedback}
</server-evidence-validation-feedback>

Reinspect the affected full figure PNGs with the built-in read tool, replace the
invalid crops, CSVs, trace provenance, counts, and draft records, then rewrite
setup-complete.json only after the complete package is valid. Run
\`bun validate-setup-evidence.ts\` and correct its complete error list before
exiting.`
    : ""

  return `Prepare the untimed evidence and benchmark-reference package for a SPICE behavioral model.

Read AGENTS.md first. Analyze datasheet.pdf, render every relevant electrical
graph page to PNG, and call the built-in \`read\` tool on every graph PNG before
digitizing it. Use Bun/TypeScript with the installed \`sharp\` package for crops
and pixel processing, and \`JSON.parse\` for JSON checks; do not depend on Python,
Pillow, ImageMagick, or jq. Search the complete extracted document, including
application, timing, design, and protection sections after typical characteristics;
do not truncate graph discovery with \`head\`. Search every Figure caption plus
transient, waveform, response time, startup, start-up, turn-on, turn-off, and
printed time-per-division axes. If a rendered PNG is too large for \`read\`, run
\`bun prepare-vision-image.ts <input.png> <review.jpg>\` and read the prepared JPEG
one at a time. Keep any reusable Sharp inspection scripts inside this workspace,
not under /tmp. Draft only figures whose printed x-axis is time. First count every
distinct plotted pane/subplot inside each printed figure, including stacked or
side-by-side oscilloscope screens, and record source.subplot_count. Then count
every visible waveform trace across all panes and record source.channel_count.
A pane can contain multiple colored traces; each trace is a separate series.
Record subplot_index on every series and ensure every subplot index from 1 through
source.subplot_count has at least one series. Never assume two panes or two traces,
and never derive these counts from a script template. Reinspect the complete figure
visually after inventorying it. Classify every trace as a DUT response or harness
stimulus. No pane or trace may be silently omitted. Each trace gets its own
reference CSV containing the complete waveform with time in milliseconds as x.
Treat the plotted left edge as elapsed time zero. If pixel calibration produces
sub-pixel x values below zero, clamp values within 1% of the full trace span to
zero in both the CSV and trace JSON; a materially negative elapsed-time axis is
invalid.
Record the physical quantity and printed unit literally: current channels such
as inductor current or load current must use quantity \`"current"\` and an ampere
unit, never \`"voltage"\`/\`"V"\` merely because the simulator will later sense
them through a resistor.
Retain every drafted benchmark's full source page at
\`evidence/pages/datasheet-page-<page>.png\`, using the page number recorded in
the benchmark source. Also crop the exact complete multi-channel figure used by every draft to
\`evidence/figures/<benchmark-id>.png\` and record that path as \`source.image\`.
Crop every individual trace with its label and scale legend to
\`evidence/figures/<benchmark-id>/<series-id>.png\`, and write its values to
\`evidence/curves/<benchmark-id>/<series-id>.csv\`. The number of series must equal
source.channel_count. The full crop must show that benchmark's figure, not the
whole page or another graph from the same page.

For every series also write
\`evidence/traces/<benchmark-id>/<series-id>.json\` and record it as trace_file.
The trace file must use version 1, method \`manual_pixel_trace\` or
\`image_color_trace\`, cite the exact per-series source_image, declare the visible
trace_color as integer r/g/b plus a tolerance from 4 through 120, provide two
pixel/value calibration anchors for each x_axis and y_axis, and list distributed
\`{ pixel_x, pixel_y, x, y }\` points in the same order and with the same numeric
x/y values as the CSV. The x-axis anchors must identify the plotted time span's
left and right edges. Trace the waveform across at least 90% of that span, leave
no unsampled gap larger than 20%, and provide at least one point per 12 horizontal
pixels (up to 48 required points, with an eight-point minimum). An axis is
\`{ "scale": "linear", "first": { "pixel": 10, "value": 0 }, "second": { "pixel": 210, "value": 1 } }\`;
use the actual printed axis values and \`"log"\` only for a printed log axis.
For oscilloscope captures, calibrate each channel from that channel's own
volts-per-division or amps-per-division and vertical zero/offset marker; never map
all channels through one global image y range. The reference's low and high
stimulus levels must agree with printed operating conditions such as
\`IO 100 mA to 1 A\` or \`VI 2.2 V to 4.2 V\`. Follow the continuous plotted
centerline only. For a rising enable channel whose lower plateau is aligned with
that channel's ground marker, record the lower level as 0 V; a negative rising
enable baseline means the channel was calibrated from the crop instead of its own
marker; exclude same-colored labels, legends, channel markers, cursors,
and isolated grid artifacts. Use the smallest color tolerance that follows the
anti-aliased trace. Place neighboring points within a few horizontal pixels on
both sides of every fast edge instead of interpolating across an unsampled jump.
Axis calibration must map every listed pixel back to its CSV value. The server
decodes the PNG and rejects points that do not touch the declared trace color,
colors that are actually the image background, missing colored traces, incomplete
subplot coverage, or mismatched CSV values.

Do not copy the full multi-channel figure into the per-channel image paths. Do not
write reference values from analytic formulas, generated sine/exponential/ramp
families, guessed nominal behavior, or generic reusable templates. Image-processing
code may locate actual plotted pixels, but every CSV value must be calibrated from
the retained source image and backed by trace_file pixel coordinates. Digitize
each response independently from its own visible trace and preserve the
figure-specific timing, amplitude, overshoot, ripple, and settling.
If two stimulus channels are genuinely identical, retain them with their separate
source crops and independently traced pixel coordinates; exact duplicate response
CSVs from different figures cannot support an accuracy claim.
Use stable benchmark and series ids matching \`^[A-Za-z0-9][A-Za-z0-9._-]*$\`
from the draft onward. Commas and spaces are not valid ids.
Ignore static curves whose x-axis is a swept voltage, current, load,
temperature, frequency, or other parameter. In benchmark-draft.json version 2,
write figure_inventory[] with one entry for every reviewed electrical graph:
classify x_axis as "time" or "static". Every time entry must have status
\`"drafted"\` plus its benchmark_id, subplot_count, and channel_count matching the
corresponding benchmark source; the time-entry ids must exactly equal the ids in
benchmarks[]. A time-domain graph may not be marked excluded or recorded in a
separate omitted/not-drafted list. Record operating conditions and provenance.
This phase runs in parallel with the component agent, so component.circuit.tsx
may not exist yet.

Create model-progress.json immediately, then update it throughout extraction,
graph digitization, and benchmark drafting as specified in AGENTS.md.

Do not guess the final pin mapping, create testbench circuits, generate model.lib,
or tune a model in this phase. Do not wait or poll for the component. When all
work that is independent of the component is complete, write setup-complete.json
with version 2, completion timestamp, evidence-file count, and draft-benchmark
count. Then run \`bun validate-setup-evidence.ts\`, correct every reported
benchmark—not only the first—and rerun it until it passes before exiting. The
server will validate the pixel evidence before waiting for
and providing the component.${correction}`
}
