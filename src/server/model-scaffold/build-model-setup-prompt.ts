export function buildModelSetupPrompt(): string {
  return `Prepare the untimed evidence and benchmark-reference package for a SPICE behavioral model.

Read AGENTS.md first. Analyze datasheet.pdf, render every relevant electrical
graph page to PNG, and call the built-in \`read\` tool on every graph PNG before
digitizing it. Draft only figures whose printed x-axis is time. Inventory every
visible oscilloscope channel in each eligible figure, record source.channel_count,
and classify each channel as a DUT response or harness stimulus. No channel may
be silently omitted. Each channel gets its own reference CSV containing the
complete waveform with time in milliseconds as x.
Retain every drafted benchmark's full source page at
\`evidence/pages/datasheet-page-<page>.png\`, using the page number recorded in
the benchmark source. Also crop the exact complete multi-channel figure used by every draft to
\`evidence/figures/<benchmark-id>.png\` and record that path as \`source.image\`.
Crop every individual channel with its label and scale legend to
\`evidence/figures/<benchmark-id>/<series-id>.png\`, and write its values to
\`evidence/curves/<benchmark-id>/<series-id>.csv\`. The number of series must equal
source.channel_count. The full crop must show that benchmark's figure, not the
whole page or another graph from the same page.
Use stable benchmark and series ids matching \`^[A-Za-z0-9][A-Za-z0-9._-]*$\`
from the draft onward. Commas and spaces are not valid ids.
Ignore static curves whose x-axis is a swept voltage, current, load,
temperature, frequency, or other parameter. In benchmark-draft.json version 2,
write figure_inventory[] with one entry for every reviewed electrical graph:
classify x_axis as "time" or "static". Every time entry must have status
"drafted" plus its benchmark_id, and the time-entry ids must exactly equal the
ids in benchmarks[]. A time-domain graph may not be marked excluded or recorded
in a separate omitted/not-drafted list. Record operating conditions and
provenance. This phase runs in parallel with the
component agent, so component.circuit.tsx may not exist yet.

Create model-progress.json immediately, then update it throughout extraction,
graph digitization, and benchmark drafting as specified in AGENTS.md.

Do not guess the final pin mapping, create testbench circuits, generate model.lib,
or tune a model in this phase. Do not wait or poll for the component. When all
work that is independent of the component is complete, write setup-complete.json
with version 2, completion timestamp, evidence-file count, and draft-benchmark
count, then exit. The server will wait for and provide the component.`
}
