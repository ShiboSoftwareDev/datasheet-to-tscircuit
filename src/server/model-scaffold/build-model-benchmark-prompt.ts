export function buildModelBenchmarkPrompt(
  validation_feedback?: string,
  options: { locked_circuit_repair?: boolean } = {},
): string {
  const correction = validation_feedback
    ? `

The server rejected the previous benchmark suite${
        options.locked_circuit_repair ? " after detecting a structural circuit defect" : " before locking it"
      }. Correct the executable benchmark circuit using this exact validation feedback:

<server-benchmark-validation-feedback>
${validation_feedback}
</server-benchmark-validation-feedback>

Treat every benchmark listed in the feedback as required work and repair all of
them in this pass. The server rejects a repair that leaves the benchmark circuits
unchanged. Do not weaken, remove, or replace benchmarks to avoid the error. ${
        options.locked_circuit_repair
          ? "The server will reject any change outside benchmarks/*.circuit.tsx: do not edit benchmarks.json, evidence, conditions, weights, critical flags, tolerances, or transient waveform definitions."
          : "Preserve the draft's evidence, conditions, weights, critical flags, and tolerances while repairing the manifest or executable testbench contract."
      } Then exit for another server validation pass.`
    : ""
  return `Finalize and freeze the benchmark suite for this SPICE behavioral-model run.

The authoritative component.circuit.tsx and typical-application-plan.json are now available.
Read AGENTS.md, benchmark-draft.json, component.circuit.tsx,
typical-application-plan.json, and the evidence package. Create the
complete version-2 benchmarks.json manifest and exactly one benchmarks/<id>.circuit.tsx per
benchmark figure. Preserve every draft series and declare its server-verifiable
simulation mapping. Every series needs a unique probe_name; response series also
need dut_spice_node. Every visible source channel must be classified and cited under
evidence/. Preserve each draft's exact graph crop as
\`source.image: "evidence/figures/<benchmark-id>.png"\`; the server rejects a
missing, renamed, or invalid PNG crop. Update model-progress.json while working.
Benchmark and series ids may contain only letters, digits, dots, underscores, and
hyphens, must start with a letter or digit, and must not contain commas or spaces.

Preserve the typical application's external component reference designators, values, and
invariant power/feedback connectivity in every harness. Instantiate the generated component as
DUT in place of the plan's primary IC. EN, MODE, and similar control pins may use benchmark
stimuli, and extra sources or loads may be added, but do not remove or bypass the feedback
divider, input/output capacitors, inductor, power-good pull-up, or their datasheet nets.

Accept only drafts whose reference x-axis is time. Every accepted series
must use simulation.kind \`"transient_voltage"\`, simulation.x_axis \`"time_ms"\`,
and one shared analog transient run must emit every declared response and stimulus
channel. Use one voltage probe per series. Stimulus probes verify the actual applied
harness waveform; voltage response probes connect directly to the declared DUT pin.
Current response probes instead measure differentially across a named explicit sense
resistor in series at simulation.dut_spice_node. Set the
analogsimulation duration to at least one timePerStep beyond the final reference
x value so the simulator cannot end one sample before the locked reference.

Use tscircuit's source semantics exactly. A square \`voltagesource\` is always
0 V to its \`voltage\` value; \`peakToPeakVoltage\` does not create a DC offset.
A square \`currentsource\` is always 0 A to \`peakToPeakCurrent\`; its
\`current\` value is not an offset while \`waveShape\` is present. For a 0 V-to-high
enable edge, use one square voltage source with \`voltage\` equal to the high level
and the required \`pulseDelay\`. For a nonzero-low input step, use one DC bias
voltage source in series with one 0 V-to-delta square source as a single
ground-referenced chain. If you instead use a harness-local \`<spicemodel>\`
PULSE driver, map its SPICE nodes to the chip pins in the correct direction and
still probe the stimulus at the DUT port, never at the helper source. For a
nonzero-low current step, combine a separate DC current source with pulse sources
and verify the actual current through an explicit sense resistor. Measure every
voltage stimulus at the driven DUT port (for example \`.DUT > .VIN\` or
\`.DUT > .EN\`), never at the source component's pin. Measure current stimuli
differentially across their sense resistor and set simulation.scale to convert the
sense voltage back into the printed current unit. Use the same contract for current
responses: declare simulation.sense_resistor, measure its two distinct pins with
connectsTo/referenceTo, and use a scale equal to 1/R for A (1000/R for mA,
1000000/R for uA; negative is allowed for reversed probe polarity). Never drive a
switch or inductor pin with a behavioral voltage source to manufacture a waveform
labelled as current.

Omit the analogsimulation \`simulationType\` prop or set it exactly to
\`"spice_transient_analysis"\`. Before committing the lock, the server performs
static contract validation, source compilation, and one simulation of every
harness using a simple server-owned stub model. Fix every shorted source, unresolved
node, simulator abort, and source/simulation error found by that preflight. The server
also probes every DUT pin marked requiresPower and rejects a harness whose supply
remains effectively at 0 V. For every such pin, include a direct voltage probe named
\`SERVER_PREFLIGHT_POWER_<PIN>\` connected to \`.DUT > .<PIN>\` and referenced to
\`net.GND\`; for example VIN uses \`SERVER_PREFLIGHT_POWER_VIN\`. These diagnostic
probes are not scoring outputs. Do not compensate for a broken stimulus in the DUT model.
Do not place ideal voltage sources in parallel or form a floating source loop. The
actual candidate model simulations run only during refinement and independent
validation, when a canonical model exists.

This is an untimed benchmark-only pass. Do not create or modify model.lib,
model-manifest.json, component-with-model.circuit.tsx, candidates/,
iteration-history.json, model-card.md, validation-report.json, or any simulated
result CSV. Do not fit, tune, or run a model. Exit as soon as the complete
benchmark suite is ready; the server will validate and lock it before refinement.${correction}`
}
