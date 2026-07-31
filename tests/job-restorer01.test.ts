import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import { createJobApiHandler } from "@/server/job-api"
import { restorePersistedJobs } from "@/server/job-restorer"
import { readRestoredCircuitJson } from "@/server/job-restorer/read-restored-circuit-json"
import { JobStore } from "@/server/job-store"
import { ModelRunStore } from "@/server/model-run-store"

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
  })
  await Bun.write(join(model_dir, "model.lib"), ".SUBCKT RESTORED IN OUT\n.ENDS RESTORED\n")
  await original_models.appendLog("model_restore", {
    stream: "system",
    message: "Original model log\n",
  })
  original_models.startSegment("model_restore")
  await Bun.sleep(5)

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
  expect(restored_jobs.getJob("job_restore")?.display_status).toBe("failed")
  expect(restored_jobs.getJob("job_restore")?.component_ready).toBe(false)
  expect(restored_jobs.getJob("job_restore")?.typical_application_title).toBeUndefined()
  expect(restored_jobs.getJob("job_restore")?.evidence_available).toBe(false)
  expect(restored_jobs.getJob("job_restore")?.logs[0]?.message).toBe("Original component log\n")
  expect(restored_jobs.getJob("job_restore")?.circuit_json?.[0]?.type).toBe("source_component")
  expect(
    restored_jobs.getJob("job_restore")?.circuit_json?.some((element) => element.type === "pcb_component"),
  ).toBe(true)
  expect(restored_jobs.getJob("job_restore")?.typical_application_circuit_json).toBeUndefined()

  const restored_model = restored_models.getModelRunForJob("job_restore")
  expect(restored_model?.model_run_id).toBe("model_restore")
  expect(restored_model?.use_openai).toBe(true)
  expect(restored_model?.status).toBe("failed")
  expect(restored_model?.error_message).toContain("server restarted")
  expect(restored_model?.elapsed_time_ms).toBeGreaterThan(0)
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

test("an empty Circuit JSON checkpoint is never restored as a ready component", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-empty-circuit-restore-"))
  const job_dir = join(jobs_root, "empty_component")
  await mkdir(job_dir, { recursive: true })
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nempty circuit fixture"),
    Bun.write(join(job_dir, "index.circuit.tsx"), "export default () => <chip />\n"),
    Bun.write(join(job_dir, "component.circuit.json"), "[]\n"),
  ])

  const original_jobs = new JobStore()
  original_jobs.createJob({
    job_id: "empty_component",
    job_dir,
    file_name: "empty-component.pdf",
  })
  original_jobs.updateJob("empty_component", {
    display_status: "complete",
    is_complete: true,
    has_errors: false,
    component_ready: true,
    validation: {
      evidence: "passed",
      component_build: "passed",
      component_drc: "passed",
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

  expect(restored_jobs.getJob("empty_component")).toMatchObject({
    display_status: "failed",
    is_complete: true,
    has_errors: true,
    component_ready: false,
  })
  expect(restored_jobs.getJob("empty_component")?.error_message).toContain(
    "validated component artifacts are missing or inconsistent",
  )

  await rm(jobs_root, { recursive: true, force: true })
})

test("saved failures are never silently reclassified by a restart", async () => {
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
  expect(recovered?.display_status).toBe("failed")
  expect(recovered?.has_errors).toBe(true)
  expect(recovered?.error_message).toContain("Typical application failed schematic layout")
  expect(recovered?.validation?.application_schematic).toBe("failed")
  expect(recovered?.validation?.application_connectivity).toBe("pending")
  expect(recovered?.logs.some(({ message }) => message.includes("Recovered"))).toBe(false)
  expect(JSON.parse(await Bun.file(join(job_dir, "job.json")).text()).display_status).toBe("failed")

  await rm(jobs_root, { recursive: true, force: true })
})

test("restart recovers a component whose publish stage crossed the commit barrier", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-published-component-restore-"))
  const job_dir = join(jobs_root, "published_component")
  await mkdir(job_dir, { recursive: true })
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\npublished component fixture"),
    Bun.write(join(job_dir, "index.circuit.tsx"), "export default () => <chip />\n"),
    Bun.write(
      join(job_dir, "component.circuit.json"),
      JSON.stringify([{ type: "source_component", source_component_id: "published" }]),
    ),
  ])
  const timestamp = new Date().toISOString()
  const original_jobs = new JobStore()
  original_jobs.createJob({
    job_id: "published_component",
    job_dir,
    file_name: "published.pdf",
  })
  original_jobs.updateJob("published_component", {
    display_status: "building",
    component_ready: true,
    validation: {
      evidence: "passed",
      component_build: "passed",
      component_drc: "passed",
      footprint: "passed",
      pinout: "passed",
      component_schematic: "passed",
      component_visual: "inconclusive",
      application_build: "not_applicable",
      application_connectivity: "not_applicable",
      application_schematic: "not_applicable",
      application_visual: "not_applicable",
    },
    pipeline: {
      pipeline_id: "datasheet_component",
      status: "completed",
      sequence: 20,
      started_at: timestamp,
      updated_at: timestamp,
      stage_results: {
        publish: {
          stage_id: "publish",
          status: "completed",
          debug_ref: "runs/invocation/.pipeline/stages/09-publish",
          started_at: timestamp,
          completed_at: timestamp,
          duration_ms: 1,
        },
      },
    },
  })

  const restored_jobs = new JobStore()
  const result = await restorePersistedJobs({
    jobs_root,
    job_store: restored_jobs,
    model_run_store: new ModelRunStore(),
  })
  expect(result.jobs_restored).toBe(1)
  expect(restored_jobs.getJob("published_component")).toMatchObject({
    display_status: "complete",
    is_complete: true,
    has_errors: false,
    component_ready: true,
  })
  expect(restored_jobs.getJob("published_component")?.error_message).toBeUndefined()

  await rm(jobs_root, { recursive: true, force: true })
})

test("restart rejects a completed checkpoint whose component artifacts are missing", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-invalid-completion-restore-"))
  const job_dir = join(jobs_root, "invalid_completion")
  await mkdir(job_dir, { recursive: true })
  await Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\ninvalid completion fixture")
  const original_jobs = new JobStore()
  original_jobs.createJob({
    job_id: "invalid_completion",
    job_dir,
    file_name: "invalid.pdf",
  })
  original_jobs.updateJob("invalid_completion", {
    display_status: "complete",
    is_complete: true,
    component_ready: true,
  })

  const restored_jobs = new JobStore()
  await restorePersistedJobs({
    jobs_root,
    job_store: restored_jobs,
    model_run_store: new ModelRunStore(),
  })
  expect(restored_jobs.getJob("invalid_completion")).toMatchObject({
    display_status: "failed",
    is_complete: true,
    has_errors: true,
    component_ready: false,
  })
  expect(restored_jobs.getJob("invalid_completion")?.error_message).toContain(
    "validated component artifacts are missing",
  )

  await rm(jobs_root, { recursive: true, force: true })
})

test("legacy completed model runs fail closed without a server validation result", async () => {
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

  expect(restored_models.getModelRunForJob("legacy_job")?.status).toBe("failed")
  expect(restored_models.getModelRunForJob("legacy_job")?.error_message).toContain(
    "no passing server-owned validation result",
  )

  await rm(jobs_root, { recursive: true, force: true })
})

test("restart prefers the current integrated model Circuit JSON over the bare component", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-integrated-circuit-restore-"))
  const integrated = [
    { type: "source_component", source_component_id: "integrated", name: "MODELED" },
    { type: "pcb_component", pcb_component_id: "integrated_pcb", source_component_id: "integrated" },
    {
      type: "simulation_spice_subcircuit",
      simulation_spice_subcircuit_id: "integrated_model",
      source_component_id: "integrated",
      subcircuit_source: ".SUBCKT TEST IN OUT\n.ENDS TEST",
      spice_pin_to_source_port_map: {},
    },
  ] as AnyCircuitElement[]
  const bare = [
    { type: "source_component", source_component_id: "bare", name: "UNMODELED" },
    { type: "pcb_component", pcb_component_id: "bare_pcb", source_component_id: "bare" },
  ] as AnyCircuitElement[]
  await mkdir(join(job_dir, "spice"), { recursive: true })
  await Promise.all([
    Bun.write(join(job_dir, "spice", "component-with-model.circuit.json"), JSON.stringify(integrated)),
    Bun.write(join(job_dir, "component.circuit.json"), JSON.stringify(bare)),
  ])

  expect(await readRestoredCircuitJson(job_dir, "component")).toEqual(integrated)

  await rm(job_dir, { recursive: true, force: true })
})

test("restart cleans transactions, ignores ordinary staging residue, and diagnoses invalid job markers", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-private-workspaces-"))
  const tombstone = join(jobs_root, ".deleting-old-job-fixture")
  const staging_dir = join(jobs_root, ".creating-new-job-fixture")
  const partial_dir = join(jobs_root, "partial-job")
  const mismatched_dir = join(jobs_root, "mismatched-job")
  const malformed_dir = join(jobs_root, "malformed-job")
  const oversized_dir = join(jobs_root, "oversized-job")
  const symlinked_dir = join(jobs_root, "symlinked-job")
  const symlink_target = join(jobs_root, "symlink-marker-target.json")
  const markerless_publication_dir = join(jobs_root, "markerless-publication")
  await Promise.all([
    mkdir(tombstone, { recursive: true }),
    mkdir(staging_dir, { recursive: true }),
    mkdir(partial_dir, { recursive: true }),
    mkdir(mismatched_dir, { recursive: true }),
    mkdir(malformed_dir, { recursive: true }),
    mkdir(oversized_dir, { recursive: true }),
    mkdir(symlinked_dir, { recursive: true }),
    mkdir(markerless_publication_dir, { recursive: true }),
  ])
  await Promise.all([
    Bun.write(join(tombstone, "datasheet.pdf"), "%PDF-1.7\ndeleted fixture"),
    Bun.write(join(staging_dir, "datasheet.pdf"), "%PDF-1.7\nstaged fixture"),
    Bun.write(join(partial_dir, "datasheet.pdf"), "%PDF-1.7\npartial fixture"),
    Bun.write(join(mismatched_dir, "datasheet.pdf"), "%PDF-1.7\nmismatched fixture"),
    Bun.write(join(malformed_dir, "datasheet.pdf"), "%PDF-1.7\nmalformed fixture"),
    Bun.write(join(malformed_dir, "job.json"), "{not json"),
    Bun.write(join(oversized_dir, "datasheet.pdf"), "%PDF-1.7\noversized fixture"),
    Bun.write(
      join(oversized_dir, "job.json"),
      `{"job_id":"oversized-job","padding":"${"x".repeat(2 * 1024 * 1024)}"}`,
    ),
    Bun.write(join(symlinked_dir, "datasheet.pdf"), "%PDF-1.7\nsymlink fixture"),
    Bun.write(symlink_target, '{"job_id":"symlinked-job","display_status":"queued"}\n'),
    Bun.write(join(markerless_publication_dir, "datasheet.pdf"), "%PDF-1.7\npublication fixture"),
    Bun.write(join(markerless_publication_dir, "published-model.json"), "{}\n"),
    Bun.write(
      join(mismatched_dir, "job.json"),
      JSON.stringify({ job_id: "some-other-job", display_status: "queued" }),
    ),
  ])
  await symlink(symlink_target, join(symlinked_dir, "job.json"))

  try {
    const job_store = new JobStore()
    const failures: Array<{ job_id: string; error_code: string; cause: string }> = []
    const result = await restorePersistedJobs({
      jobs_root,
      job_store,
      model_run_store: new ModelRunStore(),
      on_restore_error: (failure) => {
        failures.push(failure)
      },
    })
    expect(result.jobs_restored).toBe(0)
    expect(job_store.listJobs()).toHaveLength(0)
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          job_id: "mismatched-job",
          error_code: "job_marker_identity_mismatch",
        }),
        expect.objectContaining({ job_id: "malformed-job", error_code: "job_marker_invalid" }),
        expect.objectContaining({ job_id: "oversized-job", error_code: "job_marker_invalid" }),
        expect.objectContaining({ job_id: "symlinked-job", error_code: "job_marker_invalid" }),
        expect.objectContaining({
          job_id: "markerless-publication",
          error_code: "job_marker_missing_with_publication",
        }),
      ]),
    )
    expect(failures).toHaveLength(5)
    const directoryExists = (path: string) =>
      stat(path)
        .then(() => true)
        .catch(() => false)
    expect(await directoryExists(tombstone)).toBe(false)
    expect(await directoryExists(staging_dir)).toBe(false)
    expect(await directoryExists(partial_dir)).toBe(true)
    expect(await directoryExists(mismatched_dir)).toBe(true)
    expect(await directoryExists(malformed_dir)).toBe(true)
    expect(await directoryExists(oversized_dir)).toBe(true)
    expect(await directoryExists(symlinked_dir)).toBe(true)
    expect(await directoryExists(markerless_publication_dir)).toBe(true)
  } finally {
    await rm(jobs_root, { recursive: true, force: true })
  }
})

test("restore fails loudly when the jobs root cannot be read", async () => {
  const parent = await mkdtemp(join(tmpdir(), "datasheet-missing-jobs-root-"))
  try {
    await expect(
      restorePersistedJobs({
        jobs_root: join(parent, "missing"),
        job_store: new JobStore(),
        model_run_store: new ModelRunStore(),
      }),
    ).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

test("one corrupt persisted job cannot prevent a healthy sibling from restoring", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-isolated-restore-"))
  const healthy_dir = join(jobs_root, "healthy-job")
  const corrupt_dir = join(jobs_root, "corrupt-job")
  await Promise.all([mkdir(healthy_dir, { recursive: true }), mkdir(corrupt_dir, { recursive: true })])
  await Promise.all([
    Bun.write(join(healthy_dir, "datasheet.pdf"), "%PDF-1.7\nhealthy fixture"),
    Bun.write(join(corrupt_dir, "datasheet.pdf"), "%PDF-1.7\ncorrupt fixture"),
  ])
  const original_jobs = new JobStore()
  original_jobs.createJob({
    job_id: "healthy-job",
    job_dir: healthy_dir,
    file_name: "healthy.pdf",
  })
  original_jobs.updateJob("healthy-job", {
    display_status: "failed",
    is_complete: true,
    has_errors: true,
    error_message: "healthy saved failure",
  })
  original_jobs.createJob({
    job_id: "corrupt-job",
    job_dir: corrupt_dir,
    file_name: "corrupt.pdf",
  })
  await Bun.write(join(corrupt_dir, "published-model.json"), '{"version":1}\n')

  try {
    const failures: Array<{ job_id: string; cause: string }> = []
    const restored_jobs = new JobStore()
    const result = await restorePersistedJobs({
      jobs_root,
      job_store: restored_jobs,
      model_run_store: new ModelRunStore(),
      on_restore_error: (failure) => {
        failures.push(failure)
      },
    })

    expect(result).toEqual({ jobs_restored: 1, model_runs_restored: 0 })
    expect(restored_jobs.getJob("healthy-job")?.error_message).toBe("healthy saved failure")
    expect(restored_jobs.getJob("corrupt-job")).toBeUndefined()
    expect(failures).toHaveLength(1)
    expect(failures[0]?.job_id).toBe("corrupt-job")
    expect(failures[0]?.cause).toContain("published-model.json")
    expect(await Bun.file(join(corrupt_dir, "published-model.json")).exists()).toBe(true)
  } finally {
    await rm(jobs_root, { recursive: true, force: true })
  }
})
