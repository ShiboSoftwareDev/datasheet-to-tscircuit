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

test("ModelRunStore permits only one active execution per model run", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-execution-lease-"))
  const store = new ModelRunStore()
  try {
    store.createModelRun({
      model_run_id: "model_lease",
      job_id: "job_lease",
      model_dir,
      effort_multiplier: 1,
      base_effort_ms: 10_000,
    })

    expect(store.claimModelExecution("model_lease")).toBe(true)
    expect(store.claimModelExecution("model_lease")).toBe(false)
    store.releaseModelExecution("model_lease")
    expect(store.claimModelExecution("model_lease")).toBe(true)
    store.releaseModelExecution("model_lease")
  } finally {
    await rm(model_dir, { recursive: true, force: true })
  }
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

test("ModelRunStore publishes circuit and reference previews atomically", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-preview-store-"))
  const store = new ModelRunStore()
  store.createModelRun({
    model_run_id: "model_preview",
    job_id: "job_preview",
    model_dir,
    effort_multiplier: 1,
    base_effort_ms: 10_000,
  })
  const published: ModelRun[] = []
  const unsubscribe = store.subscribe("model_preview", (event) => {
    if (event.event_type !== "log") published.push(event.model_run)
  })

  const updated_at = "2026-07-16T12:00:00.000Z"
  store.updatePreviews("model_preview", {
    circuit_preview: {
      source_file: "benchmarks/transfer.circuit.tsx",
      code: "export default () => <board />",
      build_status: "ready",
      updated_at,
      circuit_json: [],
      snapshot_origin: "workspace",
    },
    reference_preview: {
      benchmark_id: "transfer",
      title: "Transfer",
      source_file: "evidence/curves/transfer.csv",
      x_scale: "linear",
      y_scale: "linear",
      reference_points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      result_points: [
        { x: 0, y: 0 },
        { x: 1, y: 0.9 },
      ],
      result_status: "unverified",
      result_origin: "workspace",
      updated_at,
    },
  })

  expect(published).toHaveLength(1)
  expect(published[0]?.circuit_preview?.snapshot_origin).toBe("workspace")
  expect(published[0]?.reference_preview?.result_origin).toBe("workspace")
  expect(published[0]?.circuit_preview?.updated_at).toBe(published[0]?.reference_preview?.updated_at)

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

test("ModelRunStore keeps validation untimed and can restart a clean segment", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-validation-profile-"))
  const store = new ModelRunStore()
  store.createModelRun({
    model_run_id: "model_validation_profile",
    job_id: "job_validation_profile",
    model_dir,
    effort_multiplier: 1,
    base_effort_ms: 300_000,
  })

  expect(store.getFinalizationReserveMs("model_validation_profile")).toBe(0)
  store.setValidationProfile("model_validation_profile", {
    simulation_run_count: 10_000,
    canary_duration_ms: 20_000,
  })
  expect(store.getFinalizationReserveMs("model_validation_profile")).toBe(0)
  const control = JSON.parse(await Bun.file(join(model_dir, "run-control.json")).text())
  expect(control.finalization_reserve_ms).toBe(0)

  store.startSegment("model_validation_profile")
  await Bun.sleep(5)
  const paused = store.pauseSegment("model_validation_profile")
  expect(paused.segment_started_at).toBeUndefined()
  expect(paused.elapsed_time_ms).toBeGreaterThan(0)
  const restarted = store.restartSegment("model_validation_profile")
  expect(restarted.status).toBe("running")
  expect(restarted.elapsed_time_ms).toBe(0)
  expect(restarted.segment_started_at).toBeDefined()

  await rm(model_dir, { recursive: true, force: true })
})
