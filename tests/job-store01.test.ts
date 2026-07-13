import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JobStore } from "@/server/job-store"

test("JobStore streams updates and persists every log chunk", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-store-"))
  const job_store = new JobStore()
  const event_types: string[] = []
  job_store.createJob({ job_id: "job_1", job_dir, file_name: "sensor.pdf" })
  const unsubscribe = job_store.subscribe("job_1", (job_event) => event_types.push(job_event.event_type))

  await job_store.appendLog("job_1", "stderr", "[tool] read datasheet.pdf\n")
  job_store.updateJob("job_1", { display_status: "building" })

  expect(event_types).toEqual(["log", "job_updated"])
  expect(job_store.getJob("job_1")?.logs).toHaveLength(1)
  expect(await readFile(join(job_dir, "agent.log"), "utf8")).toContain("[tool] read datasheet.pdf")

  unsubscribe?.()
  await rm(job_dir, { recursive: true, force: true })
})
