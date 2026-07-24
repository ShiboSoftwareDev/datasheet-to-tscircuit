export function buildModelAgentPrompt(): string {
  return `Develop and validate the ngspice-tested SPICE behavioral model in this workspace.

The untimed setup phase is complete, the authoritative component.circuit.tsx is
available, and the server has already locked the complete benchmark suite. The
refinement timer is running. Read AGENTS.md,
benchmarks.json, component.circuit.tsx, and run-control.json first. Do not modify
benchmarks.json, benchmark TSX, or evidence. Follow the simulation, deterministic
scoring, champion-promotion, and checkpoint workflow.
Continue the existing model-progress.json sequence and update it before and after
every benchmark simulation, score, candidate decision, and champion promotion.
Re-read run-control.json before every refinement iteration because the user may
extend the time budget while you work. Use the available time to improve the
same locked benchmark suite; do not reduce tests or loosen tolerances.
Establish a numeric baseline for every critical benchmark as early as practical.
Do not spend repeated iterations on one benchmark before each critical benchmark
has at least one current result. Rank refinement work by critical failures first,
then worst normalized error, and periodically rerun the complete critical suite.
Before promoting any candidate, run and score the complete locked suite. Every promoted
entry in iteration-history.json must record passing, total, score, and
worst_normalized_error from that same complete-suite run. Promote only when the candidate
is lexicographically better than the current champion: more passing benchmarks first,
then lower weighted score, then lower worst normalized error. Never replace a better
checkpoint with a worse candidate. The server re-evaluates this promotion record and
selects the best eligible immutable candidate before independent validation.
Run or refresh saved viewer output with
\`tsci build benchmarks/<benchmark-id>.circuit.tsx --ignore-warnings
--disable-pcb --routing-disabled --disable-parts-engine --simulation-svgs\`.
Convert its generated simulation.svg with \`bun render-svg-to-png.ts\`, then use
the built-in \`read\` tool on the resulting PNG. Inspect the actual plotted
waveform after every affected targeted diagnostic, correct visual anomalies, and
rerender before checkpointing. Run \`bun score-benchmark.ts <benchmark-id>\`, render
its \`diagnostics/<benchmark-id>/comparison.svg\` to PNG, and inspect the reference/result
overlay with \`read\` before promoting the candidate. This visual review is required but never replaces
the server-owned numeric score. The project runtime config preserves ngspice while
skipping unrelated PCB work. The UI only reads persisted Circuit JSON and will
not execute the TSX for you.
Never add, copy, or temporarily write circuit files under \`benchmarks/\`. Each
locked benchmark is already a complete time-domain simulation; build the affected
benchmark directly for a targeted diagnostic.

Do not encode the digitized reference curve or its timestamps directly in
model.lib. Do not use absolute TIME to replay a known benchmark waveform. Model
behavior from electrical inputs and internal state. Do not create narrow voltage,
current, load, MODE, or enable windows around the exact benchmark conditions, and
do not enumerate benchmark stimulus values in conditional expressions. Use
datasheet-supported operating thresholds and continuous causal behavior instead.
For every DUT-current response, produce current through a finite physical branch.
Never force the measured DUT current pin to ground with an ideal B, V, or E voltage
source merely to reproduce its plotted voltage waveform; the server rejects that
as synthetic current. Use a causal switch/current path with finite impedance so
the benchmark's external sense resistor measures actual branch current.
After the normal suite passes, the server perturbs one verified external feedback
divider and requires the output setpoint to follow it. A fixed benchmark output
that ignores FB fails this hidden check. The server also scans for TIME; only when
it is present does the server run one hidden stimulus-shift simulation and require
the output to move with the input.

If champion artifacts already exist, continue from them and preserve their
history. If a server-owned benchmark lock already exists, do not edit
benchmarks.json, benchmark TSX, or evidence CSVs; correction passes may change
only model artifacts and documentation. Keep a usable champion checkpoint at all times. Finish with every
required artifact and a freshly generated validation-report.json. If
validation-feedback.md exists, inspect it together with simulation-validation.json
and validation-artifacts, fix every item, run only the affected local diagnostics,
and return the checkpoint to the server without repeating its exhaustive suite.
Describe model-card.md regions as intended or agent-tested, not server-validated;
the server owns the final validation claim.
Do not mark model-progress.json complete while any benchmark is failing. If effort expires,
leave the best candidate as a non-complete checkpoint for server validation. Do not stop at
a prose report and do not exit knowingly below 100% validation.`
}
