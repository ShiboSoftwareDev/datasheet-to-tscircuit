import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJobApiHandler } from "@/server/job-api"
import { JobStore } from "@/server/job-store"
import { createModelRunApiHandler, launchModelRun } from "@/server/model-run-api"
import { ModelRunStore } from "@/server/model-run-store"

function controlledJsonRequest(url: string, body: object): { request: Request; release: () => void } {
  let release: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  const request = new Request(url, { method: "POST" })
  Object.defineProperty(request, "json", {
    value: async () => {
      await ready
      return body
    },
  })
  return { request, release }
}

test("model API starts and extends the same fixed run using a repair budget", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-api-"))
  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({
    job_id: "job_1",
    job_dir,
    file_name: "sensor.pdf",
    use_openai: true,
  })
  job_store.updateJob("job_1", { display_status: "agent_running", is_complete: false })
  const started_run_ids: string[] = []
  const started_with_openai: Array<boolean | undefined> = []
  const handle = createModelRunApiHandler({
    job_store,
    model_run_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    use_openai: false,
    run_model: async ({ model_run_id }, context) => {
      started_run_ids.push(model_run_id)
      started_with_openai.push(context.use_openai)
    },
  })

  const create_response = await handle(
    new Request("http://localhost/api/model-run/create?job_id=job_1&use_openai=false", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ effort_multiplier: 2 }),
    }),
  )
  const created = (await create_response?.json()) as { model_run: { model_run_id: string } }
  const extend_response = await handle(
    new Request("http://localhost/api/model-run/extend?job_id=job_1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ additional_effort: 1 }),
    }),
  )
  const extended = (await extend_response?.json()) as {
    model_run: { model_run_id: string; effort_multiplier: number }
  }

  expect(create_response?.status).toBe(202)
  expect(extend_response?.status).toBe(202)
  expect(extended.model_run.model_run_id).toBe(created.model_run.model_run_id)
  expect(extended.model_run.effort_multiplier).toBe(3)
  expect(extended.model_run).toMatchObject({ use_openai: true })
  expect(started_run_ids).toEqual([created.model_run.model_run_id])
  expect(started_with_openai).toEqual([true])

  const excessive_extend_response = await handle(
    new Request("http://localhost/api/model-run/extend?job_id=job_1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ additional_effort: 6 }),
    }),
  )
  expect(excessive_extend_response?.status).toBe(400)
  expect(await excessive_extend_response?.json()).toEqual({
    error: {
      error_code: "invalid_effort",
      message: "The total repair budget cannot exceed 8×; this run already has 3×.",
    },
  })
  expect(model_run_store.getModelRun(created.model_run.model_run_id)?.effort_multiplier).toBe(3)

  model_run_store.updateModelRun(created.model_run.model_run_id, {
    status: "failed",
    is_complete: true,
    has_errors: true,
    error_message: "fixture failure",
  })
  const retry_response = await handle(
    new Request("http://localhost/api/model-run/retry?job_id=job_1", { method: "POST" }),
  )
  const retried = (await retry_response?.json()) as {
    model_run: { model_run_id: string; status: string; effort_multiplier: number }
  }
  expect(retry_response?.status).toBe(202)
  expect(retried.model_run.model_run_id).toBe(created.model_run.model_run_id)
  expect(retried.model_run.status).toBe("queued")
  expect(retried.model_run.effort_multiplier).toBe(3)
  expect(started_run_ids).toEqual([created.model_run.model_run_id, created.model_run.model_run_id])
  expect(started_with_openai).toEqual([true, true])

  model_run_store.updateModelRun(created.model_run.model_run_id, {
    status: "complete",
    is_complete: true,
    has_errors: false,
  })
  const request_context_without_provider = createModelRunApiHandler({
    job_store,
    model_run_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_model: async (_input, context) => {
      started_with_openai.push(context.use_openai)
    },
  })
  await request_context_without_provider(
    new Request("http://localhost/api/model-run/extend?job_id=job_1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ additional_effort: 1 }),
    }),
  )
  expect(started_with_openai).toEqual([true, true, true])

  await rm(job_dir, { recursive: true, force: true })
})

test("model API retries a stopped run without adding repair budget", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-api-stopped-retry-"))
  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_stopped", job_dir, file_name: "sensor.pdf" })
  model_run_store.createModelRun({
    model_run_id: "model_stopped",
    job_id: "job_stopped",
    model_dir: join(job_dir, "spice"),
    effort_multiplier: 8,
  })
  model_run_store.finishSegment("model_stopped", {
    status: "cancelled",
    is_complete: true,
    has_errors: false,
  })
  const started_run_ids: string[] = []
  const handle = createModelRunApiHandler({
    job_store,
    model_run_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_model: async ({ model_run_id }) => {
      started_run_ids.push(model_run_id)
    },
  })

  const response = await handle(
    new Request("http://localhost/api/model-run/retry?job_id=job_stopped", { method: "POST" }),
  )
  const body = (await response?.json()) as {
    model_run: { status: string; effort_multiplier: number }
  }

  expect(response?.status).toBe(202)
  expect(body.model_run).toMatchObject({ status: "queued", effort_multiplier: 8 })
  expect(started_run_ids).toEqual(["model_stopped"])
  await rm(job_dir, { recursive: true, force: true })
})

test("model API restarts a successful run without adding repair budget", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-api-success-restart-"))
  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_success", job_dir, file_name: "sensor.pdf" })
  model_run_store.createModelRun({
    model_run_id: "model_success",
    job_id: "job_success",
    model_dir: join(job_dir, "spice"),
    effort_multiplier: 4,
  })
  model_run_store.finishSegment("model_success", {
    status: "complete",
    is_complete: true,
    has_errors: false,
  })
  const started_run_ids: string[] = []
  const handle = createModelRunApiHandler({
    job_store,
    model_run_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_model: async ({ model_run_id }) => {
      started_run_ids.push(model_run_id)
    },
  })

  const response = await handle(
    new Request("http://localhost/api/model-run/retry?job_id=job_success", { method: "POST" }),
  )
  const body = (await response?.json()) as {
    model_run: { status: string; effort_multiplier: number }
  }

  expect(response?.status).toBe(202)
  expect(body.model_run).toMatchObject({ status: "queued", effort_multiplier: 4 })
  expect(started_run_ids).toEqual(["model_success"])
  await rm(job_dir, { recursive: true, force: true })
})

test("model lifecycle log failures cannot strand create, retry, or restarted extension", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-api-log-observer-"))
  const job_store = new JobStore()
  const model_run_store = new ModelRunStore({
    log_writer: async () => {
      throw new Error("fixture log observer failed")
    },
  })
  job_store.createJob({ job_id: "job_log_observer", job_dir, file_name: "sensor.pdf" })
  const started_run_ids: string[] = []
  const handle = createModelRunApiHandler({
    job_store,
    model_run_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_model: async ({ model_run_id }) => {
      started_run_ids.push(model_run_id)
    },
  })

  const create_response = await handle(
    new Request("http://localhost/api/model-run/create?job_id=job_log_observer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ effort_multiplier: 1 }),
    }),
  )
  const created = (await create_response?.json()) as { model_run: { model_run_id: string } }
  expect(create_response?.status).toBe(202)
  expect(started_run_ids).toEqual([created.model_run.model_run_id])

  model_run_store.finishSegment(created.model_run.model_run_id, {
    status: "failed",
    is_complete: true,
    has_errors: true,
    error_message: "fixture failure",
  })
  const retry_response = await handle(
    new Request("http://localhost/api/model-run/retry?job_id=job_log_observer", { method: "POST" }),
  )
  expect(retry_response?.status).toBe(202)
  expect(started_run_ids).toEqual([created.model_run.model_run_id, created.model_run.model_run_id])

  model_run_store.finishSegment(created.model_run.model_run_id, {
    status: "complete",
    is_complete: true,
    has_errors: false,
    error_message: undefined,
  })
  const extend_response = await handle(
    new Request("http://localhost/api/model-run/extend?job_id=job_log_observer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ additional_effort: 1 }),
    }),
  )
  expect(extend_response?.status).toBe(202)
  expect(started_run_ids).toEqual([
    created.model_run.model_run_id,
    created.model_run.model_run_id,
    created.model_run.model_run_id,
  ])

  await Bun.sleep(0)
  await rm(job_dir, { recursive: true, force: true })
})

test("a rejected retry runner is contained as a failed model run", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-api-retry-rejection-"))
  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_retry_rejection", job_dir, file_name: "sensor.pdf" })
  model_run_store.createModelRun({
    model_run_id: "model_retry_rejection",
    job_id: "job_retry_rejection",
    model_dir: join(job_dir, "spice"),
    effort_multiplier: 1,
  })
  model_run_store.finishSegment("model_retry_rejection", {
    status: "failed",
    is_complete: true,
    has_errors: true,
    error_message: "initial fixture failure",
  })
  const handle = createModelRunApiHandler({
    job_store,
    model_run_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_model: async () => {
      throw new Error("retry runner fixture rejection")
    },
  })

  const response = await handle(
    new Request("http://localhost/api/model-run/retry?job_id=job_retry_rejection", { method: "POST" }),
  )
  expect(response?.status).toBe(202)
  await Bun.sleep(10)
  expect(model_run_store.getModelRun("model_retry_rejection")).toMatchObject({
    status: "failed",
    is_complete: true,
    has_errors: true,
    error_message: "retry runner fixture rejection",
  })

  await rm(job_dir, { recursive: true, force: true })
})

test("model API resolves concurrent create and extend requests with typed conflicts", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-api-races-"))
  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_race", job_dir, file_name: "sensor.pdf" })
  const started_run_ids: string[] = []
  const handle = createModelRunApiHandler({
    job_store,
    model_run_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_model: async ({ model_run_id }) => {
      started_run_ids.push(model_run_id)
    },
  })
  const create = () =>
    handle(
      new Request("http://localhost/api/model-run/create?job_id=job_race", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ effort_multiplier: 7 }),
      }),
    )

  const create_responses = await Promise.all([create(), create()])

  expect(create_responses.map((response) => response?.status).sort()).toEqual([202, 409])
  expect(started_run_ids).toHaveLength(1)
  const extend = () =>
    handle(
      new Request("http://localhost/api/model-run/extend?job_id=job_race", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ additional_effort: 1 }),
      }),
    )

  const extend_responses = await Promise.all([extend(), extend()])

  expect(extend_responses.map((response) => response?.status).sort()).toEqual([202, 400])
  expect(model_run_store.getModelRunForJob("job_race")?.effort_multiplier).toBe(8)
  await rm(job_dir, { recursive: true, force: true })
})

test("deletion leases reject concurrent model create, extend, retry, and direct launch transitions", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-model-delete-races-"))
  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  const api_context = {
    jobs_root,
    job_store,
    model_run_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_job: async () => undefined,
    run_model: async () => undefined,
  }
  const handle_jobs = createJobApiHandler(api_context)
  const handle_models = createModelRunApiHandler(api_context)

  const create_job_id = "job_delete_create"
  const create_job_dir = join(jobs_root, create_job_id)
  job_store.createJob({ job_id: create_job_id, job_dir: create_job_dir, file_name: "create.pdf" })
  const controlled_create = controlledJsonRequest(
    `http://localhost/api/model-run/create?job_id=${create_job_id}`,
    { effort_multiplier: 2 },
  )
  const create_promise = handle_models(controlled_create.request)
  const create_delete_promise = handle_jobs(
    new Request(`http://localhost/api/job/delete?job_id=${create_job_id}`, { method: "DELETE" }),
  )
  expect(job_store.isJobDeleting(create_job_id)).toBe(true)
  const duplicate_delete_response = await handle_jobs(
    new Request(`http://localhost/api/job/delete?job_id=${create_job_id}`, { method: "DELETE" }),
  )
  expect(duplicate_delete_response?.status).toBe(409)
  expect(await duplicate_delete_response?.json()).toMatchObject({
    error: { error_code: "job_delete_in_progress" },
  })
  controlled_create.release()
  const create_response = await create_promise
  expect(create_response?.status).toBe(409)
  expect(await create_response?.json()).toMatchObject({ error: { error_code: "job_deleting" } })
  expect(model_run_store.getModelRunForJob(create_job_id)).toBeUndefined()
  job_store.updateJob(create_job_id, { display_status: "cancelled", is_complete: true })
  expect((await create_delete_promise)?.status).toBe(204)
  expect(job_store.isJobDeleting(create_job_id)).toBe(false)

  const extend_job_id = "job_delete_extend"
  const extend_job_dir = join(jobs_root, extend_job_id)
  job_store.createJob({ job_id: extend_job_id, job_dir: extend_job_dir, file_name: "extend.pdf" })
  model_run_store.createModelRun({
    model_run_id: "model_delete_extend",
    job_id: extend_job_id,
    model_dir: join(extend_job_dir, "spice"),
    effort_multiplier: 3,
  })
  model_run_store.finishSegment("model_delete_extend", {
    status: "complete",
    is_complete: true,
    has_errors: false,
  })
  const controlled_extend = controlledJsonRequest(
    `http://localhost/api/model-run/extend?job_id=${extend_job_id}`,
    { additional_effort: 1 },
  )
  const extend_promise = handle_models(controlled_extend.request)
  const extend_delete_promise = handle_jobs(
    new Request(`http://localhost/api/job/delete?job_id=${extend_job_id}`, { method: "DELETE" }),
  )
  expect(job_store.isJobDeleting(extend_job_id)).toBe(true)
  controlled_extend.release()
  const extend_response = await extend_promise
  expect(extend_response?.status).toBe(409)
  expect(await extend_response?.json()).toMatchObject({ error: { error_code: "job_deleting" } })
  expect(model_run_store.getModelRunForJob(extend_job_id)?.effort_multiplier).toBe(3)
  job_store.updateJob(extend_job_id, { display_status: "cancelled", is_complete: true })
  expect((await extend_delete_promise)?.status).toBe(204)
  expect(job_store.isJobDeleting(extend_job_id)).toBe(false)

  const retry_job_id = "job_delete_retry"
  const retry_job_dir = join(jobs_root, retry_job_id)
  job_store.createJob({ job_id: retry_job_id, job_dir: retry_job_dir, file_name: "retry.pdf" })
  model_run_store.createModelRun({
    model_run_id: "model_delete_retry",
    job_id: retry_job_id,
    model_dir: join(retry_job_dir, "spice"),
    effort_multiplier: 8,
  })
  model_run_store.finishSegment("model_delete_retry", {
    status: "failed",
    is_complete: true,
    has_errors: true,
    error_message: "fixture failure",
  })
  const retry_delete_promise = handle_jobs(
    new Request(`http://localhost/api/job/delete?job_id=${retry_job_id}`, { method: "DELETE" }),
  )
  expect(job_store.isJobDeleting(retry_job_id)).toBe(true)
  const retry_response = await handle_models(
    new Request(`http://localhost/api/model-run/retry?job_id=${retry_job_id}`, { method: "POST" }),
  )
  expect(retry_response?.status).toBe(409)
  expect(await retry_response?.json()).toMatchObject({ error: { error_code: "job_deleting" } })
  expect(model_run_store.getModelRunForJob(retry_job_id)?.status).toBe("failed")
  job_store.updateJob(retry_job_id, { display_status: "cancelled", is_complete: true })
  expect((await retry_delete_promise)?.status).toBe(204)
  expect(job_store.isJobDeleting(retry_job_id)).toBe(false)

  const launch_job_id = "job_delete_launch"
  const launch_job_dir = join(jobs_root, launch_job_id)
  job_store.createJob({ job_id: launch_job_id, job_dir: launch_job_dir, file_name: "launch.pdf" })
  const lease = job_store.acquireJobDeletionLease(launch_job_id)
  if (lease.status !== "acquired") throw new Error("Expected a deletion lease")
  const launch = await launchModelRun(
    { job_id: launch_job_id, job_dir: launch_job_dir, effort_multiplier: 1 },
    api_context,
  )
  expect(launch.status).toBe("job_deleting")
  expect(model_run_store.getModelRunForJob(launch_job_id)).toBeUndefined()
  expect(job_store.releaseJobDeletionLease(lease.lease)).toBe(true)

  await rm(jobs_root, { recursive: true, force: true })
})

test("a legacy run adopts the saved UI provider when added effort first resumes it", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-api-legacy-provider-"))
  const model_dir = join(job_dir, "spice")
  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  await mkdir(model_dir, { recursive: true })
  job_store.createJob({ job_id: "job_legacy", job_dir, file_name: "sensor.pdf" })
  model_run_store.restoreModelRun({
    model_dir,
    logs: [],
    model_run: {
      model_run_id: "model_legacy",
      job_id: "job_legacy",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "complete",
      is_complete: true,
      has_errors: false,
      effort_multiplier: 1,
      elapsed_time_ms: 1_000,
      iteration: 1,
      logs: [],
      progress_history: [],
      preview_options: [],
    },
  })
  const providers: Array<boolean | undefined> = []
  const handle = createModelRunApiHandler({
    job_store,
    model_run_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_model: async (_input, context) => {
      providers.push(context.use_openai)
    },
  })

  const response = await handle(
    new Request("http://localhost/api/model-run/extend?job_id=job_legacy&use_openai=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ additional_effort: 1 }),
    }),
  )

  expect(response?.status).toBe(202)
  expect(providers).toEqual([true])
  expect(model_run_store.getModelRun("model_legacy")?.use_openai).toBe(true)
  expect(job_store.getJob("job_legacy")?.use_openai).toBe(true)
  expect((await Bun.file(join(model_dir, "model-run.json")).json()).use_openai).toBe(true)
  expect((await Bun.file(join(job_dir, "job.json")).json()).use_openai).toBe(true)
  await rm(job_dir, { recursive: true, force: true })
})

test("model API serves the saved datasheet image for each benchmark", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-reference-api-"))
  const model_dir = join(job_dir, "spice")
  const figure_dir = join(model_dir, "evidence", "figures")
  const crop_dir = join(model_dir, "evidence", "crops")
  const page_dir = join(model_dir, "evidence", "pages")
  await Promise.all([
    mkdir(figure_dir, { recursive: true }),
    mkdir(crop_dir, { recursive: true }),
    mkdir(page_dir, { recursive: true }),
  ])

  const explicit_image = new Uint8Array([137, 80, 78, 71, 1])
  const figure_image = new Uint8Array([137, 80, 78, 71, 2])
  const page_image = new Uint8Array([137, 80, 78, 71, 4])
  await Promise.all([
    Bun.write(join(figure_dir, "explicit.png"), explicit_image),
    Bun.write(join(crop_dir, "fig-10-3.png"), figure_image),
    Bun.write(join(crop_dir, "page-22-r1c1.png"), new Uint8Array([137, 80, 78, 71, 5])),
    Bun.write(join(crop_dir, "page-22-r1c2.png"), new Uint8Array([137, 80, 78, 71, 6])),
    Bun.write(join(page_dir, "datasheet-page-22.png"), page_image),
    Bun.write(join(job_dir, "outside.png"), new Uint8Array([137, 80, 78, 71, 3])),
    Bun.write(
      join(model_dir, "validation-plan.json"),
      JSON.stringify({
        cases: [
          {
            id: "explicit",
            observations: [
              {
                evidence: {
                  page: 24,
                  image: "evidence/figures/explicit.png",
                  metadata: { figure: "Figure 10-15" },
                },
              },
            ],
          },
          {
            id: "evidence-priority",
            observations: [
              { evidence: { page: 22 } },
              { evidence: { image: "evidence/figures/explicit.png" } },
            ],
          },
          {
            id: "figure-match",
            observations: [{ evidence: { page: 18, metadata: { figure: "Figure 10-3" } } }],
          },
          { id: "page-match", observations: [{ evidence: { page: 22 } }] },
          { id: "outside", observations: [{ evidence: { image: "../outside.png" } }] },
        ],
      }),
    ),
    Bun.write(
      join(model_dir, "benchmarks.json"),
      JSON.stringify({
        version: 1,
        benchmarks: [
          {
            id: "legacy-only",
            source: { image: "evidence/figures/explicit.png" },
          },
        ],
      }),
    ),
  ])

  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_reference", job_dir, file_name: "sensor.pdf" })
  model_run_store.createModelRun({
    model_run_id: "model_reference",
    job_id: "job_reference",
    model_dir,
    effort_multiplier: 1,
  })
  const handle = createModelRunApiHandler({
    job_store,
    model_run_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
  })

  const explicit_response = await handle(
    new Request("http://localhost/api/model-run/reference-image?job_id=job_reference&benchmark_id=explicit"),
  )
  expect(explicit_response?.status).toBe(200)
  expect(explicit_response?.headers.get("Content-Type")).toBe("image/png")
  expect(explicit_response?.headers.get("Content-Disposition")).toBe(
    'inline; filename="explicit-datasheet-reference.png"',
  )
  expect(new Uint8Array(await explicit_response!.arrayBuffer())).toEqual(explicit_image)

  const evidence_priority_response = await handle(
    new Request(
      "http://localhost/api/model-run/reference-image?job_id=job_reference&benchmark_id=evidence-priority",
    ),
  )
  expect(evidence_priority_response?.status).toBe(200)
  expect(new Uint8Array(await evidence_priority_response!.arrayBuffer())).toEqual(explicit_image)

  const figure_response = await handle(
    new Request(
      "http://localhost/api/model-run/reference-image?job_id=job_reference&benchmark_id=figure-match",
    ),
  )
  expect(figure_response?.status).toBe(200)
  expect(new Uint8Array(await figure_response!.arrayBuffer())).toEqual(figure_image)

  const page_response = await handle(
    new Request(
      "http://localhost/api/model-run/reference-image?job_id=job_reference&benchmark_id=page-match",
    ),
  )
  expect(page_response?.status).toBe(200)
  expect(new Uint8Array(await page_response!.arrayBuffer())).toEqual(page_image)

  const outside_response = await handle(
    new Request("http://localhost/api/model-run/reference-image?job_id=job_reference&benchmark_id=outside"),
  )
  expect(outside_response?.status).toBe(404)

  const legacy_response = await handle(
    new Request(
      "http://localhost/api/model-run/reference-image?job_id=job_reference&benchmark_id=legacy-only",
    ),
  )
  expect(legacy_response?.status).toBe(404)

  await rm(job_dir, { recursive: true, force: true })
})

test("model preview APIs bind candidate generations exactly and never mistake queued accepted state", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-preview-generation-api-"))
  const model_dir = join(job_dir, "spice")
  const generation_a = "candidate-generation-a1"
  const generation_b = "candidate-generation-b2"
  const revision_a = "a".repeat(16)
  const revision_b = "b".repeat(16)
  const writePreviewBundle = async (
    root: string,
    label: string,
    image_byte: number,
    artifact_identity?: { preview_generation: string; model_revision: string },
  ) => {
    await Promise.all([
      mkdir(join(root, "cases"), { recursive: true }),
      mkdir(join(root, "evidence"), { recursive: true }),
    ])
    await Promise.all([
      Bun.write(
        join(root, "cases", "output.preview.json"),
        JSON.stringify({
          ...(artifact_identity ? { artifact_identity } : {}),
          reference_preview: {
            title: label,
            source_file: "validation-plan.json",
            x_scale: "linear",
            y_scale: "linear",
            reference_points: [],
            updated_at: "2026-08-01T00:00:00.000Z",
          },
        }),
      ),
      Bun.write(
        join(root, "validation-plan.json"),
        JSON.stringify({
          cases: [
            {
              id: "output",
              observations: [{ evidence: { image: "evidence/source-page-1.png", page: 1 } }],
            },
          ],
        }),
      ),
      Bun.write(join(root, "evidence", "source-page-1.png"), new Uint8Array([137, 80, 78, 71, image_byte])),
    ])
  }
  await Promise.all([
    writePreviewBundle(join(model_dir, "current-previews", generation_a), "generation a", 1, {
      preview_generation: generation_a,
      model_revision: revision_a,
    }),
    writePreviewBundle(join(model_dir, "current-previews", generation_b), "generation b", 2, {
      preview_generation: generation_b,
      model_revision: revision_b,
    }),
  ])

  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_generation", job_dir, file_name: "part.pdf" })
  model_run_store.createModelRun({
    model_run_id: "model_generation",
    job_id: "job_generation",
    model_dir,
    effort_multiplier: 1,
  })
  const validationSummary = (
    artifact_state: "candidate" | "accepted",
    preview_generation?: string,
    model_revision = artifact_state === "candidate" ? revision_a : "accepted-r1",
  ) => ({
    artifact_state,
    model_revision,
    ...(preview_generation ? { preview_generation } : {}),
    benchmark_count: 1,
    passing_count: 0,
    critical_count: 1,
    critical_passing_count: 0,
    all_critical_passed: false,
    all_passed: false,
    benchmarks: [],
  })
  model_run_store.updateModelRun("model_generation", {
    status: "validating",
    validation: validationSummary("candidate", generation_a),
  })
  const handle = createModelRunApiHandler({
    job_store,
    model_run_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
  })

  const candidate_preview = await handle(
    new Request("http://localhost/api/model-run/preview?job_id=job_generation&benchmark_id=output"),
  )
  expect(candidate_preview?.headers.get("Cache-Control")).toBe("no-store")
  expect(await candidate_preview?.json()).toMatchObject({ reference_preview: { title: "generation a" } })
  const candidate_image = await handle(
    new Request(
      `http://localhost/api/model-run/reference-image?job_id=job_generation&benchmark_id=output&preview_generation=${generation_a}&model_revision=${revision_a}`,
    ),
  )
  expect(new Uint8Array(await candidate_image!.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71, 1]))
  expect(candidate_image?.headers.get("Cache-Control")).toBe("no-store")

  const missing_candidate_identity = await handle(
    new Request("http://localhost/api/model-run/reference-image?job_id=job_generation&benchmark_id=output"),
  )
  expect(missing_candidate_identity?.status).toBe(400)
  expect(missing_candidate_identity?.headers.get("Cache-Control")).toBe("no-store")
  expect(await missing_candidate_identity?.json()).toMatchObject({
    error: { error_code: "preview_artifact_identity_required" },
  })

  const incomplete_candidate_identity = await handle(
    new Request(
      `http://localhost/api/model-run/reference-image?job_id=job_generation&benchmark_id=output&preview_generation=${generation_a}`,
    ),
  )
  expect(incomplete_candidate_identity?.status).toBe(400)
  expect(await incomplete_candidate_identity?.json()).toMatchObject({
    error: { error_code: "preview_artifact_identity_incomplete" },
  })

  model_run_store.updateModelRun("model_generation", {
    validation: validationSummary("candidate", generation_b, revision_b),
  })
  const stale_candidate_image = await handle(
    new Request(
      `http://localhost/api/model-run/reference-image?job_id=job_generation&benchmark_id=output&preview_generation=${generation_a}&model_revision=${revision_a}`,
    ),
  )
  expect(stale_candidate_image?.status).toBe(409)
  expect(stale_candidate_image?.headers.get("Cache-Control")).toBe("no-store")
  expect(await stale_candidate_image?.json()).toMatchObject({
    error: { error_code: "preview_artifact_identity_mismatch" },
  })
  const current_candidate_image = await handle(
    new Request(
      `http://localhost/api/model-run/reference-image?job_id=job_generation&benchmark_id=output&preview_generation=${generation_b}&model_revision=${revision_b}`,
    ),
  )
  expect(new Uint8Array(await current_candidate_image!.arrayBuffer())).toEqual(
    new Uint8Array([137, 80, 78, 71, 2]),
  )

  await writePreviewBundle(join(model_dir, "current-preview"), "unbound mutable candidate", 9)
  model_run_store.updateModelRun("model_generation", {
    validation: validationSummary("candidate", undefined, revision_b),
  })
  const unbound_candidate_preview = await handle(
    new Request("http://localhost/api/model-run/preview?job_id=job_generation&benchmark_id=output"),
  )
  expect(unbound_candidate_preview?.status).toBe(500)
  expect(await unbound_candidate_preview?.json()).toMatchObject({
    error: { error_code: "candidate_preview_invalid" },
  })
  const unbound_candidate_image = await handle(
    new Request("http://localhost/api/model-run/reference-image?job_id=job_generation&benchmark_id=output"),
  )
  expect(unbound_candidate_image?.status).toBe(500)
  expect(await unbound_candidate_image?.json()).toMatchObject({
    error: { error_code: "candidate_reference_image_invalid" },
  })

  const malformed_generation = "candidate-generation-malformed"
  await mkdir(join(model_dir, "current-previews", malformed_generation, "cases"), { recursive: true })
  await Bun.write(
    join(model_dir, "current-previews", malformed_generation, "cases", "output.preview.json"),
    JSON.stringify({ reference_preview: { title: "missing required fields" } }),
  )
  model_run_store.updateModelRun("model_generation", {
    validation: validationSummary("candidate", malformed_generation, "c".repeat(16)),
  })
  const malformed_candidate = await handle(
    new Request("http://localhost/api/model-run/preview?job_id=job_generation&benchmark_id=output"),
  )
  expect(malformed_candidate?.status).toBe(500)
  expect(malformed_candidate?.headers.get("Cache-Control")).toBe("no-store")
  expect(await malformed_candidate?.json()).toMatchObject({
    error: {
      error_code: "candidate_preview_invalid",
      message: expect.stringContaining("artifact_identity is required"),
    },
  })

  await Promise.all([
    writePreviewBundle(join(model_dir, "validation"), "accepted root", 3),
    writePreviewBundle(model_dir, "accepted root", 3),
    writePreviewBundle(join(model_dir, "current-preview"), "stale mutable preview", 4),
  ])
  model_run_store.updateModelRun("model_generation", {
    status: "complete",
    is_complete: true,
    validation: validationSummary("accepted"),
  })
  expect(model_run_store.extendModelRun("model_generation", 1).status).toBe("extended")
  expect(model_run_store.getModelRun("model_generation")?.status).toBe("queued")

  const queued_preview = await handle(
    new Request("http://localhost/api/model-run/preview?job_id=job_generation&benchmark_id=output"),
  )
  expect(await queued_preview?.json()).toMatchObject({ reference_preview: { title: "accepted root" } })
  const queued_image = await handle(
    new Request("http://localhost/api/model-run/reference-image?job_id=job_generation&benchmark_id=output"),
  )
  expect(new Uint8Array(await queued_image!.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71, 3]))

  const pipeline_timestamp = "2026-08-01T00:00:00.000Z"
  model_run_store.updateModelRun("model_generation", {
    validation: validationSummary("accepted", generation_a),
    pipeline: {
      pipeline_id: "datasheet_model",
      status: "completed",
      sequence: 1,
      started_at: pipeline_timestamp,
      updated_at: pipeline_timestamp,
      stage_results: {
        publish_model: {
          stage_id: "publish_model",
          status: "completed",
          debug_ref: ".pipeline/stages/publish-model",
          started_at: pipeline_timestamp,
          completed_at: pipeline_timestamp,
          duration_ms: 1,
        },
      },
    },
  })
  const missing_current_publication = await handle(
    new Request("http://localhost/api/model-run/preview?job_id=job_generation&benchmark_id=output"),
  )
  expect(missing_current_publication?.status).toBe(500)
  expect(await missing_current_publication?.json()).toMatchObject({
    error: { error_code: "accepted_publication_invalid" },
  })
  const missing_current_reference = await handle(
    new Request("http://localhost/api/model-run/reference-image?job_id=job_generation&benchmark_id=output"),
  )
  expect(missing_current_reference?.status).toBe(500)
  expect(await missing_current_reference?.json()).toMatchObject({
    error: { error_code: "accepted_publication_invalid" },
  })
  await rm(job_dir, { recursive: true, force: true })
})

test("model artifact endpoints report a corrupt accepted publication", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-api-corrupt-publication-"))
  const model_dir = join(job_dir, "spice")
  await mkdir(model_dir, { recursive: true })
  await Bun.write(join(job_dir, "published-model.json"), '{"version":1}\n')
  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "job_corrupt_publication", job_dir, file_name: "sensor.pdf" })
  model_run_store.createModelRun({
    model_run_id: "model_corrupt_publication",
    job_id: "job_corrupt_publication",
    model_dir,
    effort_multiplier: 1,
  })
  const handle = createModelRunApiHandler({
    job_store,
    model_run_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
  })

  for (const path of [
    "/api/model-run/file?job_id=job_corrupt_publication&file=model",
    "/api/model-run/preview?job_id=job_corrupt_publication&benchmark_id=output",
    "/api/model-run/reference-image?job_id=job_corrupt_publication&benchmark_id=output",
  ]) {
    const response = await handle(new Request(`http://localhost${path}`))
    expect(response?.status).toBe(500)
    expect(await response?.json()).toMatchObject({
      error: {
        error_code: "accepted_publication_invalid",
        message:
          "The accepted model publication failed its integrity checks. Inspect the server diagnostic for this job.",
      },
    })
  }

  await rm(job_dir, { recursive: true, force: true })
})
