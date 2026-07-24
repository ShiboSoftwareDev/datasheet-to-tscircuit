import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJobApiHandler } from "@/server/job-api"
import { restorePersistedJobs } from "@/server/job-restorer"
import { JobStore } from "@/server/job-store"
import { loadModelSelectedPreview } from "@/server/model-artifact-monitor"
import { ModelRunStore } from "@/server/model-run-store"
import {
  verifySimulationBenchmark,
  writeSimulationValidationReport,
} from "@/server/model-simulation-validator"

const verifiedModelSource = ".subckt RESTORED IN OUT\nR1 IN OUT 1k\n.ends RESTORED\n"

function verifiedCircuit(probe_name: string) {
  return [
    { type: "source_component", source_component_id: "dut", name: "DUT" },
    { type: "source_port", source_port_id: "dut_in", source_component_id: "dut", name: "IN" },
    { type: "source_port", source_port_id: "dut_out", source_component_id: "dut", name: "OUT" },
    {
      type: "simulation_spice_subcircuit",
      source_component_id: "dut",
      subcircuit_source: verifiedModelSource,
      spice_pin_to_source_port_map: { IN: "dut_in", OUT: "dut_out" },
    },
    { type: "simulation_voltage_probe", name: probe_name, signal_input_source_port_id: "dut_out" },
    {
      type: "simulation_transient_voltage_graph",
      name: probe_name,
      timestamps_ms: [0, 1],
      voltage_levels: [0, 1],
    },
  ]
}

test("persisted component and model jobs survive a server restart and deletion removes both", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-restore-"))
  const job_dir = join(jobs_root, "job_restore")
  const model_dir = join(job_dir, "spice")
  await Promise.all([
    mkdir(join(job_dir, "dist", "index"), { recursive: true }),
    mkdir(join(job_dir, "dist", "spice", "component-with-model"), { recursive: true }),
    mkdir(join(job_dir, "dist", "typical-application"), { recursive: true }),
  ])
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nrestore fixture"),
    Bun.write(join(job_dir, "index.circuit.tsx"), "export default () => <board />\n"),
    Bun.write(
      join(job_dir, "typical-application.circuit.tsx"),
      'import Component from "./index.circuit"\nexport default () => <board><Component /></board>\n',
    ),
    Bun.write(
      join(job_dir, "typical-application-plan.json"),
      JSON.stringify({ title: "Restored sensor application" }),
    ),
    Bun.write(
      join(job_dir, "dist", "index", "circuit.json"),
      JSON.stringify([
        { type: "source_component", source_component_id: "restored" },
        { type: "pcb_component", source_component_id: "restored" },
      ]),
    ),
    Bun.write(
      join(job_dir, "dist", "spice", "component-with-model", "circuit.json"),
      JSON.stringify([
        { type: "source_component", source_component_id: "restored" },
        { type: "simulation_spice_subcircuit", source_component_id: "restored" },
      ]),
    ),
    Bun.write(
      join(job_dir, "dist", "typical-application", "circuit.json"),
      JSON.stringify([{ type: "source_component", source_component_id: "application" }]),
    ),
  ])

  const original_jobs = new JobStore()
  original_jobs.createJob({
    job_id: "job_restore",
    job_dir,
    file_name: "original-sensor.pdf",
    additional_instructions: "Keep the exposed pad",
  })
  await original_jobs.appendLog("job_restore", {
    stream: "system",
    message: "Original component log\n",
  })
  original_jobs.updateJob("job_restore", { display_status: "building" })

  const original_models = new ModelRunStore()
  original_models.createModelRun({
    model_run_id: "model_restore",
    job_id: "job_restore",
    model_dir,
    use_openai: true,
    effort_multiplier: 2,
    base_effort_ms: 1_000,
  })
  await Bun.write(join(model_dir, "model.lib"), ".SUBCKT RESTORED IN OUT\n.ENDS RESTORED\n")
  await original_models.appendLog("model_restore", {
    stream: "system",
    message: "Original model log\n",
  })
  original_models.startSegment("model_restore")

  const restored_jobs = new JobStore()
  const restored_models = new ModelRunStore()
  const restored = await restorePersistedJobs({
    jobs_root,
    job_store: restored_jobs,
    model_run_store: restored_models,
  })

  expect(restored).toEqual({ jobs_restored: 1, model_runs_restored: 1 })
  expect(restored_jobs.getJob("job_restore")?.file_name).toBe("original-sensor.pdf")
  expect(restored_jobs.getJob("job_restore")?.use_openai).toBe(true)
  expect(restored_jobs.getJob("job_restore")?.display_status).toBe("complete")
  expect(restored_jobs.getJob("job_restore")?.component_ready).toBe(true)
  expect(restored_jobs.getJob("job_restore")?.typical_application_title).toBe("Restored sensor application")
  expect(restored_jobs.getJob("job_restore")?.logs[0]?.message).toBe("Original component log\n")
  expect(restored_jobs.getJob("job_restore")?.circuit_json?.[0]?.type).toBe("source_component")
  expect(
    restored_jobs.getJob("job_restore")?.circuit_json?.some((element) => element.type === "pcb_component"),
  ).toBe(true)
  expect(restored_jobs.getJob("job_restore")?.typical_application_circuit_json?.[0]?.type).toBe(
    "source_component",
  )

  const restored_model = restored_models.getModelRunForJob("job_restore")
  expect(restored_model?.model_run_id).toBe("model_restore")
  expect(restored_model?.use_openai).toBe(true)
  expect(restored_model?.status).toBe("failed")
  expect(restored_model?.error_message).toContain("server restarted")
  expect(restored_model?.model_source).toContain(".SUBCKT RESTORED")
  expect(restored_model?.logs[0]?.message).toBe("Original model log\n")

  const handle = createJobApiHandler({
    jobs_root,
    job_store: restored_jobs,
    model_run_store: restored_models,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
  })
  const delete_response = await handle(
    new Request("http://localhost/api/job/delete?job_id=job_restore", { method: "DELETE" }),
  )
  expect(delete_response?.status).toBe(204)
  expect(restored_jobs.getJob("job_restore")).toBeUndefined()
  expect(restored_models.getModelRunForJob("job_restore")).toBeUndefined()
  expect(
    await stat(job_dir)
      .then(() => true)
      .catch(() => false),
  ).toBe(false)

  await rm(jobs_root, { recursive: true, force: true })
})

test("failed component validation is not restored as ready", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-failed-component-restore-"))
  const job_dir = join(jobs_root, "failed_component")
  await mkdir(join(job_dir, "dist", "index"), { recursive: true })
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nfailed component fixture"),
    Bun.write(join(job_dir, "index.circuit.tsx"), "export default () => <chip />\n"),
    Bun.write(
      join(job_dir, "dist", "index", "circuit.json"),
      JSON.stringify([{ type: "source_component", source_component_id: "failed" }]),
    ),
  ])

  const original_jobs = new JobStore()
  original_jobs.createJob({
    job_id: "failed_component",
    job_dir,
    file_name: "failed-component.pdf",
    use_openai: true,
  })
  original_jobs.updateJob("failed_component", {
    display_status: "failed",
    is_complete: true,
    has_errors: true,
    component_ready: true,
    validation: {
      evidence: "passed",
      component_build: "passed",
      component_drc: "failed",
      footprint: "passed",
      pinout: "passed",
      component_schematic: "passed",
      component_visual: "passed",
      application_build: "pending",
      application_connectivity: "pending",
      application_schematic: "pending",
      application_visual: "pending",
    },
  })

  const restored_jobs = new JobStore()
  await restorePersistedJobs({
    jobs_root,
    job_store: restored_jobs,
    model_run_store: new ModelRunStore(),
  })

  expect(restored_jobs.getJob("failed_component")?.display_status).toBe("failed")
  expect(restored_jobs.getJob("failed_component")?.use_openai).toBe(true)
  expect(restored_jobs.getJob("failed_component")?.validation?.component_drc).toBe("failed")
  expect(restored_jobs.getJob("failed_component")?.component_ready).toBe(false)

  await rm(jobs_root, { recursive: true, force: true })
})

test("obsolete compact-layout failures recover automatically after saved-artifact validation", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-layout-recovery-"))
  const job_dir = join(jobs_root, "layout_failure")
  await Promise.all([
    mkdir(join(job_dir, "dist", "index"), { recursive: true }),
    mkdir(join(job_dir, "dist", "typical-application"), { recursive: true }),
  ])
  const application_circuit = [
    { type: "source_component", source_component_id: "u1", name: "U1" },
    {
      type: "source_port",
      source_port_id: "u1_vcc",
      source_component_id: "u1",
      name: "VCC",
      subcircuit_connectivity_map_key: "vcc",
    },
    { type: "source_component", source_component_id: "c1", name: "C1", capacitance: 1e-6 },
    {
      type: "source_port",
      source_port_id: "c1_pin1",
      source_component_id: "c1",
      name: "pin1",
      pin_number: 1,
      subcircuit_connectivity_map_key: "vcc",
    },
    ...Array.from({ length: 7 }, (_, index) => ({
      type: "schematic_component",
      schematic_component_id: `schematic-${index}`,
      center: { x: index, y: 0 },
    })),
    {
      type: "schematic_trace",
      schematic_trace_id: "formerly-rejected-trace",
      edges: [{ from: { x: 0, y: 0 }, to: { x: 7.13, y: 0 } }],
    },
  ]
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nlayout recovery fixture"),
    Bun.write(join(job_dir, "index.circuit.tsx"), 'export default () => <chip name="U1" />\n'),
    Bun.write(
      join(job_dir, "typical-application.circuit.tsx"),
      'import Component from "./index.circuit"\nexport default () => <board><Component name="U1" /><capacitor name="C1" capacitance="1uF" /></board>\n',
    ),
    Bun.write(
      join(job_dir, "typical-application-plan.json"),
      JSON.stringify({
        version: 3,
        availability: "documented",
        title: "Typical application",
        description: "Automatically recoverable application",
        source_references: [{ page: 8 }],
        components: [
          { reference: "U1", kind: "integrated_circuit" },
          { reference: "C1", kind: "capacitor", value: "1uF" },
        ],
        connections: [{ net: "VCC", pins: ["U1.VCC", "C1.pin1"] }],
      }),
    ),
    Bun.write(
      join(job_dir, "dist", "index", "circuit.json"),
      JSON.stringify([{ type: "source_component", source_component_id: "u1", name: "U1" }]),
    ),
    Bun.write(
      join(job_dir, "dist", "typical-application", "circuit.json"),
      JSON.stringify(application_circuit),
    ),
  ])

  const original_jobs = new JobStore()
  original_jobs.createJob({ job_id: "layout_failure", job_dir, file_name: "layout.pdf" })
  original_jobs.updateJob("layout_failure", {
    display_status: "failed",
    is_complete: true,
    has_errors: true,
    component_ready: true,
    error_message:
      "Typical application failed schematic layout validation: Application schematic trace 9 edge 5 is 7.13 units long; compact-layout limit is 6.61 for 7 components",
    validation: {
      evidence: "passed",
      component_build: "passed",
      component_drc: "passed",
      footprint: "passed",
      pinout: "passed",
      component_schematic: "passed",
      component_visual: "passed",
      application_build: "passed",
      application_connectivity: "pending",
      application_schematic: "failed",
      application_visual: "passed",
    },
  })

  const restored_jobs = new JobStore()
  await restorePersistedJobs({
    jobs_root,
    job_store: restored_jobs,
    model_run_store: new ModelRunStore(),
  })

  const recovered = restored_jobs.getJob("layout_failure")
  expect(recovered?.display_status).toBe("complete")
  expect(recovered?.has_errors).toBe(false)
  expect(recovered?.error_message).toBeUndefined()
  expect(recovered?.validation?.application_schematic).toBe("passed")
  expect(recovered?.validation?.application_connectivity).toBe("passed")
  expect(recovered?.logs.at(-1)?.message).toContain("Recovered the generated typical application")
  expect(JSON.parse(await Bun.file(join(job_dir, "job.json")).text()).display_status).toBe("complete")

  await rm(jobs_root, { recursive: true, force: true })
})

test("legacy completed model runs are reopened because their agent-written CSVs were not verified", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-legacy-model-restore-"))
  const job_dir = join(jobs_root, "legacy_job")
  const model_dir = join(job_dir, "spice")
  await mkdir(model_dir, { recursive: true })
  await Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nlegacy fixture")

  const original_jobs = new JobStore()
  original_jobs.createJob({ job_id: "legacy_job", job_dir, file_name: "legacy.pdf" })
  original_jobs.updateJob("legacy_job", { display_status: "complete", is_complete: true })
  const original_models = new ModelRunStore()
  original_models.createModelRun({
    model_run_id: "legacy_model",
    job_id: "legacy_job",
    model_dir,
    effort_multiplier: 1,
    base_effort_ms: 1_000,
  })
  original_models.updateModelRun("legacy_model", {
    status: "complete",
    is_complete: true,
    has_errors: false,
    completed_at: new Date().toISOString(),
  })

  const restored_jobs = new JobStore()
  const restored_models = new ModelRunStore()
  await restorePersistedJobs({ jobs_root, job_store: restored_jobs, model_run_store: restored_models })

  expect(restored_models.getModelRunForJob("legacy_job")?.status).toBe("timed_out")
  expect(restored_models.getModelRunForJob("legacy_job")?.error_message).toContain(
    "predates simulator-owned validation",
  )

  await rm(jobs_root, { recursive: true, force: true })
})

test("verified simulation artifacts and dropdown previews survive a server restart", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-verified-model-restore-"))
  const job_dir = join(jobs_root, "verified_job")
  const model_dir = join(job_dir, "spice")
  const circuit_dir = join(job_dir, "dist", "spice", "benchmarks", "transfer")
  await Promise.all([
    mkdir(join(model_dir, "benchmarks"), { recursive: true }),
    mkdir(join(model_dir, "evidence", "curves"), { recursive: true }),
    mkdir(circuit_dir, { recursive: true }),
  ])
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nverified fixture"),
    Bun.write(join(model_dir, "benchmarks", "transfer.circuit.tsx"), "export default () => <board />\n"),
    Bun.write(join(model_dir, "evidence", "curves", "transfer.csv"), "x,y\n0,0\n1,1\n"),
    Bun.write(join(model_dir, "model.lib"), verifiedModelSource),
    Bun.write(
      join(model_dir, "benchmarks.json"),
      JSON.stringify({
        version: 1,
        locked_at: new Date().toISOString(),
        benchmarks: [
          {
            id: "transfer",
            title: "Transfer",
            source: { page: 1 },
            critical: true,
            weight: 1,
            tolerance: 0.1,
            reference_file: "evidence/curves/transfer.csv",
            result_file: "results/champion/transfer.csv",
            simulation: {
              kind: "transient_voltage",
              x_axis: "time_ms",
              probe_name: "VOUT",
              dut_spice_node: "OUT",
            },
          },
        ],
      }),
    ),
    Bun.write(join(circuit_dir, "circuit.json"), JSON.stringify(verifiedCircuit("VOUT"))),
  ])

  const original_jobs = new JobStore()
  original_jobs.createJob({ job_id: "verified_job", job_dir, file_name: "verified.pdf" })
  original_jobs.updateJob("verified_job", { display_status: "complete", is_complete: true })
  const original_models = new ModelRunStore()
  original_models.createModelRun({
    model_run_id: "verified_model",
    job_id: "verified_job",
    model_dir,
    effort_multiplier: 1,
    base_effort_ms: 1_000,
  })
  const verification = await verifySimulationBenchmark({ model_dir, benchmark_id: "transfer" })
  await writeSimulationValidationReport(model_dir, [verification])
  original_models.updateModelRun("verified_model", {
    status: "complete",
    is_complete: true,
    has_errors: false,
    completed_at: new Date().toISOString(),
  })

  const restored_jobs = new JobStore()
  const restored_models = new ModelRunStore()
  await restorePersistedJobs({ jobs_root, job_store: restored_jobs, model_run_store: restored_models })
  expect(restored_models.getModelRunForJob("verified_job")?.status).toBe("complete")

  const preview = await loadModelSelectedPreview({ model_dir, benchmark_id: "transfer" })
  expect(preview?.circuit_preview?.snapshot_origin).toBe("server_validation")
  expect(preview?.reference_preview?.result_points).toEqual([
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ])

  await rm(jobs_root, { recursive: true, force: true })
})
