import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJobApiHandler } from "@/server/job-api"
import { runJob } from "@/server/job-runner"
import { JobStore } from "@/server/job-store"
import { ModelRunStore } from "@/server/model-run-store"

test("job create accepts a PDF and starts the injected background runner", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-"))
  const job_store = new JobStore()
  let started_job_id: string | undefined
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_job: async (input) => {
      started_job_id = input.job_id
    },
  })
  const form = new FormData()
  form.set("datasheet", new File(["%PDF-1.7\nfixture"], "sensor.pdf", { type: "application/pdf" }))

  const response = await handle(
    new Request("http://localhost/api/job/create", { method: "POST", body: form }),
  )
  const body = (await response?.json()) as { job: { job_id: string; file_name: string } }

  expect(response?.status).toBe(202)
  expect(body.job.file_name).toBe("sensor.pdf")
  expect(started_job_id).toBe(body.job.job_id)
  expect(await Bun.file(join(jobs_root, body.job.job_id, "datasheet.pdf")).exists()).toBe(true)
  expect(await Bun.file(join(jobs_root, body.job.job_id, "AGENTS.md")).text()).toContain(
    "typical-application-plan.json",
  )

  await rm(jobs_root, { recursive: true, force: true })
})

test("job create can launch component and untimed SPICE setup together", async () => {
  const jobs_root = await mkdtemp(join(tmpdir(), "datasheet-job-api-model-"))
  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  let component_job_id: string | undefined
  let model_run_id: string | undefined
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    model_run_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    model_base_effort_ms: 2_000,
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
    model_run: { model_run_id: string; allocated_time_ms: number; elapsed_time_ms: number }
  }

  expect(response?.status).toBe(202)
  expect(component_job_id).toBe(body.job.job_id)
  expect(model_run_id).toBe(body.model_run.model_run_id)
  expect(body.model_run.allocated_time_ms).toBe(8_000)
  expect(body.model_run.elapsed_time_ms).toBe(0)

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

  const retry_response = await handle(
    new Request(`http://localhost/api/job/retry?job_id=${created_body.job.job_id}`, { method: "POST" }),
  )
  const retry_body = (await retry_response?.json()) as { job: { job_id: string } }
  const retried_pdf = join(jobs_root, retry_body.job.job_id, "datasheet.pdf")

  expect(retry_response?.status).toBe(202)
  expect(retry_body.job.job_id).not.toBe(created_body.job.job_id)
  expect(started_jobs).toHaveLength(2)
  expect(started_jobs[1]?.additional_instructions).toBe("Use the QFN package")
  expect(await Bun.file(retried_pdf).text()).toContain("retry fixture")

  job_store.updateJob(retry_body.job.job_id, { display_status: "complete", is_complete: true })
  const delete_response = await handle(
    new Request(`http://localhost/api/job/delete?job_id=${retry_body.job.job_id}`, { method: "DELETE" }),
  )
  expect(delete_response?.status).toBe(204)
  expect(job_store.getJob(retry_body.job.job_id)).toBeUndefined()
  expect(await Bun.file(retried_pdf).exists()).toBe(false)

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
    additional_instructions: "Preserve the exposed pad",
  })
  job_store.updateJob("failed_job", {
    display_status: "failed",
    is_complete: true,
    has_errors: true,
  })
  const started_jobs: string[] = []
  const handle = createJobApiHandler({
    jobs_root,
    job_store,
    agent_bin: "unused-agent",
    tsci_bin: "unused-tsci",
    run_job: async ({ job_id }) => {
      started_jobs.push(job_id)
    },
  })

  const response = await handle(
    new Request("http://localhost/api/job/retry?job_id=failed_job", { method: "POST" }),
  )
  const body = (await response?.json()) as { job: { job_id: string } }
  expect(response?.status).toBe(202)
  expect(body.job.job_id).not.toBe("failed_job")
  expect(started_jobs).toEqual([body.job.job_id])
  expect(await Bun.file(join(jobs_root, body.job.job_id, "datasheet.pdf")).text()).toContain("failed fixture")

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
