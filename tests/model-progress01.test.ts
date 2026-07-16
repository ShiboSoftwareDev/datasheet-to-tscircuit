import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { startModelProgressMonitor } from "@/server/model-progress"
import { ModelRunStore } from "@/server/model-run-store"

test("agent progress cannot publish a future timestamp, terminal phase, or expanded locked suite", async () => {
  const tmp_root = join(process.cwd(), "tmp")
  await mkdir(tmp_root, { recursive: true })
  const model_dir = await mkdtemp(join(tmp_root, "model-progress-"))
  const store = new ModelRunStore()
  store.createModelRun({
    model_run_id: "progress_run",
    job_id: "progress_job",
    model_dir,
    effort_multiplier: 1,
    base_effort_ms: 1_000,
  })
  store.updateProgress("progress_run", {
    sequence: 4,
    phase: "locking_benchmarks",
    message: "Server locked the suite",
    updated_at: new Date().toISOString(),
    benchmark: { completed: 0, total: 4, draft_total: 32, locked_total: 4, omitted: 28 },
  })
  await Bun.write(
    join(model_dir, "model-progress.json"),
    JSON.stringify({
      sequence: 99,
      phase: "complete",
      message: "Agent says complete",
      updated_at: "2099-01-01T00:00:00.000Z",
      benchmark: { completed: 32, total: 32 },
    }),
  )
  const monitor = startModelProgressMonitor({
    model_run_id: "progress_run",
    model_dir,
    model_run_store: store,
    interval_ms: 60_000,
  })
  try {
    await monitor.sync()
    const progress = store.getModelRun("progress_run")?.progress
    expect(progress?.phase).toBe("locking_benchmarks")
    expect(Date.parse(progress!.updated_at)).toBeLessThan(Date.parse("2099-01-01T00:00:00.000Z"))
    expect(progress?.benchmark).toEqual({
      completed: 4,
      total: 4,
      draft_total: 32,
      locked_total: 4,
      omitted: 28,
    })
  } finally {
    monitor.stop()
    await rm(model_dir, { recursive: true, force: true })
  }
})
