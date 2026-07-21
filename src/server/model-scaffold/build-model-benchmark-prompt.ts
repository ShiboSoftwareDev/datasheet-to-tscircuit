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
complete benchmarks.json manifest and exactly one benchmarks/<id>.circuit.tsx per
benchmark. Every benchmark must declare its server-verifiable simulation mapping,
including probe_name and dut_spice_node, and must cite immutable evidence under
evidence/. Preserve each draft's exact graph crop as
\`source.image: "evidence/figures/<benchmark-id>.png"\`; the server rejects a
missing, renamed, or invalid PNG crop. Update model-progress.json while working.

Preserve the typical application's external component reference designators, values, and
invariant power/feedback connectivity in every harness. Instantiate the generated component as
DUT in place of the plan's primary IC. EN, MODE, and similar control pins may use benchmark
stimuli, and extra sources or loads may be added, but do not remove or bypass the feedback
divider, input/output capacitors, inductor, power-good pull-up, or their datasheet nets.

Accept only drafts whose reference x-axis is time. Every accepted benchmark
must use simulation.kind \`"transient_voltage"\`, simulation.x_axis \`"time_ms"\`,
and one analog transient run that emits the complete comparison waveform.

Omit the analogsimulation \`simulationType\` prop or set it exactly to
\`"spice_transient_analysis"\`. Before committing the lock, the server performs
static contract validation, source compilation, and one simulation of every
harness using a simple server-owned stub model. Fix every shorted source, unresolved
node, simulator abort, and source/simulation error found by that preflight. The
actual candidate model simulations run only during refinement and independent
validation, when a canonical model exists.

This is an untimed benchmark-only pass. Do not create or modify model.lib,
model-manifest.json, component-with-model.circuit.tsx, candidates/,
iteration-history.json, model-card.md, validation-report.json, or any simulated
result CSV. Do not fit, tune, or run a model. Exit as soon as the complete
benchmark suite is ready; the server will validate and lock it before refinement.${correction}`
}
