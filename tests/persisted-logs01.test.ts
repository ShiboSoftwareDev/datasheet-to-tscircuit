import { expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getLogArchivePath,
  PERSISTED_LOG_EVENT_BYTE_LIMIT,
  PERSISTED_LOG_FILE_BYTE_LIMIT,
  RECENT_LOG_EVENT_LIMIT,
} from "@/server/infrastructure/persistence/bounded-log"
import { readPersistedLogs } from "@/server/job-restorer"
import { JobStore } from "@/server/job-store"
import type { JobLog } from "@/shared/job-types"

test("NDJSON logs rotate into one bounded archive and restore the retained suffix", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-bounded-log-"))
  const log_path = join(job_dir, "agent.log")
  const job_store = new JobStore()
  try {
    job_store.createJob({ job_id: "bounded_logs", job_dir, file_name: "sensor.pdf" })
    const appended: JobLog[] = []
    for (let index = 0; index < 55; index += 1) {
      appended.push(
        await job_store.appendLog("bounded_logs", {
          stream: "stdout",
          message: `event-${index}: ${"x".repeat(96 * 1024)}`,
        }),
      )
    }

    const [current_size, archive_size] = await Promise.all([
      stat(log_path).then((metadata) => metadata.size),
      stat(getLogArchivePath(log_path)).then((metadata) => metadata.size),
    ])
    expect(current_size).toBeLessThanOrEqual(PERSISTED_LOG_FILE_BYTE_LIMIT)
    expect(archive_size).toBeLessThanOrEqual(PERSISTED_LOG_FILE_BYTE_LIMIT)

    const restored = await readPersistedLogs(log_path)
    expect(restored.length).toBeGreaterThan(0)
    expect(restored.length).toBeLessThan(appended.length)
    expect(restored.map(({ log_id }) => log_id)).toEqual(
      appended.slice(-restored.length).map(({ log_id }) => log_id),
    )

    const oversized = await job_store.appendLog("bounded_logs", {
      stream: "stderr",
      message: "z".repeat(PERSISTED_LOG_EVENT_BYTE_LIMIT * 2),
    })
    expect(oversized.message.startsWith("[... earlier bytes")).toBe(true)
    expect(Buffer.byteLength(`${JSON.stringify(oversized)}\n`, "utf8")).toBeLessThanOrEqual(
      PERSISTED_LOG_EVENT_BYTE_LIMIT,
    )
  } finally {
    await rm(job_dir, { recursive: true, force: true })
  }
})

test("log restoration reads only a bounded recent tail from legacy oversized NDJSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "datasheet-oversized-log-"))
  const log_path = join(root, "agent.log")
  const logs: JobLog[] = Array.from({ length: 1_200 }, (_, index) => ({
    log_id: `log-${index}`,
    created_at: new Date(1_700_000_000_000 + index).toISOString(),
    stream: "stdout",
    message: `${index}:${"x".repeat(4 * 1024)}`,
  }))
  await Bun.write(log_path, `${logs.map((log) => JSON.stringify(log)).join("\n")}\n`)

  try {
    expect((await stat(log_path)).size).toBeGreaterThan(PERSISTED_LOG_FILE_BYTE_LIMIT)
    const restored = await readPersistedLogs(log_path)
    expect(restored.length).toBeLessThanOrEqual(RECENT_LOG_EVENT_LIMIT)
    expect(restored.length).toBeGreaterThan(100)
    expect(restored[0]?.log_id).not.toBe("log-0")
    expect(restored.at(-1)?.log_id).toBe("log-1199")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
