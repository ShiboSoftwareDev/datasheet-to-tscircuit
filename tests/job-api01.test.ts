import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJobApiHandler } from "@/server/job-api"
import { runJob } from "@/server/component-workflow"
import type { ProcessRunRequest, ProcessRunner } from "@/server/infrastructure/process"
import { JobStore } from "@/server/job-store"
import { ModelRunStore } from "@/server/model-run-store"
import type { Job } from "@/shared/job-types"

async function writeLegacyEvidenceCommit(job_dir: string, relative_paths: string[]): Promise<void> {
  const files: Record<string, { sha256: string; size_bytes: number }> = {}
  for (const relative_path of relative_paths.sort()) {
    const bytes = new Uint8Array(await Bun.file(join(job_dir, relative_path)).arrayBuffer())
    files[relative_path] = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size_bytes: bytes.byteLength,
    }
  }
  await Bun.write(
    join(job_dir, "evidence-commit.json"),
    `${JSON.stringify({ version: 1, committed_at: new Date().toISOString(), files }, null, 2)}\n`,
  )
}

test("job create accepts a PDF and starts the injected background runner", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-"))
  const job_store = new JobStore()
  let started_job_id: string | undefined
  let started_use_openai: boolean | undefined
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_job: async (input, context) => {
      started_job_id = input.job_id
      started_use_openai = context.use_openai
    },
  })
  const form = new FormData()
  form.set("datasheet", new File(["%PDF-1.7\nfixture"], "sensor.pdf", { type: "application/pdf" }))

  const response = await handle(
    new Request("http://localhost/api/job/create", { method: "POST", body: form }),
  )
  const body = (await response?.json()) as {
    job: { job_id: string; file_name: string; use_openai?: boolean }
  }

  expect(response?.status).toBe(202)
  expect(body.job.file_name).toBe("sensor.pdf")
  expect(body.job.use_openai).toBe(false)
  expect(started_job_id).toBe(body.job.job_id)
  expect(started_use_openai).toBe(false)
  expect(await Bun.file(join(jobs_root, body.job.job_id, "datasheet.pdf")).exists()).toBe(true)
  expect((await Bun.file(join(jobs_root, body.job.job_id, "job.json")).json()).use_openai).toBe(false)
  expect(await Bun.file(join(jobs_root, body.job.job_id, "AGENTS.md")).exists()).toBe(false)

  await rm(jobs_root, { recursive: true, force: true })
})

test("component download matches the UI base source when a model pointer is missing", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-file-missing-publication-"))
  const job_id = "job_missing_publication"
  const job_dir = join(jobs_root, job_id)
  const base_component = 'export default () => <chip name="BASE" />\n'
  const unverified_wrapper = 'export default () => <chip name="WRAPPER"><spicemodel /></chip>\n'
  await mkdir(job_dir, { recursive: true })
  await Promise.all([
    Bun.write(join(job_dir, "component.circuit.tsx"), base_component),
    Bun.write(join(job_dir, "index.circuit.tsx"), unverified_wrapper),
  ])
  const job_store = new JobStore()
  job_store.createJob({ job_id, job_dir, file_name: "sensor.pdf" })
  job_store.updateJob(job_id, { component_code: base_component })
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
  })

  const ui_response = await handle(new Request(`http://localhost/api/job/get?job_id=${job_id}`))
  const ui_body = (await ui_response?.json()) as { job: { component_code?: string } }
  const download_response = await handle(
    new Request(`http://localhost/api/job/file?job_id=${job_id}&file=component`),
  )

  expect(ui_response?.status).toBe(200)
  expect(download_response?.status).toBe(200)
  expect(download_response?.headers.get("X-Tscircuit-Artifact-Warning")).toBeNull()
  expect(ui_body.job.component_code).toBe(base_component)
  expect(await download_response?.text()).toBe(ui_body.job.component_code)
  expect(ui_body.job.component_code).not.toBe(unverified_wrapper)

  await rm(jobs_root, { recursive: true, force: true })
})

test("component download matches the UI base source when a model pointer is corrupt", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-file-corrupt-publication-"))
  const job_id = "job_corrupt_publication"
  const job_dir = join(jobs_root, job_id)
  const base_component = 'export default () => <chip name="BASE" />\n'
  const unverified_wrapper = 'export default () => <chip name="WRAPPER"><spicemodel /></chip>\n'
  await mkdir(job_dir, { recursive: true })
  await Promise.all([
    Bun.write(join(job_dir, "component.circuit.tsx"), base_component),
    Bun.write(join(job_dir, "index.circuit.tsx"), unverified_wrapper),
    Bun.write(join(job_dir, "published-model.json"), '{"version":1}\n'),
  ])
  const job_store = new JobStore()
  job_store.createJob({ job_id, job_dir, file_name: "sensor.pdf" })
  job_store.updateJob(job_id, {
    component_code: base_component,
    has_errors: true,
    error_message: "Committed model publication failed integrity validation.",
  })
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
  })

  const ui_response = await handle(new Request(`http://localhost/api/job/get?job_id=${job_id}`))
  const ui_body = (await ui_response?.json()) as { job: { component_code?: string } }
  const download_response = await handle(
    new Request(`http://localhost/api/job/file?job_id=${job_id}&file=component`),
  )

  expect(ui_response?.status).toBe(200)
  expect(download_response?.status).toBe(200)
  expect(download_response?.headers.get("X-Tscircuit-Artifact-Warning")).toBe("accepted_publication_invalid")
  expect(ui_body.job.component_code).toBe(base_component)
  expect(await download_response?.text()).toBe(ui_body.job.component_code)
  expect(ui_body.job.component_code).not.toBe(unverified_wrapper)

  await rm(jobs_root, { recursive: true, force: true })
})

test("component fallback rejects unsafe preserved sources before using a legacy index", async () => {
  const fixture_root = await mkdtemp(join(tmpdir(), "datasheet-job-file-safe-component-"))
  const jobs_root = join(fixture_root, "jobs")
  const job_id = "job_safe_component"
  const job_dir = join(jobs_root, job_id)
  const base_path = join(job_dir, "component.circuit.tsx")
  const outside_path = join(fixture_root, "outside.circuit.tsx")
  const legacy_component = 'export default () => <chip name="LEGACY" />\n'
  const outside_component = 'export default () => <chip name="OUTSIDE" />\n'
  await mkdir(job_dir, { recursive: true })
  await Promise.all([
    Bun.write(join(job_dir, "index.circuit.tsx"), legacy_component),
    Bun.write(outside_path, outside_component),
  ])
  await symlink(outside_path, base_path)
  const job_store = new JobStore()
  job_store.createJob({ job_id, job_dir, file_name: "sensor.pdf" })
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
  })

  const linked_response = await handle(
    new Request(`http://localhost/api/job/file?job_id=${job_id}&file=component`),
  )
  expect(linked_response?.status).toBe(404)
  expect(await Bun.file(outside_path).text()).toBe(outside_component)

  await rm(base_path)
  await Bun.write(base_path, "x".repeat(2 * 1024 * 1024 + 1))
  const oversized_response = await handle(
    new Request(`http://localhost/api/job/file?job_id=${job_id}&file=component`),
  )
  expect(oversized_response?.status).toBe(404)

  await rm(base_path)
  const legacy_response = await handle(
    new Request(`http://localhost/api/job/file?job_id=${job_id}&file=component`),
  )
  expect(legacy_response?.status).toBe(200)
  expect(await legacy_response?.text()).toBe(legacy_component)

  await rm(fixture_root, { recursive: true, force: true })
})

test("job creation removes a published workspace when durable registration fails", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-create-rollback-"))
  const job_store = new JobStore({
    checkpoint_writer() {
      throw new Error("checkpoint fixture failed")
    },
  })
  let started = false
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_job: async () => {
      started = true
    },
  })
  const form = new FormData()
  form.set("datasheet", new File(["%PDF-1.7\nfixture"], "sensor.pdf", { type: "application/pdf" }))

  const response = await handle(
    new Request("http://localhost/api/job/create", { method: "POST", body: form }),
  )
  const body = (await response?.json()) as { error: { error_code: string; message: string } }

  expect(response?.status).toBe(500)
  expect(body.error.error_code).toBe("job_create_failed")
  expect(body.error.message).toContain("checkpoint fixture failed")
  expect(job_store.listJobs()).toHaveLength(0)
  expect(await readdir(jobs_root)).toEqual([])
  expect(started).toBe(false)

  await rm(jobs_root, { recursive: true, force: true })
})

test("job creation reports private-workspace setup failures without exposing a task", async () => {
  const fixture_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-create-filesystem-"))
  const jobs_root = join(fixture_root, "jobs-root-is-a-file")
  await Bun.write(jobs_root, "fixture")
  const job_store = new JobStore()
  let started = false
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_job: async () => {
      started = true
    },
  })
  const form = new FormData()
  form.set("datasheet", new File(["%PDF-1.7\nfixture"], "sensor.pdf", { type: "application/pdf" }))

  const response = await handle(
    new Request("http://localhost/api/job/create", { method: "POST", body: form }),
  )
  const body = (await response?.json()) as { error: { error_code: string; message: string } }

  expect(response?.status).toBe(500)
  expect(body.error.error_code).toBe("job_create_failed")
  expect(body.error.message).toContain("creating the private workspace")
  expect(job_store.listJobs()).toHaveLength(0)
  expect(started).toBe(false)
  expect(await Bun.file(jobs_root).text()).toBe("fixture")

  await rm(fixture_root, { recursive: true, force: true })
})

test("an unauthenticated OpenAI request returns the login instruction without creating a job", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-openai-auth-"))
  const job_store = new JobStore()
  let started = false
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: join(jobs_root, "missing-agent"),
    tsci_bin: "unused-tsci",
    run_job: async () => {
      started = true
    },
  })
  const form = new FormData()
  form.set("datasheet", new File(["%PDF-1.7\nfixture"], "sensor.pdf", { type: "application/pdf" }))
  form.set("use_openai", "true")

  const response = await handle(
    new Request("http://localhost/api/job/create", { method: "POST", body: form }),
  )
  const body = (await response?.json()) as { error: { error_code: string; message: string } }

  expect(response?.status).toBe(409)
  expect(body.error.error_code).toBe("openai_auth_required")
  expect(body.error.message).toContain("bun run auth:openai")
  expect(job_store.listJobs()).toHaveLength(0)
  expect(started).toBe(false)

  await rm(jobs_root, { recursive: true, force: true })
})

test("OpenAI authentication uses the supervised command runner with tight output and time limits", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-openai-auth-runner-"))
  const job_store = new JobStore()
  let auth_request: ProcessRunRequest | undefined
  const process_runner: ProcessRunner = {
    async run(request) {
      auth_request = request
      await request.on_output?.("stdout", "OpenAI credentials are stored.\n")
      return { exit_code: 0, duration_ms: 1, output_tail: "OpenAI credentials are stored.\n" }
    },
  }
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "fixture-agent",
    tsci_bin: "unused-tsci",
    process_runner,
    run_job: async () => undefined,
  })
  const form = new FormData()
  form.set("datasheet", new File(["%PDF-1.7\nfixture"], "sensor.pdf", { type: "application/pdf" }))
  form.set("use_openai", "true")

  const response = await handle(
    new Request("http://localhost/api/job/create", { method: "POST", body: form }),
  )

  expect(response?.status).toBe(202)
  expect(auth_request?.command).toEqual(["fixture-agent", "auth", "status", "--openai"])
  expect(auth_request?.idle_timeout_ms).toBe(2_000)
  expect(auth_request?.wall_timeout_ms).toBe(5_000)
  expect(auth_request?.max_output_chars).toBe(16_000)
  await rm(jobs_root, { recursive: true, force: true })
})

test("an unexpected background runner rejection is contained as a failed job", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-runner-rejection-"))
  const job_store = new JobStore()
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_job: async () => {
      throw new Error("runner fixture crashed")
    },
  })
  const form = new FormData()
  form.set("datasheet", new File(["%PDF-1.7\nfixture"], "sensor.pdf", { type: "application/pdf" }))

  const response = await handle(
    new Request("http://localhost/api/job/create", { method: "POST", body: form }),
  )
  const body = (await response?.json()) as { job: { job_id: string } }
  await Bun.sleep(10)
  const job = job_store.getJob(body.job.job_id)

  expect(response?.status).toBe(202)
  expect(job?.display_status).toBe("failed")
  expect(job?.is_complete).toBe(true)
  expect(job?.error_message).toBe("runner fixture crashed")
  expect(job?.logs.some((entry) => entry.message.includes("unexpected runner failure"))).toBe(true)

  await rm(jobs_root, { recursive: true, force: true })
})

test("an unexpected runner failure never promotes evidence or an intermediate preview", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-runner-intermediate-"))
  const job_store = new JobStore()
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_job: async ({ job_id }, context) => {
      context.job_store.updateJob(job_id, {
        evidence_available: true,
        component_code: "export default () => <chip />",
        circuit_json: [{ type: "source_component", source_component_id: "candidate" }] as Job["circuit_json"],
      })
      throw new Error("runner failed before the component commit")
    },
  })
  const form = new FormData()
  form.set("datasheet", new File(["%PDF-1.7\nfixture"], "sensor.pdf", { type: "application/pdf" }))

  const response = await handle(
    new Request("http://localhost/api/job/create", { method: "POST", body: form }),
  )
  const body = (await response?.json()) as { job: { job_id: string } }
  await Bun.sleep(10)
  const job = job_store.getJob(body.job.job_id)

  expect(job?.display_status).toBe("failed")
  expect(job?.has_errors).toBe(true)
  expect(job?.error_message).toBe("runner failed before the component commit")

  await rm(jobs_root, { recursive: true, force: true })
})

test("an unexpected runner failure preserves only an explicitly committed component milestone", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-runner-committed-"))
  const job_store = new JobStore()
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_job: async ({ job_id }, context) => {
      context.job_store.updateJob(job_id, {
        component_ready: true,
        component_code: "export default () => <chip />",
        circuit_json: [{ type: "source_component", source_component_id: "accepted" }] as Job["circuit_json"],
      })
      throw new Error("runner failed after the component commit")
    },
  })
  const form = new FormData()
  form.set("datasheet", new File(["%PDF-1.7\nfixture"], "sensor.pdf", { type: "application/pdf" }))

  const response = await handle(
    new Request("http://localhost/api/job/create", { method: "POST", body: form }),
  )
  const body = (await response?.json()) as { job: { job_id: string } }
  await Bun.sleep(10)
  const job = job_store.getJob(body.job.job_id)

  expect(job?.display_status).toBe("complete")
  expect(job?.has_errors).toBe(false)
  expect(job?.warnings?.some((warning) => warning.includes("runner failed after"))).toBe(true)

  await rm(jobs_root, { recursive: true, force: true })
})

test("job create launches component and SPICE work even when model lifecycle logging fails", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-model-"))
  const job_store = new JobStore()
  const model_run_store = new ModelRunStore({
    log_writer: async () => {
      throw new Error("fixture model log observer failed")
    },
  })
  let component_job_id: string | undefined
  let model_run_id: string | undefined
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    model_run_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_job: async (input) => {
      component_job_id = input.job_id
    },
    run_model: async (input) => {
      model_run_id = input.model_run_id
    },
  })
  const form = new FormData()
  form.set("datasheet", new File(["%PDF-1.7\nfixture"], "sensor.pdf", { type: "application/pdf" }))
  form.set("create_pspice_model", "true")
  form.set("model_effort_multiplier", "4")

  const response = await handle(
    new Request("http://localhost/api/job/create", { method: "POST", body: form }),
  )
  const body = (await response?.json()) as {
    job: { job_id: string }
    model_run: { model_run_id: string; effort_multiplier: number; elapsed_time_ms: number }
  }

  expect(response?.status).toBe(202)
  expect(component_job_id).toBe(body.job.job_id)
  expect(model_run_id).toBe(body.model_run.model_run_id)
  expect(body.model_run.effort_multiplier).toBe(4)
  expect(body.model_run.elapsed_time_ms).toBe(0)

  await rm(jobs_root, { recursive: true, force: true })
})

test("job list responses and events include component and compact model-run state", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-summaries-"))
  const job_dir = join(jobs_root, "job_summary")
  const model_dir = join(job_dir, "spice")
  await mkdir(model_dir, { recursive: true })
  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_summary", job_dir, file_name: "sensor.pdf" })
  job_store.updateJob("job_summary", { component_ready: true })
  model_run_store.createModelRun({
    model_run_id: "model_summary",
    job_id: "job_summary",
    model_dir,
    effort_multiplier: 1,
  })
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    model_run_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
  })

  const list_response = await handle(new Request("http://localhost/api/jobs"))
  const list_body = (await list_response?.json()) as {
    jobs: Array<{
      component_ready?: boolean
      model_run?: { status: string; has_model: boolean; model_source?: string }
    }>
  }
  expect(list_body.jobs[0]).toMatchObject({
    component_ready: true,
    model_run: { status: "queued", has_model: false },
  })
  expect(list_body.jobs[0]?.model_run).not.toHaveProperty("model_source")

  const events_response = await handle(new Request("http://localhost/api/jobs/events"))
  const reader = events_response?.body?.getReader()
  if (!reader) throw new Error("Expected a job-list event stream")
  const initial_chunk = await reader.read()
  const initial_event = JSON.parse(new TextDecoder().decode(initial_chunk.value).replace(/^data: /, "")) as {
    event_type: string
    jobs: Array<{ model_run?: { status: string } }>
  }
  expect(initial_event).toMatchObject({
    event_type: "jobs_snapshot",
    jobs: [{ component_ready: true, model_run: { status: "queued", has_model: false } }],
  })

  model_run_store.updateModelRun("model_summary", {
    status: "complete",
    is_complete: true,
    has_errors: false,
    model_source: ".SUBCKT SUMMARY IN OUT\n.ENDS SUMMARY\n",
  })
  const updated_chunk = await reader.read()
  const updated_event = JSON.parse(new TextDecoder().decode(updated_chunk.value).replace(/^data: /, "")) as {
    event_type: string
    job: { model_run?: { status: string; has_model: boolean } }
  }
  expect(updated_event).toMatchObject({
    event_type: "job_updated",
    job: { component_ready: true, model_run: { status: "complete", has_model: true } },
  })
  await reader.cancel()
  await rm(jobs_root, { recursive: true, force: true })
})

test("job cancel requests cancellation without stopping the server", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-cancel-"))
  const job_store = new JobStore()
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
  })
  job_store.createJob({ job_id: "job_cancel", job_dir: jobs_root, file_name: "sensor.pdf" })

  const response = await handle(
    new Request("http://localhost/api/job/cancel?job_id=job_cancel", { method: "POST" }),
  )
  const body = (await response?.json()) as { job: { display_status: string; is_complete: boolean } }

  expect(response?.status).toBe(202)
  expect(body.job.display_status).toBe("cancelling")
  expect(body.job.is_complete).toBe(false)
  expect(job_store.getCancellationSignal("job_cancel")?.aborted).toBe(true)

  await rm(jobs_root, { recursive: true, force: true })
})

test("multiple uploads start independently and appear in the jobs list", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-multiple-"))
  const job_store = new JobStore()
  const started_job_ids: string[] = []
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_job: async (input) => {
      started_job_ids.push(input.job_id)
    },
  })

  const upload = (file_name: string) => {
    const form = new FormData()
    form.set("datasheet", new File(["%PDF-1.7\nfixture"], file_name, { type: "application/pdf" }))
    return handle(new Request("http://localhost/api/job/create", { method: "POST", body: form }))
  }

  const [first_response, second_response] = await Promise.all([upload("first.pdf"), upload("second.pdf")])
  const list_response = await handle(new Request("http://localhost/api/jobs"))
  const list_body = (await list_response?.json()) as { jobs: Array<{ job_id: string; logs?: unknown }> }

  expect(first_response?.status).toBe(202)
  expect(second_response?.status).toBe(202)
  expect(started_job_ids).toHaveLength(2)
  expect(new Set(started_job_ids).size).toBe(2)
  expect(list_body.jobs).toHaveLength(2)
  expect(list_body.jobs.every((job) => !("logs" in job))).toBe(true)

  await rm(jobs_root, { recursive: true, force: true })
})

test("retained evidence is downloadable", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-evidence-files-"))
  const job_dir = join(jobs_root, "evidence_job")
  await mkdir(join(job_dir, "visual-reference", "pages"), { recursive: true })
  await Promise.all([
    Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nfixture"),
    Bun.write(
      join(job_dir, "component-evidence.json"),
      JSON.stringify({
        status: "unresolved",
        pinout: {
          pins: [
            { sources: [{ image: "visual-reference/pages/page-004.png" }] },
            { sources: [{ image: "visual-reference/pages/page-004.png" }] },
            { sources: [{ image: "visual-reference/pages/page-007.png" }] },
          ],
        },
      }),
    ),
    Bun.write(join(job_dir, "footprint-plan.json"), '{"pads":[]}\n'),
    Bun.write(join(job_dir, "component-schematic-plan.json"), '{"version":1}\n'),
    Bun.write(join(job_dir, "typical-application-plan.json"), '{"availability":"documented"}\n'),
    Bun.write(join(job_dir, "visual-reference", "land-pattern.png"), "png fixture"),
    Bun.write(join(job_dir, "visual-reference", "typical-application.png"), "application fixture"),
    Bun.write(join(job_dir, "visual-reference", "pages", "page-004.png"), "pinout fixture"),
    Bun.write(join(job_dir, "visual-reference", "pages", "page-007.png"), "other fixture"),
  ])
  const job_store = new JobStore()
  job_store.createJob({ job_id: "evidence_job", job_dir, file_name: "device.pdf" })
  job_store.updateJob("evidence_job", {
    display_status: "unsupported",
    is_complete: true,
    evidence_available: true,
  })
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_job: async () => undefined,
  })

  const expected_downloads = [
    ["component_evidence", "unresolved"],
    ["footprint_plan", "pads"],
    ["application_plan", "documented"],
    ["land_pattern", "png fixture"],
    ["component_schematic_reference", "pinout fixture"],
    ["application_reference", "application fixture"],
  ] as const

  for (const [file] of expected_downloads) {
    const response = await handle(
      new Request(`http://localhost/api/job/file?job_id=evidence_job&file=${file}`),
    )
    expect(response?.status).toBe(404)
  }

  await writeLegacyEvidenceCommit(job_dir, [
    "component-evidence.json",
    "footprint-plan.json",
    "component-schematic-plan.json",
    "typical-application-plan.json",
    "visual-reference/land-pattern.png",
    "visual-reference/typical-application.png",
    "visual-reference/pages/page-004.png",
    "visual-reference/pages/page-007.png",
  ])

  for (const [file, expected] of expected_downloads) {
    const response = await handle(
      new Request(`http://localhost/api/job/file?job_id=evidence_job&file=${file}`),
    )
    expect(response?.status).toBe(200)
    expect(await response?.text()).toContain(expected)
  }

  await Bun.write(join(job_dir, "visual-reference", "pages", "page-007.png"), "tampered fixture")
  const tampered_response = await handle(
    new Request("http://localhost/api/job/file?job_id=evidence_job&file=component_evidence"),
  )
  expect(tampered_response?.status).toBe(500)
  expect(await tampered_response?.json()).toMatchObject({
    error: { error_code: "artifact_resolution_failed" },
  })

  const retry_response = await handle(
    new Request("http://localhost/api/job/retry?job_id=evidence_job", { method: "POST" }),
  )
  expect(retry_response?.status).toBe(202)

  await rm(jobs_root, { recursive: true, force: true })
})

test("a stopped task can be retried with its original PDF and instructions, then deleted", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-retry-"))
  const job_store = new JobStore()
  const started_jobs: Array<{ job_id: string; additional_instructions?: string }> = []
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_job: async (input) => {
      started_jobs.push(input)
    },
  })
  const form = new FormData()
  form.set("datasheet", new File(["%PDF-1.7\nretry fixture"], "sensor.pdf", { type: "application/pdf" }))
  form.set("additional_instructions", "Use the QFN package")

  const create_response = await handle(
    new Request("http://localhost/api/job/create", { method: "POST", body: form }),
  )
  const created_body = (await create_response?.json()) as { job: { job_id: string } }
  job_store.updateJob(created_body.job.job_id, { display_status: "cancelled", is_complete: true })

  const [retry_response, duplicate_retry_response] = await Promise.all([
    handle(
      new Request(`http://localhost/api/job/retry?job_id=${created_body.job.job_id}`, {
        method: "POST",
      }),
    ),
    handle(
      new Request(`http://localhost/api/job/retry?job_id=${created_body.job.job_id}`, {
        method: "POST",
      }),
    ),
  ])
  const retry_body = (await retry_response?.json()) as { job: { job_id: string } }
  const duplicate_retry_body = (await duplicate_retry_response?.json()) as {
    job: { job_id: string }
  }
  const retried_pdf = join(jobs_root, retry_body.job.job_id, "datasheet.pdf")

  expect(retry_response?.status).toBe(202)
  expect(duplicate_retry_response?.status).toBe(202)
  expect(retry_body.job.job_id).not.toBe(created_body.job.job_id)
  expect(duplicate_retry_body.job.job_id).toBe(retry_body.job.job_id)
  expect(started_jobs).toHaveLength(2)
  expect(started_jobs[1]?.additional_instructions).toBe("Use the QFN package")
  expect(await Bun.file(retried_pdf).text()).toContain("retry fixture")
  expect(JSON.parse(await Bun.file(join(jobs_root, retry_body.job.job_id, "job.json")).text())).toMatchObject(
    { retry_source_job_id: created_body.job.job_id },
  )

  job_store.updateJob(retry_body.job.job_id, { display_status: "complete", is_complete: true })
  const delete_response = await handle(
    new Request(`http://localhost/api/job/delete?job_id=${retry_body.job.job_id}`, { method: "DELETE" }),
  )
  expect(delete_response?.status).toBe(204)
  expect(job_store.getJob(retry_body.job.job_id)).toBeUndefined()
  expect(await Bun.file(retried_pdf).exists()).toBe(false)

  await rm(jobs_root, { recursive: true, force: true })
})

test("a source that starts deleting during retry setup cannot publish or launch the retry", async () => {
  class DeletingDuringRetryStore extends JobStore {
    private retry_source_reads = 0

    override getJobRetrySource(job_id: string) {
      const source = super.getJobRetrySource(job_id)
      this.retry_source_reads += 1
      if (this.retry_source_reads === 2) this.acquireJobDeletionLease(job_id)
      return source
    }
  }

  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-retry-delete-race-"))
  const source_dir = join(jobs_root, "failed_source")
  await mkdir(source_dir, { recursive: true })
  await Bun.write(join(source_dir, "datasheet.pdf"), "%PDF-1.7\nfailed fixture")
  const job_store = new DeletingDuringRetryStore()
  job_store.createJob({
    job_id: "failed_source",
    job_dir: source_dir,
    file_name: "sensor.pdf",
    use_openai: false,
  })
  job_store.updateJob("failed_source", {
    display_status: "failed",
    is_complete: true,
    has_errors: true,
  })
  let started = false
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_job: async () => {
      started = true
    },
  })

  const response = await handle(
    new Request("http://localhost/api/job/retry?job_id=failed_source", { method: "POST" }),
  )
  const body = (await response?.json()) as { error: { error_code: string } }

  expect(response?.status).toBe(409)
  expect(body.error.error_code).toBe("job_deleting")
  expect(job_store.listJobs()).toHaveLength(1)
  expect(await readdir(jobs_root)).toEqual(["failed_source"])
  expect(started).toBe(false)

  await rm(jobs_root, { recursive: true, force: true })
})

test("retry setup failures remove their private workspace and never register a task", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-retry-rollback-"))
  const source_dir = join(jobs_root, "failed_source")
  await mkdir(source_dir, { recursive: true })
  const job_store = new JobStore()
  job_store.createJob({
    job_id: "failed_source",
    job_dir: source_dir,
    file_name: "sensor.pdf",
    use_openai: false,
  })
  job_store.updateJob("failed_source", {
    display_status: "failed",
    is_complete: true,
    has_errors: true,
  })
  let started = false
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_job: async () => {
      started = true
    },
  })

  const response = await handle(
    new Request("http://localhost/api/job/retry?job_id=failed_source", { method: "POST" }),
  )
  const body = (await response?.json()) as { error: { error_code: string; message: string } }

  expect(response?.status).toBe(500)
  expect(body.error.error_code).toBe("job_retry_failed")
  expect(body.error.message).toContain("datasheet.pdf")
  expect(job_store.listJobs()).toHaveLength(1)
  expect(await readdir(jobs_root)).toEqual(["failed_source"])
  expect(started).toBe(false)

  await rm(jobs_root, { recursive: true, force: true })
})

test("a failed task can be retried just like a stopped task", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-retry-failed-"))
  const source_dir = join(jobs_root, "failed_job")
  await mkdir(source_dir, { recursive: true })
  await Bun.write(join(source_dir, "datasheet.pdf"), "%PDF-1.7\nfailed fixture")
  const job_store = new JobStore()
  job_store.createJob({
    job_id: "failed_job",
    job_dir: source_dir,
    file_name: "failed-sensor.pdf",
    use_openai: true,
    additional_instructions: "Preserve the exposed pad",
  })
  job_store.updateJob("failed_job", {
    display_status: "failed",
    is_complete: true,
    has_errors: true,
  })
  const started_jobs: Array<{ job_id: string; use_openai?: boolean }> = []
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_job: async ({ job_id }, context) => {
      started_jobs.push({ job_id, use_openai: context.use_openai })
    },
  })

  const response = await handle(
    new Request("http://localhost/api/job/retry?job_id=failed_job&use_openai=false", {
      method: "POST",
    }),
  )
  const body = (await response?.json()) as { job: { job_id: string; use_openai?: boolean } }
  expect(response?.status).toBe(202)
  expect(body.job.job_id).not.toBe("failed_job")
  expect(body.job.use_openai).toBe(true)
  expect(started_jobs).toEqual([{ job_id: body.job.job_id, use_openai: true }])
  expect((await Bun.file(join(jobs_root, body.job.job_id, "job.json")).json()).use_openai).toBe(true)
  expect(await Bun.file(join(jobs_root, body.job.job_id, "datasheet.pdf")).text()).toContain("failed fixture")

  job_store.updateJob(body.job.job_id, {
    display_status: "failed",
    is_complete: true,
    has_errors: true,
  })
  const nested_response = await handle(
    new Request(`http://localhost/api/job/retry?job_id=${body.job.job_id}&use_openai=false`, {
      method: "POST",
    }),
  )
  const nested_body = (await nested_response?.json()) as {
    job: { job_id: string; use_openai?: boolean }
  }
  expect(nested_body.job.use_openai).toBe(true)
  expect(started_jobs.at(-1)).toEqual({ job_id: nested_body.job.job_id, use_openai: true })

  await rm(jobs_root, { recursive: true, force: true })
})

test("a legacy failed task adopts the saved UI provider for its retry lineage", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-retry-legacy-provider-"))
  const source_dir = join(jobs_root, "legacy_failed_job")
  await mkdir(source_dir, { recursive: true })
  await Bun.write(join(source_dir, "datasheet.pdf"), "%PDF-1.7\nlegacy failed fixture")
  const job_store = new JobStore()
  job_store.createJob({
    job_id: "legacy_failed_job",
    job_dir: source_dir,
    file_name: "legacy-sensor.pdf",
  })
  job_store.updateJob("legacy_failed_job", {
    display_status: "failed",
    is_complete: true,
    has_errors: true,
  })
  const providers: Array<boolean | undefined> = []
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_job: async (_input, context) => {
      providers.push(context.use_openai)
    },
  })

  const response = await handle(
    new Request("http://localhost/api/job/retry?job_id=legacy_failed_job&use_openai=true", {
      method: "POST",
    }),
  )
  const body = (await response?.json()) as { job: { use_openai?: boolean } }

  expect(response?.status).toBe(202)
  expect(body.job.use_openai).toBe(true)
  expect(providers).toEqual([true])
  expect(job_store.getJob("legacy_failed_job")?.use_openai).toBe(true)
  expect((await Bun.file(join(source_dir, "job.json")).json()).use_openai).toBe(true)

  await rm(jobs_root, { recursive: true, force: true })
})

test("deleting an active task stops its process before removing the job", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-delete-active-"))
  const job_dir = join(jobs_root, "job_active")
  const agent_path = join(job_dir, "slow-agent")
  await mkdir(job_dir, { recursive: true })
  await Bun.write(join(job_dir, "datasheet.pdf"), "fake datasheet")
  await Bun.write(
    agent_path,
    `#!/usr/bin/env bun
console.log("active delete agent started")
await Bun.sleep(30_000)
`,
  )
  await chmod(agent_path, 0o755)

  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_active", job_dir, file_name: "sensor.pdf" })
  const context = { jobs_root, job_store, agent_bin: agent_path, tsci_bin: "unused-tsci" }
  const run_promise = runJob({ job_id: "job_active" }, context)

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Agent did not start")), 2_000)
    const unsubscribe = job_store.subscribe("job_active", (job_event) => {
      if (job_event.event_type === "log" && job_event.log.message.includes("active delete agent started")) {
        clearTimeout(timeout)
        unsubscribe?.()
        resolve()
      }
    })
  })

  const handle = createJobApiHandler(context)
  const delete_response = await handle(
    new Request("http://localhost/api/job/delete?job_id=job_active", { method: "DELETE" }),
  )
  await run_promise

  expect(delete_response?.status).toBe(204)
  expect(job_store.getJob("job_active")).toBeUndefined()
  expect(await Bun.file(agent_path).exists()).toBe(false)

  await rm(jobs_root, { recursive: true, force: true })
})

test("a failed pre-tombstone delete releases its private deletion lease", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-delete-lease-failure-"))
  const job_dir = join(jobs_root, "job_delete_failure")
  const job_store = new JobStore()
  job_store.createJob({
    job_id: "job_delete_failure",
    job_dir,
    file_name: "sensor.pdf",
  })
  job_store.updateJob("job_delete_failure", {
    display_status: "complete",
    is_complete: true,
  })
  await rm(job_dir, { recursive: true, force: true })
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
  })

  const response = await handle(
    new Request("http://localhost/api/job/delete?job_id=job_delete_failure", { method: "DELETE" }),
  )

  expect(response?.status).toBe(500)
  expect(job_store.getJob("job_delete_failure")).toBeDefined()
  expect(job_store.isJobDeleting("job_delete_failure")).toBe(false)
  const reacquired = job_store.acquireJobDeletionLease("job_delete_failure")
  expect(reacquired.status).toBe("acquired")
  if (reacquired.status === "acquired") {
    expect(job_store.releaseJobDeletionLease(reacquired.lease)).toBe(true)
  }
  await rm(jobs_root, { recursive: true, force: true })
})
