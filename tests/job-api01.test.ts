import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJobApiHandler } from "@/server/job-api"
import { JobStore } from "@/server/job-store"

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

  await rm(jobs_root, { recursive: true, force: true })
})
