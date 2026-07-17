import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JobStore } from "@/server/job-store"
import type { Job } from "@/shared/job-types"

test("JobStore streams updates and persists every log chunk", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-store-"))
  const job_store = new JobStore()
  const event_types: string[] = []
  job_store.createJob({ job_id: "job_1", job_dir, file_name: "sensor.pdf" })
  const unsubscribe = job_store.subscribe("job_1", (job_event) => event_types.push(job_event.event_type))

  await job_store.appendLog("job_1", "stderr", "[tool] read datasheet.pdf\n")
  job_store.updateJob("job_1", {
    display_status: "agent_running",
    component_ready: true,
    component_code: "export default () => <chip />",
    circuit_json: [{ type: "source_component", source_component_id: "part" }] as Job["circuit_json"],
  })

  expect(event_types).toEqual(["log", "job_updated"])
  expect(job_store.getJob("job_1")?.logs).toHaveLength(1)
  expect(job_store.getJob("job_1")?.component_ready).toBe(true)
  expect(await readFile(join(job_dir, "agent.log"), "utf8")).toContain("[tool] read datasheet.pdf")
  expect(JSON.parse(await readFile(join(job_dir, "job.json"), "utf8")).component_ready).toBe(true)

  unsubscribe?.()
  await rm(job_dir, { recursive: true, force: true })
})

test("JobStore cancellation aborts an active job and publishes the stopping state", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-cancel-"))
  const job_store = new JobStore()
  const statuses: string[] = []
  job_store.createJob({ job_id: "job_cancel", job_dir, file_name: "sensor.pdf" })
  job_store.subscribe("job_cancel", (job_event) => {
    if (job_event.event_type === "job_updated") statuses.push(job_event.job.display_status)
  })

  expect(job_store.requestCancellation("job_cancel")).toBe("requested")
  expect(job_store.getCancellationSignal("job_cancel")?.aborted).toBe(true)
  expect(job_store.getJob("job_cancel")?.display_status).toBe("cancelling")
  expect(statuses).toEqual(["cancelling"])
  expect(job_store.requestCancellation("job_cancel")).toBe("already_requested")

  await rm(job_dir, { recursive: true, force: true })
})

test("JobStore lists multiple jobs and streams summary-only status updates", async () => {
  const first_job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-list-first-"))
  const second_job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-list-second-"))
  const job_store = new JobStore()
  const updated_job_ids: string[] = []
  const unsubscribe = job_store.subscribeToJobList((job_event) => {
    if (job_event.event_type === "job_updated") updated_job_ids.push(job_event.job.job_id)
  })

  job_store.createJob({ job_id: "job_1", job_dir: first_job_dir, file_name: "first.pdf" })
  job_store.createJob({ job_id: "job_2", job_dir: second_job_dir, file_name: "second.pdf" })
  job_store.updateJob("job_1", { display_status: "agent_running" })

  expect(job_store.listJobs()).toHaveLength(2)
  expect(
    job_store
      .listJobs()
      .map((job) => job.job_id)
      .sort(),
  ).toEqual(["job_1", "job_2"])
  expect(updated_job_ids).toEqual(["job_1", "job_2", "job_1"])
  expect("logs" in job_store.listJobs()[0]!).toBe(false)

  unsubscribe()
  await Promise.all([
    rm(first_job_dir, { recursive: true, force: true }),
    rm(second_job_dir, { recursive: true, force: true }),
  ])
})

test("JobStore deletes only completed jobs and broadcasts their removal", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-delete-"))
  const job_store = new JobStore()
  const deleted_job_ids: string[] = []
  job_store.subscribeToJobList((job_event) => {
    if (job_event.event_type === "job_deleted") deleted_job_ids.push(job_event.job_id)
  })
  job_store.createJob({
    job_id: "job_delete",
    job_dir,
    file_name: "sensor.pdf",
    additional_instructions: "Use QFN",
  })

  expect(job_store.getJobRetrySource("job_delete")?.additional_instructions).toBe("Use QFN")
  expect(job_store.deleteJob("job_delete")).toBe(false)
  job_store.updateJob("job_delete", { display_status: "cancelled", is_complete: true })
  expect(job_store.deleteJob("job_delete")).toBe(true)
  expect(job_store.getJob("job_delete")).toBeUndefined()
  expect(deleted_job_ids).toEqual(["job_delete"])

  await rm(job_dir, { recursive: true, force: true })
})
