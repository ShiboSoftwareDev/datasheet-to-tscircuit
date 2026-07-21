export function buildModelSetupPrompt(): string {
  return `Prepare the untimed evidence and benchmark-reference package for a SPICE behavioral model.

Read AGENTS.md first. Analyze datasheet.pdf, render every relevant electrical
graph page to PNG, and call the built-in \`read\` tool on every graph PNG before
digitizing it. Draft only graphs whose printed x-axis is time. Each eligible
reference CSV must contain the complete waveform with time in milliseconds as x.
Retain every drafted benchmark's full source page at
\`evidence/pages/datasheet-page-<page>.png\`, using the page number recorded in
the benchmark source. Also crop the exact graph used by every draft to
\`evidence/figures/<benchmark-id>.png\` and record that path as \`source.image\`.
The crop must show that benchmark's graph, not the whole page or another graph
from the same page.
Ignore static curves whose x-axis is a swept voltage, current, load,
temperature, frequency, or other parameter. Record operating conditions and
provenance and write benchmark-draft.json. This phase runs in parallel with the
component agent, so component.circuit.tsx may not exist yet.

Create model-progress.json immediately, then update it throughout extraction,
graph digitization, and benchmark drafting as specified in AGENTS.md.

Do not guess the final pin mapping, create testbench circuits, generate model.lib,
or tune a model in this phase. Do not wait or poll for the component. When all
work that is independent of the component is complete, write setup-complete.json
with a version, completion timestamp, evidence-file count, and draft-benchmark
count, then exit. The server will wait for and provide the component.`
}
