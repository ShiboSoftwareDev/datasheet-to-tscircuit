import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelRunStore } from "@/server/model-run-store"
import type { ModelRun } from "@/shared/job-types"

test("ModelRunStore extends only the time budget and persists run control", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-store-"))
  const store = new ModelRunStore()
  store.createModelRun({
    model_run_id: "model_1",
    job_id: "job_1",
    model_dir,
    effort_multiplier: 1,
    base_effort_ms: 10_000,
  })
  store.startSegment("model_1")
  const extended = store.extendModelRun("model_1", 2)
  const control = JSON.parse(await Bun.file(join(model_dir, "run-control.json")).text()) as {
    allocated_time_ms: number
    effort_multiplier: number
  }

  expect(extended.should_start).toBe(false)
  expect(extended.model_run.effort_multiplier).toBe(3)
  expect(extended.model_run.allocated_time_ms).toBe(30_000)
  expect(control.allocated_time_ms).toBe(30_000)
  expect(control.effort_multiplier).toBe(3)
  expect(store.requestCancellation("model_1")).toBe("requested")
  expect(store.getCancellationSignal("model_1")?.aborted).toBe(true)

  store.finishSegment("model_1", {
    status: "cancelled",
    is_complete: true,
    has_errors: false,
  })
  const continuation = store.extendModelRun("model_1", 1)
  expect(continuation.should_start).toBe(true)
  expect(continuation.model_run.status).toBe("queued")
  expect(store.getCancellationSignal("model_1")?.aborted).toBe(false)

  await rm(model_dir, { recursive: true, force: true })
})

test("ModelRunStore publishes structured progress and keeps a bounded timeline", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-progress-store-"))
  const store = new ModelRunStore()
  store.createModelRun({
    model_run_id: "model_progress",
    job_id: "job_progress",
    model_dir,
    effort_multiplier: 1,
    base_effort_ms: 10_000,
  })
  const published_phases: string[] = []
  const unsubscribe = store.subscribe("model_progress", (event) => {
    if (event.event_type !== "log" && event.model_run.progress) {
      published_phases.push(event.model_run.progress.phase)
    }
  })

  store.updateProgress("model_progress", {
    sequence: 1,
    phase: "digitizing_graphs",
    message: "Digitized the transfer curve",
    updated_at: "2026-07-15T12:00:00.000Z",
    iteration: 0,
    evidence: { pages_reviewed: 7, graphs_found: 4, graphs_digitized: 1, benchmark_drafts: 1 },
  })
  store.updateProgress("model_progress", {
    sequence: 2,
    phase: "scoring",
    message: "Scored candidate r0002",
    updated_at: "2026-07-15T12:01:00.000Z",
    iteration: 2,
    champion: { revision: "r0001", passing: 3, total: 4, score: 0.08 },
  })

  const model_run = store.getModelRun("model_progress")
  expect(model_run?.progress?.champion?.revision).toBe("r0001")
  expect(model_run?.iteration).toBe(2)
  expect(model_run?.progress_history.map((event) => event.phase)).toEqual(["digitizing_graphs", "scoring"])
  expect(published_phases).toEqual(["digitizing_graphs", "scoring"])

  unsubscribe?.()
  await rm(model_dir, { recursive: true, force: true })
})

test("ModelRunStore preserves persisted active-segment effort across a restart", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-restart-effort-"))
  const segment_started_at = new Date(Date.now() - 2_500).toISOString()
  const updated_at = new Date(Date.now() - 1_000).toISOString()
  const persisted: ModelRun = {
    model_run_id: "model_restart",
    job_id: "job_restart",
    created_at: segment_started_at,
    updated_at,
    status: "running",
    is_complete: false,
    has_errors: false,
    effort_multiplier: 1,
    base_effort_ms: 10_000,
    allocated_time_ms: 10_000,
    elapsed_time_ms: 1_000,
    segment_started_at,
    iteration: 1,
    logs: [],
    progress_history: [],
    preview_options: [],
  }

  const store = new ModelRunStore()
  const restored = store.restoreModelRun({ model_dir, model_run: persisted, logs: [] })
  expect(restored.status).toBe("failed")
  expect(restored.elapsed_time_ms).toBeGreaterThanOrEqual(3_500)
  expect(restored.elapsed_time_ms).toBeLessThan(3_750)
  expect(restored.segment_started_at).toBeUndefined()

  await rm(model_dir, { recursive: true, force: true })
})
