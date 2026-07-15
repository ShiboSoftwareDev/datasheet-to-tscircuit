import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JobStore } from "@/server/job-store"
import { buildModelAgentPrompt, buildModelSetupPrompt } from "@/server/model-scaffold"
import { runModel } from "@/server/model-runner"
import { ModelRunStore } from "@/server/model-run-store"

const lockedBenchmarkSource = `import Component from "../component-with-model.circuit"

export default function Benchmark() {
  return (
    <board routingDisabled>
      <Component name="DUT" />
      <voltageprobe name="VOUT_PROBE" connectsTo="DUT.pin2" />
      <analogsimulation duration="1ms" timePerStep="0.1ms" spiceEngine="ngspice" />
    </board>
  )
}
`

test("model prompt keeps benchmarks fixed while effort only extends iteration time", () => {
  const prompt = buildModelAgentPrompt()
  expect(prompt).toContain("Lock the complete benchmark suite")
  expect(prompt).toContain("refinement timer is running")
  expect(prompt).toContain("Re-read run-control.json")
  expect(prompt).toContain("do not reduce tests or loosen tolerances")
  expect(prompt).toContain("100% validation")
  expect(prompt).toContain("tsci build benchmarks/<benchmark-id>.circuit.tsx --ignore-warnings")
  expect(prompt).toContain("UI only reads")
  expect(prompt).toContain("validation-artifacts")
  const setup_prompt = buildModelSetupPrompt()
  expect(setup_prompt).toContain("untimed evidence")
  expect(setup_prompt).toContain("Do not guess the final pin mapping")
  expect(setup_prompt).toContain("setup-complete.json")
  expect(setup_prompt).toContain("model-progress.json")
})

test("model runner validates and publishes the checkpointed champion", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-runner-"))
  const model_dir = join(job_dir, "spice")
  const agent_path = join(job_dir, "fake-model-agent")
  const tsci_path = join(job_dir, "fake-tsci")
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nfixture"),
    Bun.write(
      join(job_dir, "index.circuit.tsx"),
      'export default () => <chip name="U1" footprint="soic8" />\n',
    ),
    Bun.write(
      agent_path,
      `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
if (prompt.includes("untimed evidence")) {
  await Bun.write(dir + "/benchmark-draft.json", JSON.stringify({ version: 1, benchmarks: [{ id: "transfer", source: { page: 3 } }] }))
  await Bun.write(dir + "/model-progress.json", JSON.stringify({ sequence: 2, phase: "digitizing_graphs", message: "Digitized the transfer graph", updated_at: new Date().toISOString(), iteration: 0, evidence: { pages_reviewed: 4, graphs_found: 1, graphs_digitized: 1, benchmark_drafts: 1 } }))
  await Bun.write(dir + "/setup-complete.json", JSON.stringify({ version: 1, completed_at: new Date().toISOString(), evidence_file_count: 1, draft_benchmark_count: 1 }))
  console.log("setup checkpointed")
  process.exit(0)
}
await Bun.write(dir + "/model.lib", ".subckt SENSOR IN OUT\\nR1 IN OUT 1k\\n.ends SENSOR\\n")
await Bun.write(dir + "/model-manifest.json", JSON.stringify({ version: 1, part_number: "SENSOR", dialect: "portable", entry_name: "SENSOR", model_file: "model.lib", revision: "r0001", simulator: "ngspice", generated_at: new Date().toISOString(), pins: [{ component_pin: "pin1", spice_node: "IN" }, { component_pin: "pin2", spice_node: "OUT" }] }))
await Bun.write(dir + "/component-with-model.circuit.tsx", "export default () => <chip name=\\"U1\\" footprint=\\"soic8\\" spiceModel={<spicemodel source={\\".model D D\\"} spicePinMapping={{ D: \\"pin1\\" }} />} />\\n")
await Bun.write(dir + "/benchmarks/transfer.circuit.tsx", ${JSON.stringify(lockedBenchmarkSource)})
await Bun.write(dir + "/benchmarks.json", JSON.stringify({ version: 1, locked_at: new Date().toISOString(), benchmarks: [{ id: "transfer", title: "Transfer", source: { page: 3 }, critical: true, weight: 1, tolerance: 0.05, reference_file: "evidence/curves/transfer.csv", result_file: "results/champion/transfer.csv", simulation: { kind: "transient_voltage", probe_name: "VOUT_PROBE" } }] }))
await Bun.write(dir + "/evidence/curves/transfer.csv", "x,y\\n0,0\\n1,1\\n")
await Bun.write(dir + "/results/champion/transfer.csv", "x,y\\n0,0\\n1,1\\n")
await Bun.write(dir + "/iteration-history.json", JSON.stringify([{ revision: "r0001", decision: "promoted" }]))
await Bun.write(dir + "/model-card.md", "# SENSOR model\\nValidated with ngspice.\\n")
await Bun.write(dir + "/model-progress.json", JSON.stringify({ sequence: 4, phase: "scoring", message: "Promoted candidate r0001", updated_at: new Date().toISOString(), iteration: 1, benchmark: { current: "transfer", completed: 1, total: 1 }, champion: { revision: "r0001", passing: 1, total: 1, score: 0, worst_normalized_error: 0 } }))
console.log("champion checkpointed")
`,
    ),
    Bun.write(
      tsci_path,
      `#!/usr/bin/env bun
	import { appendFile, mkdir } from "node:fs/promises"
	const jobDir = ${JSON.stringify(job_dir)}
	const modelSource = await Bun.file(jobDir + "/spice/model.lib").text()
	const integrity = [
	  { type: "source_component", source_component_id: "dut", name: "DUT" },
	  { type: "source_port", source_port_id: "dut_in", source_component_id: "dut", name: "pin1" },
	  { type: "source_port", source_port_id: "dut_out", source_component_id: "dut", name: "pin2" },
	  { type: "simulation_spice_subcircuit", source_component_id: "dut", subcircuit_source: modelSource, spice_pin_to_source_port_map: { IN: "dut_in", OUT: "dut_out" } },
	  { type: "simulation_voltage_probe", name: "VOUT_PROBE", signal_input_source_port_id: "dut_out" },
	]
await appendFile(jobDir + "/tsci-calls.log", Bun.argv.slice(2).join(" ") + "\\n")
await mkdir(jobDir + "/dist/spice/benchmarks/transfer", { recursive: true })
await mkdir(jobDir + "/dist/spice/component-with-model", { recursive: true })
	await Bun.write(jobDir + "/dist/spice/benchmarks/transfer/circuit.json", JSON.stringify([...integrity, { type: "simulation_transient_voltage_graph", name: "VOUT_PROBE", timestamps_ms: [0, 1], voltage_levels: [0, 1] }]))
	await Bun.write(jobDir + "/dist/spice/component-with-model/circuit.json", JSON.stringify(integrity))
console.log("simulation ok")
`,
    ),
  ])
  await Promise.all([chmod(agent_path, 0o755), chmod(tsci_path, 0o755)])

  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_1", job_dir, file_name: "sensor.pdf" })
  job_store.updateJob("job_1", { display_status: "agent_running", is_complete: false })
  model_run_store.createModelRun({
    model_run_id: "model_1",
    job_id: "job_1",
    model_dir,
    effort_multiplier: 1,
    base_effort_ms: 10_000,
  })

  const waiting_for_component = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Model run did not wait for the component")), 3_000)
    const unsubscribe = model_run_store.subscribe("model_1", (event) => {
      if (event.event_type !== "log" && event.model_run.status === "waiting_for_component") {
        clearTimeout(timeout)
        unsubscribe?.()
        resolve()
      }
    })
  })
  const run_promise = runModel(
    { model_run_id: "model_1" },
    { job_store, model_run_store, agent_bin: agent_path, tsci_bin: tsci_path },
  )
  await waiting_for_component
  const waiting_run = model_run_store.getModelRun("model_1")
  expect(waiting_run?.elapsed_time_ms).toBe(0)
  expect(waiting_run?.segment_started_at).toBeUndefined()
  expect(waiting_run?.progress?.phase).toBe("waiting_for_component")
  expect(waiting_run?.progress?.evidence?.graphs_digitized).toBe(1)

  job_store.updateJob("job_1", { display_status: "complete", is_complete: true })
  await run_promise

  const model_run = model_run_store.getModelRun("model_1")
  expect(model_run?.status).toBe("complete")
  expect(model_run?.manifest?.entry_name).toBe("SENSOR")
  expect(model_run?.validation?.all_passed).toBe(true)
  expect(model_run?.iteration).toBe(1)
  expect(model_run?.model_source).toContain(".subckt SENSOR")
  expect(job_store.getJob("job_1")?.component_code).toContain("spicemodel")
  expect(job_store.getJob("job_1")?.component_code).toContain("const modelSource")
  expect(job_store.getJob("job_1")?.component_code).toContain("ComponentProps<typeof Component>")
  expect(job_store.getJob("job_1")?.component_code).not.toContain(".model D D")
  expect(await Bun.file(join(job_dir, "model.lib")).text()).toContain(".subckt SENSOR")
  expect(model_run?.progress?.phase).toBe("complete")
  expect(model_run?.progress?.champion?.passing).toBe(1)
  expect(model_run?.progress_history.some((event) => event.phase === "digitizing_graphs")).toBe(true)
  expect(model_run?.progress_history.some((event) => event.phase === "scoring")).toBe(true)
  const tsci_calls = await Bun.file(join(job_dir, "tsci-calls.log")).text()
  expect(tsci_calls).toContain("build benchmarks/transfer.circuit.tsx --ignore-warnings")
  expect(tsci_calls).not.toContain("simulate analog")
  expect(
    await Bun.file(join(job_dir, ".model-validation", "benchmarks", "transfer", "circuit.json")).exists(),
  ).toBe(true)
  expect(await Bun.file(join(job_dir, ".model-benchmark-lock", "lock.json")).exists()).toBe(true)
  expect(
    await Bun.file(
      join(job_dir, ".model-benchmark-lock", "snapshot", "benchmarks", "transfer.circuit.tsx"),
    ).text(),
  ).toBe(lockedBenchmarkSource)

  await rm(job_dir, { recursive: true, force: true })
}, 20_000)

test("model runner returns failed validation to the agent until the verified suite reaches 100%", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-correction-loop-"))
  const model_dir = join(job_dir, "spice")
  const agent_path = join(job_dir, "correction-agent")
  const tsci_path = join(job_dir, "correction-tsci")
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nfixture"),
    Bun.write(join(job_dir, "index.circuit.tsx"), 'export default () => <chip name="U1" />\n'),
    Bun.write(
      agent_path,
      `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const attemptFile = dir + "/agent-attempt.txt"
const previous = Number(await Bun.file(attemptFile).text().catch(() => "0"))
const attempt = previous + 1
await Bun.write(attemptFile, String(attempt))
if (attempt > 1 && await Bun.file(dir + "/validation-feedback.md").exists()) {
  await Bun.write(dir + "/feedback-seen.txt", "yes")
}
if (attempt > 1 && await Bun.file(dir + "/validation-artifacts/transfer/circuit.json").exists()) {
  await Bun.write(dir + "/simulation-artifact-seen.txt", "yes")
}
await mkdir(dir + "/benchmarks", { recursive: true })
await mkdir(dir + "/evidence/curves", { recursive: true })
await mkdir(dir + "/results/champion", { recursive: true })
await Bun.write(dir + "/model.lib", ".subckt LOOP IN OUT\\nR1 IN OUT 1k\\n.ends LOOP\\n")
await Bun.write(dir + "/model-manifest.json", JSON.stringify({ version: 1, part_number: "LOOP", dialect: "portable", entry_name: "LOOP", model_file: "model.lib", revision: "r000" + attempt, simulator: "ngspice", generated_at: new Date().toISOString(), pins: [{ component_pin: "pin1", spice_node: "IN" }, { component_pin: "pin2", spice_node: "OUT" }] }))
await Bun.write(dir + "/component-with-model.circuit.tsx", "export default () => <chip name=\\"U1\\" />\\n")
if (attempt === 1) {
  await Bun.write(dir + "/benchmarks/transfer.circuit.tsx", ${JSON.stringify(
    lockedBenchmarkSource.replaceAll("VOUT_PROBE", "VOUT"),
  )})
  await Bun.write(dir + "/benchmarks.json", JSON.stringify({ version: 1, locked_at: new Date().toISOString(), benchmarks: [{ id: "transfer", title: "Transfer", source: { page: 3 }, critical: true, weight: 1, tolerance: 0.05, reference_file: "evidence/curves/transfer.csv", result_file: "results/champion/transfer.csv", simulation: { kind: "transient_voltage", probe_name: "VOUT" } }] }))
  await Bun.write(dir + "/evidence/curves/transfer.csv", "x,y\\n0,0\\n1,1\\n")
}
await Bun.write(dir + "/results/champion/transfer.csv", "x,y\\n0,0\\n1," + (attempt === 1 ? "2" : "1") + "\\n")
await Bun.write(dir + "/iteration-history.json", JSON.stringify(Array.from({ length: attempt }, (_, index) => ({ revision: "r000" + (index + 1), decision: "promoted" }))))
await Bun.write(dir + "/model-card.md", "# LOOP model\\n")
`,
    ),
    Bun.write(
      tsci_path,
      `#!/usr/bin/env bun
	import { mkdir } from "node:fs/promises"
	const jobDir = ${JSON.stringify(job_dir)}
	const attempt = Number(await Bun.file(jobDir + "/spice/agent-attempt.txt").text())
	const modelSource = await Bun.file(jobDir + "/spice/model.lib").text()
	const integrity = [
	  { type: "source_component", source_component_id: "dut", name: "DUT" },
	  { type: "source_port", source_port_id: "dut_in", source_component_id: "dut", name: "pin1" },
	  { type: "source_port", source_port_id: "dut_out", source_component_id: "dut", name: "pin2" },
	  { type: "simulation_spice_subcircuit", source_component_id: "dut", subcircuit_source: modelSource, spice_pin_to_source_port_map: { IN: "dut_in", OUT: "dut_out" } },
	  { type: "simulation_voltage_probe", name: "VOUT", signal_input_source_port_id: "dut_out" },
	]
await mkdir(jobDir + "/dist/spice/benchmarks/transfer", { recursive: true })
await mkdir(jobDir + "/dist/spice/component-with-model", { recursive: true })
	await Bun.write(jobDir + "/dist/spice/benchmarks/transfer/circuit.json", JSON.stringify([...integrity, { type: "simulation_transient_voltage_graph", name: "VOUT", timestamps_ms: [0, 1], voltage_levels: [0, attempt === 1 ? 2 : 1] }]))
	await Bun.write(jobDir + "/dist/spice/component-with-model/circuit.json", JSON.stringify(integrity))
`,
    ),
  ])
  await Promise.all([chmod(agent_path, 0o755), chmod(tsci_path, 0o755)])

  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_loop", job_dir, file_name: "loop.pdf" })
  job_store.updateJob("job_loop", { display_status: "complete", is_complete: true })
  model_run_store.createModelRun({
    model_run_id: "model_loop",
    job_id: "job_loop",
    model_dir,
    effort_multiplier: 1,
    base_effort_ms: 8_000,
  })
  await Bun.write(join(model_dir, "setup-complete.json"), JSON.stringify({ version: 1 }))

  await runModel(
    { model_run_id: "model_loop" },
    { job_store, model_run_store, agent_bin: agent_path, tsci_bin: tsci_path },
  )

  const model_run = model_run_store.getModelRun("model_loop")
  expect(model_run?.status).toBe("complete")
  expect(model_run?.validation?.passing_count).toBe(1)
  expect(await Bun.file(join(model_dir, "agent-attempt.txt")).text()).toBe("2")
  expect(model_run?.logs.some((log) => log.message.includes("correction pass 2"))).toBe(true)
  expect(await Bun.file(join(model_dir, "feedback-seen.txt")).text()).toBe("yes")
  expect(await Bun.file(join(model_dir, "simulation-artifact-seen.txt")).text()).toBe("yes")
  expect(await Bun.file(join(model_dir, "validation-feedback.md")).exists()).toBe(false)

  await rm(job_dir, { recursive: true, force: true })
}, 20_000)

test("model runner recovers the latest promoted model when the effort deadline interrupts the agent", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-recovery-"))
  const model_dir = join(job_dir, "spice")
  const agent_path = join(job_dir, "checkpoint-agent")
  const tsci_path = join(job_dir, "fake-tsci")
  await Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nfixture")
  await Bun.write(join(job_dir, "index.circuit.tsx"), 'export default () => <chip name="U1" />\n')
  await Bun.write(
    agent_path,
    `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
await mkdir(dir + "/candidates/r0001", { recursive: true })
await Bun.write(dir + "/candidates/r0001/model.lib", ".subckt RECOVERED IN OUT\\nR1 IN OUT 1k\\n.ends RECOVERED\\n")
await Bun.write(dir + "/iteration-history.json", JSON.stringify([{ revision: "r0001", decision: "promoted" }]))
await Bun.sleep(30_000)
`,
  )
  await Bun.write(tsci_path, "#!/usr/bin/env bun\n")
  await Promise.all([chmod(agent_path, 0o755), chmod(tsci_path, 0o755)])

  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_recovery", job_dir, file_name: "sensor.pdf" })
  job_store.updateJob("job_recovery", { display_status: "complete", is_complete: true })
  model_run_store.createModelRun({
    model_run_id: "model_recovery",
    job_id: "job_recovery",
    model_dir,
    effort_multiplier: 1,
    base_effort_ms: 1_000,
  })
  await Bun.write(join(model_dir, "setup-complete.json"), JSON.stringify({ version: 1 }))

  await runModel(
    { model_run_id: "model_recovery" },
    { job_store, model_run_store, agent_bin: agent_path, tsci_bin: tsci_path },
  )

  const recovered_run = model_run_store.getModelRun("model_recovery")
  expect(recovered_run?.status).toBe("timed_out")
  expect(recovered_run?.model_source).toContain(".subckt RECOVERED")
  expect(await Bun.file(join(model_dir, "model.lib")).text()).toContain(".subckt RECOVERED")
  expect(recovered_run?.elapsed_time_ms).toBeLessThan(1_000)
  expect(recovered_run?.error_message).toContain("validation reserve")

  await rm(job_dir, { recursive: true, force: true })
}, 10_000)

test("model runner builds parameter-sweep points concurrently in isolated workspaces", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-sweep-runner-"))
  const model_dir = join(job_dir, "spice")
  const agent_path = join(job_dir, "sweep-agent")
  const tsci_path = join(job_dir, "sweep-tsci")
  const sweep_source = `import Component from "../component-with-model.circuit"

export default function SweepBenchmark({ sweepValue = 0 }: { sweepValue?: number }) {
  return (
    <board routingDisabled>
      <Component name="DUT" />
      <resistor name="RLOAD" resistance={sweepValue + 1} connectsTo={{ pin1: "DUT.pin2", pin2: "net.GND" }} />
      <voltageprobe name="VOUT" connectsTo="DUT.pin2" />
      <analogsimulation duration="1ms" timePerStep="0.1ms" spiceEngine="ngspice" />
    </board>
  )
}
`
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nsweep fixture"),
    Bun.write(join(job_dir, "index.circuit.tsx"), 'export default () => <chip name="U1" />\n'),
    Bun.write(
      agent_path,
      `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
await mkdir(dir + "/benchmarks", { recursive: true })
await mkdir(dir + "/evidence/curves", { recursive: true })
await Bun.write(dir + "/model.lib", ".subckt SWEEP IN OUT\\nR1 IN OUT 1k\\n.ends SWEEP\\n")
await Bun.write(dir + "/model-manifest.json", JSON.stringify({ version: 1, part_number: "SWEEP", dialect: "portable", entry_name: "SWEEP", model_file: "model.lib", revision: "r0001", simulator: "ngspice", generated_at: new Date().toISOString(), pins: [{ component_pin: "pin1", spice_node: "IN" }, { component_pin: "pin2", spice_node: "OUT" }] }))
await Bun.write(dir + "/component-with-model.circuit.tsx", "export default () => <chip name=\\"untrusted\\" />\\n")
await Bun.write(dir + "/benchmarks/sweep.circuit.tsx", ${JSON.stringify(sweep_source)})
await Bun.write(dir + "/benchmarks.json", JSON.stringify({ version: 1, locked_at: new Date().toISOString(), benchmarks: [{ id: "sweep", title: "Sweep", source: { page: 2 }, critical: true, weight: 1, tolerance: 0.01, reference_file: "evidence/curves/sweep.csv", result_file: "results/champion/sweep.csv", simulation: { kind: "parameter_sweep", probe_name: "VOUT", reducer: "last", points: [{ x: 0, props: { sweepValue: 0 } }, { x: 1, props: { sweepValue: 1 } }] } }] }))
await Bun.write(dir + "/evidence/curves/sweep.csv", "x,y\\n0,0\\n1,2\\n")
await Bun.write(dir + "/iteration-history.json", JSON.stringify([{ revision: "r0001", decision: "promoted" }]))
await Bun.write(dir + "/model-card.md", "# SWEEP model\\n")
`,
    ),
    Bun.write(
      tsci_path,
      `#!/usr/bin/env bun
import { appendFile, mkdir } from "node:fs/promises"
const jobDir = ${JSON.stringify(job_dir)}
const args = Bun.argv.slice(2)
const target = args[1] ?? ""
const modelSource = await Bun.file(jobDir + "/spice/model.lib").text()
const integrity = [
  { type: "source_component", source_component_id: "dut", name: "DUT" },
  { type: "source_port", source_port_id: "dut_in", source_component_id: "dut", name: "pin1" },
  { type: "source_port", source_port_id: "dut_out", source_component_id: "dut", name: "pin2" },
  { type: "simulation_spice_subcircuit", source_component_id: "dut", subcircuit_source: modelSource, spice_pin_to_source_port_map: { IN: "dut_in", OUT: "dut_out" } },
  { type: "simulation_voltage_probe", name: "VOUT", signal_input_source_port_id: "dut_out" },
]
if (target === "component-with-model.circuit.tsx") {
  await mkdir(jobDir + "/dist/spice/component-with-model", { recursive: true })
  await Bun.write(jobDir + "/dist/spice/component-with-model/circuit.json", JSON.stringify(integrity))
  process.exit(0)
}
const match = target.match(/\\.server-validation-builds\\/sweep\\/(point-\\d+)\\.circuit\\.tsx$/)
if (!match) process.exit(2)
const runId = match[1]
const startedAt = Date.now()
await appendFile(jobDir + "/sweep-timing.log", runId + ",start," + startedAt + "\\n")
await Bun.sleep(150)
const value = runId === "point-000" ? 0 : 2
await mkdir(jobDir + "/dist/spice/.server-validation-builds/sweep/" + runId, { recursive: true })
await Bun.write(jobDir + "/dist/spice/.server-validation-builds/sweep/" + runId + "/circuit.json", JSON.stringify([...integrity, { type: "simulation_transient_voltage_graph", name: "VOUT", timestamps_ms: [0, 1], voltage_levels: [0, value] }]))
await appendFile(jobDir + "/sweep-timing.log", runId + ",end," + Date.now() + "\\n")
`,
    ),
  ])
  await Promise.all([chmod(agent_path, 0o755), chmod(tsci_path, 0o755)])

  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_sweep", job_dir, file_name: "sweep.pdf" })
  job_store.updateJob("job_sweep", { display_status: "complete", is_complete: true })
  model_run_store.createModelRun({
    model_run_id: "model_sweep",
    job_id: "job_sweep",
    model_dir,
    effort_multiplier: 1,
    base_effort_ms: 10_000,
  })
  await Bun.write(join(model_dir, "setup-complete.json"), JSON.stringify({ version: 1 }))

  await runModel(
    { model_run_id: "model_sweep" },
    { job_store, model_run_store, agent_bin: agent_path, tsci_bin: tsci_path },
  )

  expect(model_run_store.getModelRun("model_sweep")?.status).toBe("complete")
  expect(await Bun.file(join(model_dir, "results", "verified", "sweep.csv")).text()).toBe("x,y\n0,0\n1,2\n")
  const timing = (await Bun.file(join(job_dir, "sweep-timing.log")).text())
    .trim()
    .split("\n")
    .map((line) => line.split(","))
  const starts = timing.filter((entry) => entry[1] === "start").map((entry) => Number(entry[2]))
  const ends = timing.filter((entry) => entry[1] === "end").map((entry) => Number(entry[2]))
  expect(starts).toHaveLength(2)
  expect(ends).toHaveLength(2)
  expect(Math.max(...starts)).toBeLessThan(Math.min(...ends))

  await rm(job_dir, { recursive: true, force: true })
}, 20_000)
