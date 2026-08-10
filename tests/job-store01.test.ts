import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { atomicWriteJsonSync } from "@/server/infrastructure/persistence/atomic-write"
import { RECENT_LOG_EVENT_LIMIT } from "@/server/infrastructure/persistence/bounded-log"
import { readPersistedLogs } from "@/server/job-restorer"
import { JobStore } from "@/server/job-store"
import type { Job } from "@/shared/job-types"

test("JobStore streams updates and persists every log chunk", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-store-"))
  const job_store = new JobStore()
  const event_types: string[] = []
  job_store.createJob({
    job_id: "job_1",
    job_dir,
    file_name: "sensor.pdf",
    use_openai: true,
  })
  const unsubscribe = job_store.subscribe("job_1", (job_event) => event_types.push(job_event.event_type))

  await job_store.appendLog("job_1", {
    stream: "stderr",
    message: "[tool] read datasheet.pdf\n",
  })
  job_store.updateJob("job_1", {
    display_status: "agent_running",
    component_ready: true,
    component_code: "export default () => <chip />",
    circuit_json: [{ type: "source_component", source_component_id: "part" }] as Job["circuit_json"],
    typical_application_title: "5 V regulator",
  })

  expect(event_types).toEqual(["log", "job_updated"])
  expect(job_store.getJob("job_1")?.logs).toHaveLength(1)
  expect(job_store.getJob("job_1")?.component_ready).toBe(true)
  expect(job_store.getJob("job_1")?.use_openai).toBe(true)
  expect(job_store.getJob("job_1")?.typical_application_title).toBe("5 V regulator")
  expect(await readFile(join(job_dir, "agent.log"), "utf8")).toContain("[tool] read datasheet.pdf")
  expect(await readPersistedLogs(join(job_dir, "agent.log"))).toEqual(job_store.getJob("job_1")?.logs ?? [])
  expect(JSON.parse(await readFile(join(job_dir, "job.json"), "utf8"))).toMatchObject({
    use_openai: true,
    component_ready: true,
    typical_application_title: "5 V regulator",
  })

  unsubscribe?.()
  await rm(job_dir, { recursive: true, force: true })
})

test("JobStore NDJSON logs preserve embedded newlines and header-like text", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-log-boundaries-"))
  const job_store = new JobStore()
  try {
    job_store.createJob({ job_id: "job_logs", job_dir, file_name: "sensor.pdf" })
    await job_store.appendLog("job_logs", {
      stream: "stdout",
      message: "first line\n[2026-01-01] [stderr] this is message content\nlast line\n",
    })
    await job_store.appendLog("job_logs", { stream: "stderr", message: "second event\n" })

    const restored = await readPersistedLogs(join(job_dir, "agent.log"))
    expect(restored).toEqual(job_store.getJob("job_logs")?.logs ?? [])
    expect(restored).toHaveLength(2)
  } finally {
    await rm(job_dir, { recursive: true, force: true })
  }
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

test("JobStore isolates failed observers from persisted workflow state", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-observer-"))
  const job_store = new JobStore()
  job_store.createJob({ job_id: "job_observer", job_dir, file_name: "sensor.pdf" })
  job_store.subscribe("job_observer", () => {
    throw new Error("closed response stream")
  })

  expect(() => job_store.updateJob("job_observer", { component_ready: true })).not.toThrow()
  expect(job_store.getJob("job_observer")?.component_ready).toBe(true)
  expect(JSON.parse(await readFile(join(job_dir, "job.json"), "utf8")).component_ready).toBe(true)

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
  const first_summary = job_store.listJobs().find((job) => job.job_id === "job_1")
  if (!first_summary) throw new Error("Expected a job summary")
  expect("logs" in first_summary).toBe(false)
  expect(Boolean(first_summary.component_ready)).toBe(false)
  job_store.updateJob("job_1", { component_ready: true })
  expect(job_store.getJobSummary("job_1")?.component_ready).toBe(true)

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
    use_openai: true,
    additional_instructions: "Use QFN",
  })

  expect(job_store.getJobRetrySource("job_delete")?.additional_instructions).toBe("Use QFN")
  expect(job_store.getJobRetrySource("job_delete")?.use_openai).toBe(true)
  expect(job_store.deleteJob("job_delete")).toBe(false)
  job_store.updateJob("job_delete", { display_status: "cancelled", is_complete: true })
  const deletion_lease = job_store.acquireJobDeletionLease("job_delete")
  expect(deletion_lease.status).toBe("acquired")
  expect(job_store.acquireJobDeletionLease("job_delete").status).toBe("already_deleting")
  expect(job_store.isJobDeleting("job_delete")).toBe(true)
  expect(job_store.deleteJob("job_delete")).toBe(true)
  expect(job_store.getJob("job_delete")).toBeUndefined()
  expect(job_store.isJobDeleting("job_delete")).toBe(false)
  if (deletion_lease.status === "acquired") {
    expect(job_store.releaseJobDeletionLease(deletion_lease.lease)).toBe(false)
  }
  expect(deleted_job_ids).toEqual(["job_delete"])

  await rm(job_dir, { recursive: true, force: true })
})

test("JobStore rolls back failed checkpoints without publishing and still aborts cancellation", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-transaction-"))
  let reject_checkpoints = false
  const job_store = new JobStore({
    checkpoint_writer(path, value) {
      if (reject_checkpoints) throw new Error("fixture checkpoint failure")
      atomicWriteJsonSync(path, value)
    },
  })
  const job_events: string[] = []
  const list_events: string[] = []
  try {
    job_store.createJob({ job_id: "job_transaction", job_dir, file_name: "sensor.pdf" })
    job_store.subscribe("job_transaction", (event) => job_events.push(event.event_type))
    job_store.subscribeToJobList((event) => list_events.push(event.event_type))
    const checkpoint_before = await readFile(join(job_dir, "job.json"), "utf8")
    reject_checkpoints = true

    expect(() =>
      job_store.updateJob("job_transaction", {
        display_status: "agent_running",
        component_ready: true,
      }),
    ).toThrow("fixture checkpoint failure")
    expect(job_store.getJob("job_transaction")).toMatchObject({
      display_status: "queued",
      component_ready: undefined,
    })
    expect(await readFile(join(job_dir, "job.json"), "utf8")).toBe(checkpoint_before)
    expect(job_events).toEqual([])
    expect(list_events).toEqual([])

    expect(() => job_store.requestCancellation("job_transaction")).toThrow("fixture checkpoint failure")
    expect(job_store.getCancellationSignal("job_transaction")?.aborted).toBe(true)
    expect(job_store.getJob("job_transaction")?.display_status).toBe("queued")
    expect(job_store.requestCancellation("job_transaction")).toBe("already_requested")
    expect(job_events).toEqual([])
    expect(list_events).toEqual([])
  } finally {
    await rm(job_dir, { recursive: true, force: true })
  }
})

test("JobStore does not expose a creation whose first checkpoint fails", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-create-failure-"))
  const job_store = new JobStore({
    checkpoint_writer() {
      throw new Error("fixture initial checkpoint failure")
    },
  })
  const list_events: string[] = []
  job_store.subscribeToJobList((event) => list_events.push(event.event_type))
  try {
    expect(() =>
      job_store.createJob({ job_id: "job_not_created", job_dir, file_name: "sensor.pdf" }),
    ).toThrow("fixture initial checkpoint failure")
    expect(job_store.getJob("job_not_created")).toBeUndefined()
    expect(job_store.listJobs()).toEqual([])
    expect(list_events).toEqual([])
  } finally {
    await rm(job_dir, { recursive: true, force: true })
  }
})

test("JobStore keeps a documented recent log window while publishing every live delta", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-log-window-"))
  const job_store = new JobStore({ log_writer: async () => undefined })
  const published_messages: string[] = []
  try {
    job_store.createJob({ job_id: "job_log_window", job_dir, file_name: "sensor.pdf" })
    job_store.subscribe("job_log_window", (event) => {
      if (event.event_type === "log") published_messages.push(event.log.message)
    })
    const event_count = RECENT_LOG_EVENT_LIMIT + 25
    for (let index = 0; index < event_count; index += 1) {
      await job_store.appendLog("job_log_window", { stream: "stdout", message: `event-${index}` })
    }

    const retained = job_store.getJob("job_log_window")?.logs ?? []
    expect(retained).toHaveLength(RECENT_LOG_EVENT_LIMIT)
    expect(retained[0]?.message).toBe("event-25")
    expect(retained.at(-1)?.message).toBe(`event-${event_count - 1}`)
    expect(published_messages).toHaveLength(event_count)
    expect(published_messages[0]).toBe("event-0")
  } finally {
    await rm(job_dir, { recursive: true, force: true })
  }
})

test("component and application executions are mutually exclusive within one job workspace", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-pipeline-lease-"))
  const job_store = new JobStore()
  try {
    job_store.createJob({ job_id: "job_pipeline_lease", job_dir, file_name: "sensor.pdf" })
    expect(job_store.claimPipelineExecution("job_pipeline_lease", "component_generation")).toBe(true)
    expect(job_store.claimPipelineExecution("job_pipeline_lease", "typical_application")).toBe(false)
    job_store.releasePipelineExecution("job_pipeline_lease", "component_generation")
    expect(job_store.claimPipelineExecution("job_pipeline_lease", "typical_application")).toBe(true)
    expect(job_store.claimPipelineExecution("job_pipeline_lease", "component_generation")).toBe(false)
    job_store.releasePipelineExecution("job_pipeline_lease", "typical_application")
  } finally {
    await rm(job_dir, { recursive: true, force: true })
  }
})

test("the production coordinator atomically leases component and application together", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-job-coordinated-pipeline-lease-"))
  const job_store = new JobStore()
  try {
    job_store.createJob({ job_id: "job_coordinated_lease", job_dir, file_name: "sensor.pdf" })
    expect(
      job_store.claimCoordinatedPipelineExecutions("job_coordinated_lease", [
        "component_generation",
        "typical_application",
      ]),
    ).toBe(true)
    expect(job_store.claimPipelineExecution("job_coordinated_lease", "component_generation")).toBe(false)
    job_store.releasePipelineExecution("job_coordinated_lease", "component_generation")
    expect(job_store.claimPipelineExecution("job_coordinated_lease", "component_generation")).toBe(false)
    job_store.releasePipelineExecution("job_coordinated_lease", "typical_application")
    expect(job_store.claimPipelineExecution("job_coordinated_lease", "component_generation")).toBe(true)
  } finally {
    await rm(job_dir, { recursive: true, force: true })
  }
})
