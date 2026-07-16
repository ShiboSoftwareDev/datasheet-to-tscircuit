import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JobStore } from "@/server/job-store"
import {
  buildModelAgentPrompt,
  buildModelBenchmarkPrompt,
  buildModelSetupPrompt,
} from "@/server/model-scaffold"
import {
  parseModelManifest,
  preflightNgspice,
  runModel,
  stripAnalogSimulationForStructuralCheck,
  validateManifestAgainstModel,
} from "@/server/model-runner"
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

const provisionalBenchmarkBuildSource = `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
const target = Bun.argv.slice(2)[1] ?? ""
if (target === "server-ngspice-preflight.circuit.tsx") {
  const output = process.cwd() + "/../dist/spice/server-ngspice-preflight"
  await mkdir(output, { recursive: true })
  await Bun.write(output + "/circuit.json", JSON.stringify([{ type: "simulation_transient_voltage_graph", name: "RESULT", timestamps_ms: [0, 0.01], voltage_levels: [1, 1] }]))
  process.exit(0)
}
const benchmarkId = target.split("/").at(-1)?.replace(/\\.circuit\\.tsx$/, "")
if (!benchmarkId) process.exit(2)
const output = process.cwd() + "/../dist/spice/benchmarks/" + benchmarkId
await mkdir(output, { recursive: true })
await Bun.write(output + "/circuit.json", "[]")
`

test("model prompt keeps benchmarks fixed while effort only extends iteration time", () => {
  const prompt = buildModelAgentPrompt()
  expect(prompt).toContain("already locked")
  expect(prompt).toContain("refinement timer is running")
  expect(prompt).toContain("Re-read run-control.json")
  expect(prompt).toContain("do not reduce tests or loosen tolerances")
  expect(prompt).toContain("100% validation")
  expect(prompt).toContain("tsci build benchmarks/<benchmark-id>.circuit.tsx --ignore-warnings")
  expect(prompt).toContain("UI only reads")
  expect(prompt).toContain("validation-artifacts")
  expect(prompt).toContain("complete time-domain simulation")
  expect(prompt).not.toContain(".SUBCKT or .MODEL")
  const setup_prompt = buildModelSetupPrompt()
  expect(setup_prompt).toContain("untimed evidence")
  expect(setup_prompt).toContain("Do not guess the final pin mapping")
  expect(setup_prompt).toContain("setup-complete.json")
  expect(setup_prompt).toContain("model-progress.json")
  expect(setup_prompt).toContain("time in milliseconds as x")
  const benchmark_prompt = buildModelBenchmarkPrompt()
  expect(benchmark_prompt).toContain("benchmark-only pass")
  expect(benchmark_prompt).toContain("dut_spice_node")
  expect(benchmark_prompt).toContain('simulation.x_axis \`"time_ms"\`')
  expect(benchmark_prompt).toContain("Do not create or modify model.lib")
  const corrected_benchmark_prompt = buildModelBenchmarkPrompt(
    "Benchmark transfer voltage probe RESULT must connect directly to a DUT port",
  )
  expect(corrected_benchmark_prompt).toContain("server-benchmark-validation-feedback")
  expect(corrected_benchmark_prompt).toContain("must connect directly to a DUT port")
  expect(corrected_benchmark_prompt).toContain("Do not weaken, remove, or replace benchmarks")
})

test("model manifests cannot claim an unexecuted simulator", () => {
  expect(() =>
    parseModelManifest({
      version: 1,
      part_number: "PART",
      dialect: "pspice",
      entry_name: "PART",
      model_file: "model.lib",
      revision: "r0001",
      simulator: "PSpice",
      generated_at: new Date().toISOString(),
      pins: [{ component_pin: "pin1", spice_node: "IN" }],
    }),
  ).toThrow('simulator must be "ngspice"')
})

test("benchmark prelock rejects invalid analogsimulation props before stripping simulation", () => {
  expect(() =>
    stripAnalogSimulationForStructuralCheck(
      '<board><analogsimulation simulationType="transient" spiceEngine="ngspice" /></board>',
      "invalid.circuit.tsx",
    ),
  ).toThrow('simulationType must be "spice_transient_analysis" or omitted')
  expect(() =>
    stripAnalogSimulationForStructuralCheck(
      '<board><analogsimulation simulationType="spice_transient_analysis" spiceEngine="ngspice" /></board>',
      "valid.circuit.tsx",
    ),
  ).not.toThrow()
})

test("ngspice preflight fails on an empty engine map and passes after the engine is available", async () => {
  const tmp_root = join(process.cwd(), "tmp")
  await mkdir(tmp_root, { recursive: true })
  const job_dir = await mkdtemp(join(tmp_root, "ngspice-preflight-"))
  const model_dir = join(job_dir, "spice")
  const tsci_path = join(job_dir, "fake-tsci")
  await mkdir(model_dir, { recursive: true })
  await Bun.write(
    tsci_path,
    `#!/usr/bin/env bun
console.error('SPICE engine "ngspice" not found in platform config. Available engines: []')
process.exit(1)
`,
  )
  await chmod(tsci_path, 0o755)
  const controller = new AbortController()
  await expect(
    preflightNgspice({
      job_dir,
      model_dir,
      signal: controller.signal,
      tsci_bin: tsci_path,
      append: async () => undefined,
    }),
  ).rejects.toThrow('SPICE engine "ngspice" not found')

  await Bun.write(
    tsci_path,
    `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
const output = ${JSON.stringify(job_dir)} + "/dist/spice/server-ngspice-preflight"
await mkdir(output, { recursive: true })
await Bun.write(output + "/circuit.json", JSON.stringify([{ type: "simulation_transient_voltage_graph", name: "RESULT", timestamps_ms: [0, 0.01], voltage_levels: [1, 1] }]))
`,
  )
  expect(
    await preflightNgspice({
      job_dir,
      model_dir,
      signal: controller.signal,
      tsci_bin: tsci_path,
      append: async () => undefined,
    }),
  ).toBeGreaterThanOrEqual(0)
  await rm(job_dir, { recursive: true, force: true })
})

test("ngspice preflight uses a real component port that the tscircuit probe renderer can resolve", async () => {
  const tmp_root = join(process.cwd(), "tmp")
  await mkdir(tmp_root, { recursive: true })
  const job_dir = await mkdtemp(join(tmp_root, "ngspice-real-preflight-"))
  const model_dir = join(job_dir, "spice")
  await Promise.all([
    mkdir(model_dir, { recursive: true }),
    Bun.write(
      join(job_dir, "package.json"),
      '{"name":"ngspice-real-preflight","private":true,"type":"module"}\n',
    ),
    Bun.write(
      join(job_dir, "tscircuit.config.ts"),
      `import { createNgspiceSpiceEngine } from "@tscircuit/ngspice-spice-engine"

const ngspiceSpiceEngine = await createNgspiceSpiceEngine()

export default { platformConfig: { spiceEngineMap: { ngspice: ngspiceSpiceEngine } } }
`,
    ),
  ])
  const messages: string[] = []
  try {
    expect(
      await preflightNgspice({
        job_dir,
        model_dir,
        signal: new AbortController().signal,
        tsci_bin: join(process.cwd(), "node_modules", ".bin", "tsci"),
        append: async (_stream, message) => {
          messages.push(message)
        },
      }),
    ).toBeGreaterThanOrEqual(0)
    expect(messages.join("\n")).toContain("ngspice preflight passed")
    expect(messages.join("\n")).not.toContain("Could not identify connected source for VoltageProbe")
  } finally {
    await rm(job_dir, { recursive: true, force: true })
  }
}, 30_000)

test("model manifests must select the first SUBCKT with exact pin names", () => {
  const manifest = parseModelManifest({
    version: 1,
    part_number: "PART",
    dialect: "portable",
    entry_name: "PART",
    model_file: "model.lib",
    revision: "r0001",
    simulator: "ngspice",
    generated_at: new Date().toISOString(),
    pins: [
      { component_pin: "pin1", spice_node: "IN" },
      { component_pin: "pin2", spice_node: "OUT" },
    ],
  })
  expect(() =>
    validateManifestAgainstModel(
      manifest,
      ".subckt HELPER IN OUT\n.ends HELPER\n.subckt PART IN OUT\n.ends PART\n",
    ),
  ).toThrow("must match the first")
  expect(() => validateManifestAgainstModel(manifest, ".model PART D\n")).toThrow("must match the first")
  expect(() => validateManifestAgainstModel(manifest, ".subckt PART in OUT\n.ends PART\n")).toThrow(
    "matching case",
  )
})

test("benchmark finalization cannot create model artifacts before the server lock", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-prelock-"))
  const model_dir = join(job_dir, "spice")
  const agent_path = join(job_dir, "prelock-agent")
  const tsci_path = join(job_dir, "unused-tsci")
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nfixture"),
    Bun.write(join(job_dir, "index.circuit.tsx"), 'export default () => <chip name="U1" />\n'),
    Bun.write(
      agent_path,
      `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
await mkdir(dir + "/benchmarks", { recursive: true })
await mkdir(dir + "/evidence/curves", { recursive: true })
await Bun.write(dir + "/benchmarks/transfer.circuit.tsx", ${JSON.stringify(lockedBenchmarkSource)})
await Bun.write(dir + "/benchmarks.json", JSON.stringify({ version: 1, locked_at: new Date().toISOString(), benchmarks: [{ id: "transfer", title: "Transfer", source: { page: 3 }, critical: true, weight: 1, tolerance: 0.05, reference_file: "evidence/curves/transfer.csv", result_file: "results/champion/transfer.csv", simulation: { kind: "transient_voltage", x_axis: "time_ms", probe_name: "VOUT_PROBE", dut_spice_node: "OUT" } }] }))
await Bun.write(dir + "/evidence/curves/transfer.csv", "x,y\\n0,0\\n1,1\\n")
await Bun.write(dir + "/model.lib", ".subckt TOO_EARLY IN OUT\\nR1 IN OUT 1k\\n.ends TOO_EARLY\\n")
`,
    ),
    Bun.write(tsci_path, provisionalBenchmarkBuildSource),
  ])
  await Promise.all([chmod(agent_path, 0o755), chmod(tsci_path, 0o755)])
  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_prelock", job_dir, file_name: "part.pdf" })
  job_store.updateJob("job_prelock", { display_status: "complete", is_complete: true })
  model_run_store.createModelRun({
    model_run_id: "model_prelock",
    job_id: "job_prelock",
    model_dir,
    effort_multiplier: 1,
    base_effort_ms: 2_000,
  })
  await Bun.write(join(model_dir, "setup-complete.json"), JSON.stringify({ version: 1 }))

  await runModel(
    { model_run_id: "model_prelock" },
    { job_store, model_run_store, agent_bin: agent_path, tsci_bin: tsci_path },
  )

  const run = model_run_store.getModelRun("model_prelock")
  expect(run?.status).toBe("failed")
  expect(run?.elapsed_time_ms).toBe(0)
  expect(run?.error_message).toContain("forbidden model artifacts")
  expect(await Bun.file(join(job_dir, ".model-benchmark-lock", "lock.json")).exists()).toBe(false)
  await rm(job_dir, { recursive: true, force: true })
})

test("retry reruns benchmark finalization instead of locking partial output", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-benchmark-retry-"))
  const model_dir = join(job_dir, "spice")
  const agent_path = join(job_dir, "partial-benchmark-agent")
  const tsci_path = join(job_dir, "unused-tsci")
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nfixture"),
    Bun.write(join(job_dir, "index.circuit.tsx"), 'export default () => <chip name="U1" />\n'),
    Bun.write(
      agent_path,
      `#!/usr/bin/env bun
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
if (!prompt.includes("benchmark-only pass")) process.exit(20)
const attemptFile = dir + "/../benchmark-attempt.txt"
const attempt = Number(await Bun.file(attemptFile).text().catch(() => "0")) + 1
await Bun.write(attemptFile, String(attempt))
if (attempt === 1) {
  await Bun.write(dir + "/benchmarks/transfer.circuit.tsx", ${JSON.stringify(lockedBenchmarkSource)})
  await Bun.write(dir + "/evidence/curves/transfer.csv", "x,y\\n0,0\\n1,1\\n")
  await Bun.write(dir + "/benchmarks.json", JSON.stringify({ version: 1, locked_at: new Date().toISOString(), benchmarks: [{ id: "transfer", title: "Partial transfer", source: { page: 3 }, critical: true, weight: 1, tolerance: 0.05, reference_file: "evidence/curves/transfer.csv", result_file: "results/champion/transfer.csv", simulation: { kind: "transient_voltage", x_axis: "time_ms", probe_name: "VOUT_PROBE", dut_spice_node: "OUT" } }] }))
  process.exit(7)
}
process.exit(8)
`,
    ),
    Bun.write(tsci_path, provisionalBenchmarkBuildSource),
  ])
  await Promise.all([chmod(agent_path, 0o755), chmod(tsci_path, 0o755)])
  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_benchmark_retry", job_dir, file_name: "part.pdf" })
  job_store.updateJob("job_benchmark_retry", { display_status: "complete", is_complete: true })
  model_run_store.createModelRun({
    model_run_id: "model_benchmark_retry",
    job_id: "job_benchmark_retry",
    model_dir,
    effort_multiplier: 1,
    base_effort_ms: 2_000,
  })
  await Bun.write(join(model_dir, "setup-complete.json"), JSON.stringify({ version: 1 }))

  const context = { job_store, model_run_store, agent_bin: agent_path, tsci_bin: tsci_path }
  await runModel({ model_run_id: "model_benchmark_retry" }, context)
  expect(model_run_store.getModelRun("model_benchmark_retry")?.error_message).toContain("code 7")
  expect(model_run_store.retryModelRun("model_benchmark_retry")).toBe("retried")
  await runModel({ model_run_id: "model_benchmark_retry" }, context)

  expect(await Bun.file(join(job_dir, "benchmark-attempt.txt")).text()).toBe("2")
  expect(model_run_store.getModelRun("model_benchmark_retry")?.error_message).toContain("code 8")
  expect(await Bun.file(join(job_dir, ".model-benchmark-lock", "lock.json")).exists()).toBe(false)
  await rm(job_dir, { recursive: true, force: true })
})

test("benchmark contract rejections are returned to the untimed finalization agent", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-benchmark-correction-"))
  const model_dir = join(job_dir, "spice")
  const agent_path = join(job_dir, "benchmark-correction-agent")
  const tsci_path = join(job_dir, "unused-tsci")
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nfixture"),
    Bun.write(join(job_dir, "index.circuit.tsx"), 'export default () => <chip name="U1" />\n'),
    Bun.write(
      agent_path,
      `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
if (!prompt.includes("benchmark-only pass")) process.exit(9)
const attemptFile = dir + "/../benchmark-correction-attempt.txt"
const attempt = Number(await Bun.file(attemptFile).text().catch(() => "0")) + 1
await Bun.write(attemptFile, String(attempt))
if (attempt === 2 && prompt.includes("must connect directly to a DUT port")) {
  await Bun.write(dir + "/../benchmark-feedback-seen.txt", "yes")
}
await mkdir(dir + "/benchmarks", { recursive: true })
await mkdir(dir + "/evidence/curves", { recursive: true })
const validSource = ${JSON.stringify(lockedBenchmarkSource)}
await Bun.write(dir + "/benchmarks/transfer.circuit.tsx", attempt === 1 ? validSource.replace('connectsTo="DUT.pin2"', 'connectsTo="net.OUT"') : validSource)
await Bun.write(dir + "/benchmarks.json", JSON.stringify({ version: 1, locked_at: new Date().toISOString(), benchmarks: [{ id: "transfer", title: "Transfer", source: { page: 3 }, critical: true, weight: 1, tolerance: 0.05, reference_file: "evidence/curves/transfer.csv", result_file: "results/champion/transfer.csv", simulation: { kind: "transient_voltage", x_axis: "time_ms", probe_name: "VOUT_PROBE", dut_spice_node: "OUT" } }] }))
await Bun.write(dir + "/evidence/curves/transfer.csv", "x,y\\n0,0\\n1,1\\n")
`,
    ),
    Bun.write(tsci_path, provisionalBenchmarkBuildSource),
  ])
  await Promise.all([chmod(agent_path, 0o755), chmod(tsci_path, 0o755)])

  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_benchmark_correction", job_dir, file_name: "part.pdf" })
  job_store.updateJob("job_benchmark_correction", { display_status: "complete", is_complete: true })
  model_run_store.createModelRun({
    model_run_id: "model_benchmark_correction",
    job_id: "job_benchmark_correction",
    model_dir,
    effort_multiplier: 1,
    base_effort_ms: 2_000,
  })
  await Bun.write(join(model_dir, "setup-complete.json"), JSON.stringify({ version: 1 }))

  await runModel(
    { model_run_id: "model_benchmark_correction" },
    { job_store, model_run_store, agent_bin: agent_path, tsci_bin: tsci_path },
  )

  expect(await Bun.file(join(job_dir, "benchmark-correction-attempt.txt")).text()).toBe("2")
  expect(await Bun.file(join(job_dir, "benchmark-feedback-seen.txt")).text()).toBe("yes")
  expect(await Bun.file(join(job_dir, ".model-benchmark-lock", "lock.json")).exists()).toBe(true)
  expect(
    model_run_store
      .getModelRun("model_benchmark_correction")
      ?.logs.some((log) => log.message.includes("Returning the exact validation error")),
  ).toBe(true)
  await rm(job_dir, { recursive: true, force: true })
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
if (prompt.includes("benchmark-only pass")) {
  await Bun.write(dir + "/benchmarks/transfer.circuit.tsx", ${JSON.stringify(lockedBenchmarkSource)})
  await Bun.write(dir + "/benchmarks.json", JSON.stringify({ version: 1, locked_at: new Date().toISOString(), benchmarks: [{ id: "transfer", title: "Transfer", source: { page: 3 }, critical: true, weight: 1, tolerance: 0.05, reference_file: "evidence/curves/transfer.csv", result_file: "results/champion/transfer.csv", simulation: { kind: "transient_voltage", x_axis: "time_ms", probe_name: "VOUT_PROBE", dut_spice_node: "OUT" } }] }))
  await Bun.write(dir + "/evidence/curves/transfer.csv", "x,y\\n0,0\\n1,1\\n")
  await Bun.write(dir + "/model-progress.json", JSON.stringify({ sequence: 3, phase: "locking_benchmarks", message: "Finalized transfer benchmark", updated_at: new Date().toISOString(), iteration: 0, benchmark: { current: "transfer", completed: 1, total: 1 } }))
  console.log("benchmarks finalized")
  process.exit(0)
}
if (!(await Bun.file(dir + "/../.model-benchmark-lock/lock.json").exists())) {
  throw new Error("refinement started before the server benchmark lock")
}
await Bun.write(dir + "/model.lib", ".subckt SENSOR IN OUT\\nR1 IN OUT 1k\\n.ends SENSOR\\n")
await Bun.write(dir + "/model-manifest.json", JSON.stringify({ version: 1, part_number: "SENSOR", dialect: "portable", entry_name: "SENSOR", model_file: "model.lib", revision: "r0001", simulator: "ngspice", generated_at: new Date().toISOString(), pins: [{ component_pin: "pin1", spice_node: "IN" }, { component_pin: "pin2", spice_node: "OUT" }] }))
await Bun.write(dir + "/component-with-model.circuit.tsx", "export default () => <chip name=\\"U1\\" footprint=\\"soic8\\" spiceModel={<spicemodel source={\\".model D D\\"} spicePinMapping={{ D: \\"pin1\\" }} />} />\\n")
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
	const target = Bun.argv.slice(2)[1] ?? ""
	if (target === "server-ngspice-preflight.circuit.tsx") {
	  const output = jobDir + "/dist/spice/server-ngspice-preflight"
	  await mkdir(output, { recursive: true })
	  await Bun.write(output + "/circuit.json", JSON.stringify([{ type: "simulation_transient_voltage_graph", name: "RESULT", timestamps_ms: [0, 0.01], voltage_levels: [1, 1] }]))
	  process.exit(0)
	}
		if (!(await Bun.file(jobDir + "/spice/model.lib").exists())) {
		  await mkdir(jobDir + "/dist/spice/benchmarks/transfer", { recursive: true })
		  await Bun.write(jobDir + "/dist/spice/benchmarks/transfer/circuit.json", "[]")
		  process.exit(0)
		}
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
  expect(tsci_calls).toContain("--disable-pcb")
  expect(tsci_calls).toContain("--routing-disabled")
  expect(tsci_calls).toContain("--disable-parts-engine")
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

  const extension = model_run_store.extendModelRun("model_1", 1)
  expect(extension.should_start).toBe(true)
  await runModel(
    { model_run_id: "model_1" },
    { job_store, model_run_store, agent_bin: agent_path, tsci_bin: tsci_path },
  )
  expect(model_run_store.getModelRun("model_1")?.status).toBe("complete")
  const restored_component = await Bun.file(join(model_dir, "component.circuit.tsx")).text()
  expect(restored_component).toContain('<chip name="U1" footprint="soic8" />')
  expect(restored_component).not.toContain('import Component from "./component.circuit"')

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
const prompt = args[args.indexOf("--prompt") + 1]
if (prompt.includes("benchmark-only pass")) {
  await mkdir(dir + "/benchmarks", { recursive: true })
  await mkdir(dir + "/evidence/curves", { recursive: true })
  await Bun.write(dir + "/benchmarks/transfer.circuit.tsx", ${JSON.stringify(
    lockedBenchmarkSource.replaceAll("VOUT_PROBE", "VOUT"),
  )})
  await Bun.write(dir + "/benchmarks.json", JSON.stringify({ version: 1, locked_at: new Date().toISOString(), benchmarks: [{ id: "transfer", title: "Transfer", source: { page: 3 }, critical: true, weight: 1, tolerance: 0.05, reference_file: "evidence/curves/transfer.csv", result_file: "results/champion/transfer.csv", simulation: { kind: "transient_voltage", x_axis: "time_ms", probe_name: "VOUT", dut_spice_node: "OUT" } }] }))
  await Bun.write(dir + "/evidence/curves/transfer.csv", "x,y\\n0,0\\n1,1\\n")
  process.exit(0)
}
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
	const target = Bun.argv.slice(2)[1] ?? ""
	if (target === "server-ngspice-preflight.circuit.tsx") {
	  const output = jobDir + "/dist/spice/server-ngspice-preflight"
	  await mkdir(output, { recursive: true })
	  await Bun.write(output + "/circuit.json", JSON.stringify([{ type: "simulation_transient_voltage_graph", name: "RESULT", timestamps_ms: [0, 0.01], voltage_levels: [1, 1] }]))
	  process.exit(0)
	}
		if (!(await Bun.file(jobDir + "/spice/model.lib").exists())) {
		  await mkdir(jobDir + "/dist/spice/benchmarks/transfer", { recursive: true })
		  await Bun.write(jobDir + "/dist/spice/benchmarks/transfer/circuit.json", "[]")
		  process.exit(0)
		}
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

test("structural validation defects create a new lock generation and restart refinement", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-lock-recovery-"))
  const model_dir = join(job_dir, "spice")
  const agent_path = join(job_dir, "lock-recovery-agent")
  const tsci_path = join(job_dir, "lock-recovery-tsci")
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nfixture"),
    Bun.write(join(job_dir, "index.circuit.tsx"), 'export default () => <chip name="U1" />\n'),
    Bun.write(
      agent_path,
      `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
if (prompt.includes("benchmark-only pass")) {
  const attemptFile = dir + "/../lock-recovery-benchmark-attempt.txt"
  const attempt = Number(await Bun.file(attemptFile).text().catch(() => "0")) + 1
  await Bun.write(attemptFile, String(attempt))
  await mkdir(dir + "/benchmarks", { recursive: true })
  await mkdir(dir + "/evidence/curves", { recursive: true })
  if (prompt.includes("structural circuit defect")) {
    const source = await Bun.file(dir + "/benchmarks/transfer.circuit.tsx").text()
    await Bun.write(dir + "/benchmarks/transfer.circuit.tsx", source + "\\n// Repaired harness.\\n")
    await Bun.write(dir + "/../lock-recovery-prompt-seen.txt", "yes")
  } else {
    await Bun.write(dir + "/benchmarks/transfer.circuit.tsx", ${JSON.stringify(lockedBenchmarkSource)})
    await Bun.write(dir + "/benchmarks.json", JSON.stringify({ version: 1, locked_at: "2026-07-16T00:00:00.000Z", benchmarks: [{ id: "transfer", title: "Transfer", source: { page: 3 }, critical: true, weight: 1, tolerance: 0.05, reference_file: "evidence/curves/transfer.csv", result_file: "results/champion/transfer.csv", simulation: { kind: "transient_voltage", x_axis: "time_ms", probe_name: "VOUT_PROBE", dut_spice_node: "OUT" } }] }))
    await Bun.write(dir + "/evidence/curves/transfer.csv", "x,y\\n0,0\\n1,1\\n")
  }
  process.exit(0)
}
const attemptFile = dir + "/../lock-recovery-refinement-attempt.txt"
const attempt = Number(await Bun.file(attemptFile).text().catch(() => "0")) + 1
await Bun.write(attemptFile, String(attempt))
await mkdir(dir + "/results/champion", { recursive: true })
await Bun.write(dir + "/model.lib", ".subckt RECOVERY IN OUT\\nR1 IN OUT 1k\\n.ends RECOVERY\\n")
await Bun.write(dir + "/model-manifest.json", JSON.stringify({ version: 1, part_number: "RECOVERY", dialect: "portable", entry_name: "RECOVERY", model_file: "model.lib", revision: "r000" + attempt, simulator: "ngspice", generated_at: new Date().toISOString(), pins: [{ component_pin: "pin1", spice_node: "IN" }, { component_pin: "pin2", spice_node: "OUT" }] }))
await Bun.write(dir + "/component-with-model.circuit.tsx", "export default () => <chip name=\\"DUT\\" />\\n")
await Bun.write(dir + "/results/champion/transfer.csv", "x,y\\n0,0\\n1,1\\n")
await Bun.write(dir + "/iteration-history.json", JSON.stringify([{ revision: "r000" + attempt, decision: "promoted" }]))
await Bun.write(dir + "/model-card.md", "# RECOVERY model\\n")
`,
    ),
    Bun.write(
      tsci_path,
      `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
const jobDir = ${JSON.stringify(job_dir)}
const target = Bun.argv.slice(2)[1] ?? ""
if (target === "server-ngspice-preflight.circuit.tsx") {
  const output = jobDir + "/dist/spice/server-ngspice-preflight"
  await mkdir(output, { recursive: true })
  await Bun.write(output + "/circuit.json", JSON.stringify([{ type: "simulation_transient_voltage_graph", name: "RESULT", timestamps_ms: [0, 0.01], voltage_levels: [1, 1] }]))
  process.exit(0)
}
const benchmarkOutput = jobDir + "/dist/spice/benchmarks/transfer"
if (!(await Bun.file(jobDir + "/spice/model.lib").exists())) {
  await mkdir(benchmarkOutput, { recursive: true })
  await Bun.write(benchmarkOutput + "/circuit.json", "[]")
  process.exit(0)
}
const modelSource = await Bun.file(jobDir + "/spice/model.lib").text()
const integrity = [
  { type: "source_component", source_component_id: "dut", name: "DUT" },
  { type: "source_port", source_port_id: "dut_in", source_component_id: "dut", name: "pin1" },
  { type: "source_port", source_port_id: "dut_out", source_component_id: "dut", name: "pin2" },
  { type: "simulation_spice_subcircuit", source_component_id: "dut", subcircuit_source: modelSource, spice_pin_to_source_port_map: { IN: "dut_in", OUT: "dut_out" } },
  { type: "simulation_voltage_probe", name: "VOUT_PROBE", signal_input_source_port_id: "dut_out" },
]
if (target === "component-with-model.circuit.tsx") {
  const output = jobDir + "/dist/spice/component-with-model"
  await mkdir(output, { recursive: true })
  await Bun.write(output + "/circuit.json", JSON.stringify(integrity))
  process.exit(0)
}
const lock = JSON.parse(await Bun.file(jobDir + "/.model-benchmark-lock/lock.json").text())
await mkdir(benchmarkOutput, { recursive: true })
if (lock.generation === 1) {
  await Bun.write(benchmarkOutput + "/circuit.json", JSON.stringify([{ type: "source_failed_to_create_component_error", message: "Locked harness is structurally invalid" }]))
  process.exit(0)
}
await Bun.write(benchmarkOutput + "/circuit.json", JSON.stringify([...integrity, { type: "simulation_transient_voltage_graph", name: "VOUT_PROBE", timestamps_ms: [0, 1], voltage_levels: [0, 1] }]))
`,
    ),
  ])
  await Promise.all([chmod(agent_path, 0o755), chmod(tsci_path, 0o755)])

  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_lock_recovery", job_dir, file_name: "recovery.pdf" })
  job_store.updateJob("job_lock_recovery", { display_status: "complete", is_complete: true })
  model_run_store.createModelRun({
    model_run_id: "model_lock_recovery",
    job_id: "job_lock_recovery",
    model_dir,
    effort_multiplier: 1,
    base_effort_ms: 20_000,
  })
  await Bun.write(join(model_dir, "setup-complete.json"), JSON.stringify({ version: 1 }))

  await runModel(
    { model_run_id: "model_lock_recovery" },
    { job_store, model_run_store, agent_bin: agent_path, tsci_bin: tsci_path },
  )

  const run = model_run_store.getModelRun("model_lock_recovery")
  const lock = JSON.parse(await Bun.file(join(job_dir, ".model-benchmark-lock", "lock.json")).text())
  expect(run?.status).toBe("complete")
  expect(run?.validation?.all_passed).toBe(true)
  expect(lock.generation).toBe(2)
  expect(await Bun.file(join(job_dir, "lock-recovery-benchmark-attempt.txt")).text()).toBe("2")
  expect(await Bun.file(join(job_dir, "lock-recovery-refinement-attempt.txt")).text()).toBe("2")
  expect(await Bun.file(join(job_dir, "lock-recovery-prompt-seen.txt")).text()).toBe("yes")
  expect(
    await Bun.file(join(job_dir, ".model-benchmark-lock", "history", "generation-0001.json")).exists(),
  ).toBe(true)
  expect(
    run?.logs.some((log) => log.message.includes("restarting model refinement from a clean time boundary")),
  ).toBe(true)

  await rm(job_dir, { recursive: true, force: true })
}, 20_000)

test("extending effort keeps an active refinement pass alive past its original reserve", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-live-extension-"))
  const model_dir = join(job_dir, "spice")
  const agent_path = join(job_dir, "extension-agent")
  const tsci_path = join(job_dir, "unused-tsci")
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nfixture"),
    Bun.write(join(job_dir, "index.circuit.tsx"), 'export default () => <chip name="U1" />\n'),
    Bun.write(
      agent_path,
      `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
if (prompt.includes("benchmark-only pass")) {
  await mkdir(dir + "/benchmarks", { recursive: true })
  await mkdir(dir + "/evidence/curves", { recursive: true })
  await Bun.write(dir + "/benchmarks/transfer.circuit.tsx", ${JSON.stringify(lockedBenchmarkSource)})
  await Bun.write(dir + "/benchmarks.json", JSON.stringify({ version: 1, locked_at: new Date().toISOString(), benchmarks: [{ id: "transfer", title: "Transfer", source: { page: 3 }, critical: true, weight: 1, tolerance: 0.05, reference_file: "evidence/curves/transfer.csv", result_file: "results/champion/transfer.csv", simulation: { kind: "transient_voltage", x_axis: "time_ms", probe_name: "VOUT_PROBE", dut_spice_node: "OUT" } }] }))
  await Bun.write(dir + "/evidence/curves/transfer.csv", "x,y\\n0,0\\n1,1\\n")
  process.exit(0)
}
await Bun.sleep(300)
await mkdir(dir + "/candidates/r0001", { recursive: true })
await Bun.write(dir + "/candidates/r0001/model.lib", ".subckt EXTENDED IN OUT\\nR1 IN OUT 1k\\n.ends EXTENDED\\n")
await Bun.write(dir + "/extension-finished.txt", "finished")
`,
    ),
    Bun.write(tsci_path, provisionalBenchmarkBuildSource),
  ])
  await Promise.all([chmod(agent_path, 0o755), chmod(tsci_path, 0o755)])

  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_live_extension", job_dir, file_name: "part.pdf" })
  job_store.updateJob("job_live_extension", { display_status: "complete", is_complete: true })
  model_run_store.createModelRun({
    model_run_id: "model_live_extension",
    job_id: "job_live_extension",
    model_dir,
    effort_multiplier: 1,
    base_effort_ms: 1_000,
  })
  await Bun.write(join(model_dir, "setup-complete.json"), JSON.stringify({ version: 1 }))

  const refinement_started = new Promise<void>((resolve) => {
    const unsubscribe = model_run_store.subscribe("model_live_extension", (event) => {
      if (event.event_type !== "log" && event.model_run.status === "running") {
        unsubscribe?.()
        resolve()
      }
    })
  })
  const run_promise = runModel(
    { model_run_id: "model_live_extension" },
    { job_store, model_run_store, agent_bin: agent_path, tsci_bin: tsci_path },
  )
  await refinement_started
  await Bun.sleep(50)
  const extension = model_run_store.extendModelRun("model_live_extension", 1)
  expect(extension.should_start).toBe(false)
  await run_promise

  expect(await Bun.file(join(model_dir, "extension-finished.txt")).text()).toBe("finished")
  expect(model_run_store.getModelRun("model_live_extension")?.model_source).toContain(".subckt EXTENDED")
  await rm(job_dir, { recursive: true, force: true })
}, 10_000)

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
const prompt = args[args.indexOf("--prompt") + 1]
if (prompt.includes("benchmark-only pass")) {
  await mkdir(dir + "/benchmarks", { recursive: true })
  await mkdir(dir + "/evidence/curves", { recursive: true })
  await Bun.write(dir + "/benchmarks/transfer.circuit.tsx", ${JSON.stringify(lockedBenchmarkSource)})
  await Bun.write(dir + "/benchmarks.json", JSON.stringify({ version: 1, locked_at: new Date().toISOString(), benchmarks: [{ id: "transfer", title: "Transfer", source: { page: 3 }, critical: true, weight: 1, tolerance: 0.05, reference_file: "evidence/curves/transfer.csv", result_file: "results/champion/transfer.csv", simulation: { kind: "transient_voltage", x_axis: "time_ms", probe_name: "VOUT_PROBE", dut_spice_node: "OUT" } }] }))
  await Bun.write(dir + "/evidence/curves/transfer.csv", "x,y\\n0,0\\n1,1\\n")
  process.exit(0)
}
await mkdir(dir + "/candidates/r0001", { recursive: true })
await Bun.write(dir + "/candidates/r0001/model.lib", ".subckt RECOVERED IN OUT\\nR1 IN OUT 1k\\n.ends RECOVERED\\n")
await Bun.write(dir + "/iteration-history.json", JSON.stringify([{ revision: "r0001", decision: "promoted" }]))
await Bun.sleep(30_000)
`,
  )
  await Bun.write(tsci_path, provisionalBenchmarkBuildSource)
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
  expect(recovered_run?.elapsed_time_ms).toBeGreaterThanOrEqual(900)
  expect(recovered_run?.elapsed_time_ms).toBeLessThan(1_250)
  expect(recovered_run?.error_message).toContain("every benchmark could be verified")

  await rm(job_dir, { recursive: true, force: true })
}, 10_000)

test("model runner runs each complete transient benchmark once in one bounded pool", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-waveform-runner-"))
  const model_dir = join(job_dir, "spice")
  const agent_path = join(job_dir, "waveform-agent")
  const tsci_path = join(job_dir, "waveform-tsci")
  const waveform_source = `import Component from "../component-with-model.circuit"

export default function WaveformBenchmark() {
  return (
    <board routingDisabled>
      <Component name="DUT" />
      <voltageprobe name="VOUT" connectsTo="DUT.pin2" />
      <analogsimulation duration="2ms" timePerStep="0.1ms" spiceEngine="ngspice" />
    </board>
  )
}
`
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nwaveform fixture"),
    Bun.write(join(job_dir, "index.circuit.tsx"), 'export default () => <chip name="U1" />\n'),
    Bun.write(
      agent_path,
      `#!/usr/bin/env bun
import { mkdir } from "node:fs/promises"
const args = process.argv.slice(2)
const dir = args[args.indexOf("--dir") + 1]
const prompt = args[args.indexOf("--prompt") + 1]
await mkdir(dir + "/benchmarks", { recursive: true })
await mkdir(dir + "/evidence/curves", { recursive: true })
if (prompt.includes("benchmark-only pass")) {
  await Bun.write(dir + "/benchmarks/waveform-a.circuit.tsx", ${JSON.stringify(waveform_source)})
  await Bun.write(dir + "/benchmarks/waveform-b.circuit.tsx", ${JSON.stringify(waveform_source)})
  const simulation = { kind: "transient_voltage", x_axis: "time_ms", probe_name: "VOUT", dut_spice_node: "OUT" }
  await Bun.write(dir + "/benchmarks.json", JSON.stringify({ version: 1, locked_at: new Date().toISOString(), benchmarks: [
    { id: "waveform-a", title: "Waveform A", source: { page: 2 }, critical: true, weight: 1, tolerance: 0.01, reference_file: "evidence/curves/waveform-a.csv", result_file: "results/champion/waveform-a.csv", simulation },
    { id: "waveform-b", title: "Waveform B", source: { page: 2 }, critical: true, weight: 1, tolerance: 0.01, reference_file: "evidence/curves/waveform-b.csv", result_file: "results/champion/waveform-b.csv", simulation },
  ] }))
  await Bun.write(dir + "/evidence/curves/waveform-a.csv", "x,y\\n0,0\\n1,2\\n2,4\\n")
  await Bun.write(dir + "/evidence/curves/waveform-b.csv", "x,y\\n0,0\\n1,2\\n2,4\\n")
  process.exit(0)
}
await Bun.write(dir + "/model.lib", ".subckt WAVEFORM IN OUT\\nR1 IN OUT 1k\\n.ends WAVEFORM\\n")
await Bun.write(dir + "/model-manifest.json", JSON.stringify({ version: 1, part_number: "WAVEFORM", dialect: "portable", entry_name: "WAVEFORM", model_file: "model.lib", revision: "r0001", simulator: "ngspice", generated_at: new Date().toISOString(), pins: [{ component_pin: "pin1", spice_node: "IN" }, { component_pin: "pin2", spice_node: "OUT" }] }))
await Bun.write(dir + "/component-with-model.circuit.tsx", "export default () => <chip name=\\"untrusted\\" />\\n")
await Bun.write(dir + "/iteration-history.json", JSON.stringify([{ revision: "r0001", decision: "promoted" }]))
await Bun.write(dir + "/model-card.md", "# WAVEFORM model\\n")
`,
    ),
    Bun.write(
      tsci_path,
      `#!/usr/bin/env bun
import { appendFile, mkdir } from "node:fs/promises"
const jobDir = ${JSON.stringify(job_dir)}
const args = Bun.argv.slice(2)
const target = args[1] ?? ""
if (target === "server-ngspice-preflight.circuit.tsx") {
  const output = jobDir + "/dist/spice/server-ngspice-preflight"
  await mkdir(output, { recursive: true })
  await Bun.write(output + "/circuit.json", JSON.stringify([{ type: "simulation_transient_voltage_graph", name: "RESULT", timestamps_ms: [0, 0.01], voltage_levels: [1, 1] }]))
  process.exit(0)
}
if (!(await Bun.file(jobDir + "/spice/model.lib").exists())) {
  const match = target.match(/^benchmarks\\/(waveform-[ab])\\.circuit\\.tsx$/)
  if (!match) process.exit(9)
  await mkdir(jobDir + "/dist/spice/benchmarks/" + match[1], { recursive: true })
  await Bun.write(jobDir + "/dist/spice/benchmarks/" + match[1] + "/circuit.json", "[]")
  process.exit(0)
}
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
const match = target.match(/^benchmarks\\/(waveform-[ab])\\.circuit\\.tsx$/)
if (!match) process.exit(2)
const benchmarkId = match[1]
const startedAt = Date.now()
await appendFile(jobDir + "/waveform-timing.log", benchmarkId + ",start," + startedAt + "\\n")
await Bun.sleep(benchmarkId === "waveform-a" ? 80 : 220)
await mkdir(jobDir + "/dist/spice/benchmarks/" + benchmarkId, { recursive: true })
await Bun.write(jobDir + "/dist/spice/benchmarks/" + benchmarkId + "/circuit.json", JSON.stringify([...integrity, { type: "simulation_transient_voltage_graph", name: "VOUT", timestamps_ms: [0, 1, 2], voltage_levels: [0, 2, 4] }]))
await appendFile(jobDir + "/waveform-timing.log", benchmarkId + ",end," + Date.now() + "\\n")
`,
    ),
  ])
  await Promise.all([chmod(agent_path, 0o755), chmod(tsci_path, 0o755)])

  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_waveform", job_dir, file_name: "waveform.pdf" })
  job_store.updateJob("job_waveform", { display_status: "complete", is_complete: true })
  model_run_store.createModelRun({
    model_run_id: "model_waveform",
    job_id: "job_waveform",
    model_dir,
    effort_multiplier: 1,
    base_effort_ms: 10_000,
  })
  await Bun.write(join(model_dir, "setup-complete.json"), JSON.stringify({ version: 1 }))

  await runModel(
    { model_run_id: "model_waveform" },
    { job_store, model_run_store, agent_bin: agent_path, tsci_bin: tsci_path },
  )

  expect(model_run_store.getModelRun("model_waveform")?.status).toBe("complete")
  expect(await Bun.file(join(job_dir, "unexpected-prelock-tsci.txt")).exists()).toBe(false)
  expect(await Bun.file(join(model_dir, "results", "verified", "waveform-a.csv")).text()).toBe(
    "x,y\n0,0\n1,2\n2,4\n",
  )
  expect(await Bun.file(join(model_dir, "results", "verified", "waveform-b.csv")).text()).toBe(
    "x,y\n0,0\n1,2\n2,4\n",
  )
  expect((await stat(join(model_dir, "results", "verified", "waveform-a.csv"))).mtimeMs).toBeLessThan(
    (await stat(join(model_dir, "results", "verified", "waveform-b.csv"))).mtimeMs,
  )
  const timing = (await Bun.file(join(job_dir, "waveform-timing.log")).text())
    .trim()
    .split("\n")
    .map((line) => line.split(","))
  const started = new Map(
    timing.filter((entry) => entry[1] === "start").map((entry) => [entry[0], Number(entry[2])]),
  )
  const ended = new Map(
    timing.filter((entry) => entry[1] === "end").map((entry) => [entry[0], Number(entry[2])]),
  )
  expect(started.size).toBe(2)
  expect(ended.size).toBe(2)
  expect(Math.max(...started.values())).toBeLessThan(Math.min(...ended.values()))

  await rm(job_dir, { recursive: true, force: true })
}, 20_000)
