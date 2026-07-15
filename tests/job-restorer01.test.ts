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

test("persisted component and model jobs survive a server restart and deletion removes both", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-restore-"))
  const job_dir = join(jobs_root, "job_restore")
  const model_dir = join(job_dir, "spice")
  await mkdir(join(job_dir, "dist", "index"), { recursive: true })
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nrestore fixture"),
    Bun.write(join(job_dir, "index.circuit.tsx"), "export default () => <board />\n"),
    Bun.write(
      join(job_dir, "dist", "index", "circuit.json"),
      JSON.stringify([{ type: "source_component", source_component_id: "restored" }]),
    ),
  ])

  const original_jobs = new JobStore()
  original_jobs.createJob({
    job_id: "job_restore",
    job_dir,
    file_name: "original-sensor.pdf",
    additional_instructions: "Keep the exposed pad",
  })
  await original_jobs.appendLog("job_restore", "system", "Original component log\n")
  original_jobs.updateJob("job_restore", { display_status: "building" })

  const original_models = new ModelRunStore()
  original_models.createModelRun({
    model_run_id: "model_restore",
    job_id: "job_restore",
    model_dir,
    effort_multiplier: 2,
    base_effort_ms: 1_000,
  })
  await Bun.write(join(model_dir, "model.lib"), ".SUBCKT RESTORED IN OUT\n.ENDS RESTORED\n")
  await original_models.appendLog("model_restore", "system", "Original model log\n")
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
  expect(restored_jobs.getJob("job_restore")?.display_status).toBe("complete")
  expect(restored_jobs.getJob("job_restore")?.logs[0]?.message).toBe("Original component log\n")
  expect(restored_jobs.getJob("job_restore")?.circuit_json?.[0]?.type).toBe("source_component")

  const restored_model = restored_models.getModelRunForJob("job_restore")
  expect(restored_model?.model_run_id).toBe("model_restore")
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
            simulation: { kind: "transient_voltage", probe_name: "VOUT" },
          },
        ],
      }),
    ),
    Bun.write(
      join(circuit_dir, "circuit.json"),
      JSON.stringify([
        {
          type: "simulation_transient_voltage_graph",
          name: "VOUT",
          timestamps_ms: [0, 1],
          voltage_levels: [0, 1],
        },
      ]),
    ),
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
