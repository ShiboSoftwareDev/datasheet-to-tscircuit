import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { atomicWriteJsonSync } from "@/server/infrastructure/persistence/atomic-write"
import { RECENT_LOG_EVENT_LIMIT } from "@/server/infrastructure/persistence/bounded-log"
import { ModelRunStore } from "@/server/model-run-store"
import { getModelRunFile } from "@/server/model-run-api/get-model-run-file"
import type { ModelRunApiContext } from "@/server/model-run-api/model-run-api-context"
import { markAcceptedArtifactsAsRetained } from "@/server/model-workflow/run-model"
import type { ModelRunnerContext } from "@/server/model-workflow/types"
import type { JobLog, ModelRun } from "@/shared/job-types"
import { RETAINED_ACCEPTED_WARNING_PREFIX } from "@/shared/model-warnings"

test("a failed replacement retains its candidate validation UI without replacing the accepted model", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-candidate-retention-"))
  const store = new ModelRunStore()
  try {
    store.createModelRun({
      model_run_id: "model_candidate_retention",
      job_id: "job_candidate_retention",
      model_dir,
      effort_multiplier: 1,
    })
    store.updateModelRun("model_candidate_retention", {
      model_source: ".SUBCKT ACCEPTED IN OUT\nR1 IN OUT 1k\n.ENDS ACCEPTED\n",
      manifest: { revision: "accepted-r1" } as ModelRun["manifest"],
      validation: {
        artifact_state: "accepted",
        model_revision: "accepted-r1",
        benchmark_count: 1,
        passing_count: 1,
        critical_count: 1,
        critical_passing_count: 1,
        all_critical_passed: true,
        all_passed: true,
        benchmarks: [],
      },
    })
    const context = { model_run_store: store } as ModelRunnerContext

    markAcceptedArtifactsAsRetained({
      context,
      model_run_id: "model_candidate_retention",
      state: "running",
    })
    expect(store.getModelRun("model_candidate_retention")?.validation).toBeUndefined()

    store.projectCandidateValidation("model_candidate_retention", {
      validation: {
        artifact_state: "candidate",
        model_revision: "candidate-r2",
        benchmark_count: 1,
        passing_count: 0,
        critical_count: 1,
        critical_passing_count: 0,
        all_critical_passed: false,
        all_passed: false,
        benchmarks: [],
      },
      preview_options: [
        {
          benchmark_id: "failed_case",
          title: "Failed case",
          circuit_file: "validation/cases/failed_case.circuit.tsx",
        },
      ],
      previews: {
        circuit_preview: {
          source_file: "validation/cases/failed_case.circuit.tsx",
          code: "export default () => <board />",
          build_status: "source_ready",
          updated_at: "2026-08-01T00:00:00.000Z",
        },
      },
    })
    markAcceptedArtifactsAsRetained({
      context,
      model_run_id: "model_candidate_retention",
      state: "failed",
    })

    expect(store.getModelRun("model_candidate_retention")).toMatchObject({
      model_source: expect.stringContaining("ACCEPTED"),
      manifest: { revision: "accepted-r1" },
      validation: { artifact_state: "candidate", model_revision: "candidate-r2" },
      preview_options: [{ benchmark_id: "failed_case" }],
      circuit_preview: { source_file: "validation/cases/failed_case.circuit.tsx" },
    })
    expect(store.getModelRun("model_candidate_retention")?.warnings?.[0]).toContain(
      "validation below belongs to the unaccepted candidate",
    )
  } finally {
    await rm(model_dir, { recursive: true, force: true })
  }
})

test("a development model is persisted and downloaded without becoming the accepted model", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-development-model-"))
  const store = new ModelRunStore()
  try {
    store.createModelRun({
      model_run_id: "model_development",
      job_id: "job_development",
      model_dir,
      effort_multiplier: 1,
    })
    store.projectDevelopmentModel("model_development", {
      model_source: ".SUBCKT DEVELOPMENT IN OUT\nR1 IN OUT 1k\n.ENDS DEVELOPMENT\n",
      model_card: "Current development candidate",
      manifest: {
        version: 1,
        part_number: "DEVELOPMENT",
        dialect: "portable",
        entry_name: "DEVELOPMENT",
        model_file: "model.lib",
        revision: "development-r1",
        simulator: "ngspice",
        generated_at: "2026-08-08T00:00:00.000Z",
        pins: [
          { component_pin: "1", spice_node: "IN" },
          { component_pin: "2", spice_node: "OUT" },
        ],
      },
    })

    expect(store.getModelRun("model_development")?.model_source).toBeUndefined()
    expect(store.getModelRun("model_development")?.development_model?.model_source).toContain("DEVELOPMENT")
    const checkpoint = JSON.parse(await readFile(join(model_dir, "model-run.json"), "utf8"))
    expect(checkpoint.development_model.model_source).toContain("DEVELOPMENT")

    const response = await getModelRunFile(
      new URL("http://localhost/api/model-run/file?job_id=job_development&file=development_model"),
      { model_run_store: store } as unknown as ModelRunApiContext,
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toContain(".SUBCKT DEVELOPMENT")
  } finally {
    await rm(model_dir, { recursive: true, force: true })
  }
})

test("ModelRunStore extends only the repair budget", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-store-"))
  const store = new ModelRunStore()
  store.createModelRun({
    model_run_id: "model_1",
    job_id: "job_1",
    model_dir,
    effort_multiplier: 1,
  })
  store.startSegment("model_1")
  const extended = store.extendModelRun("model_1", 2)

  expect(extended.status).toBe("extended")
  if (extended.status !== "extended") throw new Error("Expected the model run to be extended")
  expect(extended.should_start).toBe(false)
  expect(extended.model_run.effort_multiplier).toBe(3)
  expect(store.extendModelRun("model_1", 6).status).toBe("invalid_effort")
  expect(store.getModelRun("model_1")?.effort_multiplier).toBe(3)
  expect(store.requestCancellation("model_1")).toBe("requested")
  expect(store.getCancellationSignal("model_1")?.aborted).toBe(true)

  store.finishSegment("model_1", {
    status: "cancelled",
    is_complete: true,
    has_errors: false,
  })
  const continuation = store.retryModelRun("model_1")
  expect(continuation.status).toBe("retried")
  if (continuation.status !== "retried") throw new Error("Expected the stopped model run to retry")
  expect(continuation.model_run.status).toBe("queued")
  expect(continuation.model_run.effort_multiplier).toBe(3)
  expect(store.getCancellationSignal("model_1")?.aborted).toBe(false)

  await rm(model_dir, { recursive: true, force: true })
})

test("ModelRunStore retries a stopped run at the maximum repair budget", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-store-cancelled-retry-"))
  const store = new ModelRunStore()
  try {
    store.createModelRun({
      model_run_id: "model_cancelled",
      job_id: "job_cancelled",
      model_dir,
      effort_multiplier: 8,
    })
    store.finishSegment("model_cancelled", {
      status: "cancelled",
      is_complete: true,
      has_errors: false,
    })

    const retried = store.retryModelRun("model_cancelled")

    expect(retried.status).toBe("retried")
    expect(store.getModelRun("model_cancelled")).toMatchObject({
      status: "queued",
      is_complete: false,
      effort_multiplier: 8,
    })
  } finally {
    await rm(model_dir, { recursive: true, force: true })
  }
})

test("ModelRunStore restarts successful and timed-out runs without adding repair budget", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-store-finished-restart-"))
  const store = new ModelRunStore()
  try {
    for (const status of ["complete", "timed_out"] as const) {
      const model_run_id = `model_${status}`
      store.createModelRun({
        model_run_id,
        job_id: `job_${status}`,
        model_dir: join(model_dir, status),
        effort_multiplier: 4,
      })
      store.finishSegment(model_run_id, {
        status,
        is_complete: true,
        has_errors: status === "timed_out",
        error_message: status === "timed_out" ? "fixture timed out" : undefined,
      })

      const restarted = store.retryModelRun(model_run_id)

      expect(restarted.status).toBe("retried")
      expect(store.getModelRun(model_run_id)).toMatchObject({
        status: "queued",
        is_complete: false,
        has_errors: false,
        effort_multiplier: 4,
      })
      expect(store.getModelRun(model_run_id)?.error_message).toBeUndefined()
    }
  } finally {
    await rm(model_dir, { recursive: true, force: true })
  }
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
    })

    expect(store.claimModelExecution("model_lease")).toBe(true)
    expect(store.claimModelExecution("model_lease")).toBe(false)
    store.updateModelRun("model_lease", { status: "failed", is_complete: true, has_errors: true })
    expect(store.retryModelRun("model_lease").status).toBe("busy")
    store.releaseModelExecution("model_lease")
    expect(store.retryModelRun("model_lease").status).toBe("retried")
    expect(store.claimModelExecution("model_lease")).toBe(true)
    store.releaseModelExecution("model_lease")
  } finally {
    await rm(model_dir, { recursive: true, force: true })
  }
})

test("ModelRunStore atomically creates one run per job and publishes compact summaries", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-store-summary-"))
  const store = new ModelRunStore()
  const summaries: Array<{ status: string; has_model: boolean; has_retained_accepted_model: boolean }> = []
  const unsubscribe = store.subscribeToModelRunList((summary) => {
    summaries.push({
      status: summary.status,
      has_model: summary.has_model,
      has_retained_accepted_model: summary.has_retained_accepted_model,
    })
  })
  try {
    const created = store.createModelRunIfAbsent({
      model_run_id: "model_summary",
      job_id: "job_summary",
      model_dir,
      effort_multiplier: 1,
    })
    const duplicate = store.createModelRunIfAbsent({
      model_run_id: "model_duplicate",
      job_id: "job_summary",
      model_dir,
      effort_multiplier: 4,
    })
    store.updateModelRun("model_summary", {
      status: "failed",
      is_complete: true,
      has_errors: true,
      warnings: [`${RETAINED_ACCEPTED_WARNING_PREFIX} r0001 because the replacement attempt failed.`],
    })
    store.updateModelRun("model_summary", {
      status: "complete",
      is_complete: true,
      has_errors: false,
      model_source: ".SUBCKT FIXTURE IN OUT\n.ENDS FIXTURE\n",
      warnings: [`${RETAINED_ACCEPTED_WARNING_PREFIX} r0001 from an inconsistent completed checkpoint.`],
    })
    store.updateModelRun("model_summary", {
      status: "failed",
      is_complete: true,
      has_errors: true,
      warnings: ["The accepted publication mirror could not be refreshed."],
    })
    store.updateModelRun("model_summary", {
      warnings: [`${RETAINED_ACCEPTED_WARNING_PREFIX} r0001 because the replacement attempt failed.`],
    })

    expect(created.status).toBe("created")
    expect(duplicate.status).toBe("already_exists")
    expect(duplicate.model_run.model_run_id).toBe("model_summary")
    expect(summaries).toEqual([
      { status: "queued", has_model: false, has_retained_accepted_model: false },
      { status: "failed", has_model: false, has_retained_accepted_model: false },
      { status: "complete", has_model: true, has_retained_accepted_model: false },
      { status: "failed", has_model: true, has_retained_accepted_model: false },
      { status: "failed", has_model: true, has_retained_accepted_model: true },
    ])
  } finally {
    unsubscribe()
    await rm(model_dir, { recursive: true, force: true })
  }
})

test("ModelRunStore isolates failed observers from persisted workflow state", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-observer-"))
  const store = new ModelRunStore()
  store.createModelRun({
    model_run_id: "model_observer",
    job_id: "job_observer",
    model_dir,
    effort_multiplier: 1,
  })
  store.subscribe("model_observer", () => {
    throw new Error("closed response stream")
  })

  expect(() => store.updateModelRun("model_observer", { status: "validating" })).not.toThrow()
  expect(store.getModelRun("model_observer")?.status).toBe("validating")
  expect((await Bun.file(join(model_dir, "model-run.json")).json()).status).toBe("validating")

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

test("ModelRunStore preserves elapsed active-segment time across a restart", async () => {
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

test("ModelRunStore finishes a segment while preserving its repair budget", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-validation-profile-"))
  const store = new ModelRunStore()
  store.createModelRun({
    model_run_id: "model_validation_profile",
    job_id: "job_validation_profile",
    model_dir,
    effort_multiplier: 1,
  })

  store.startSegment("model_validation_profile")
  await Bun.sleep(5)
  const finished = store.finishSegment("model_validation_profile", {
    status: "complete",
    is_complete: true,
    has_errors: false,
  })
  expect(finished.status).toBe("complete")
  expect(finished.effort_multiplier).toBe(1)
  expect(finished.elapsed_time_ms).toBeGreaterThan(0)
  expect(finished.segment_started_at).toBeUndefined()

  await rm(model_dir, { recursive: true, force: true })
})

test("ModelRunStore rolls back nested mutations and events when a checkpoint fails", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-transaction-"))
  let reject_checkpoints = false
  const store = new ModelRunStore({
    checkpoint_writer(path, value) {
      if (reject_checkpoints) throw new Error("fixture model checkpoint failure")
      atomicWriteJsonSync(path, value)
    },
  })
  const run_events: string[] = []
  const list_statuses: string[] = []
  try {
    store.createModelRun({
      model_run_id: "model_transaction",
      job_id: "job_transaction",
      model_dir,
      effort_multiplier: 1,
    })
    store.subscribe("model_transaction", (event) => run_events.push(event.event_type))
    store.subscribeToModelRunList((summary) => list_statuses.push(summary.status))
    const checkpoint_before = await readFile(join(model_dir, "model-run.json"), "utf8")
    reject_checkpoints = true

    expect(() =>
      store.updateProgress("model_transaction", {
        sequence: 1,
        phase: "scoring",
        message: "This candidate must not leak into memory",
        updated_at: new Date().toISOString(),
        iteration: 3,
      }),
    ).toThrow("fixture model checkpoint failure")
    expect(store.getModelRun("model_transaction")).toMatchObject({
      status: "queued",
      iteration: 0,
      progress: undefined,
      progress_history: [],
    })
    expect(await readFile(join(model_dir, "model-run.json"), "utf8")).toBe(checkpoint_before)
    expect(run_events).toEqual([])
    expect(list_statuses).toEqual([])

    expect(() => store.requestCancellation("model_transaction")).toThrow("fixture model checkpoint failure")
    expect(store.getCancellationSignal("model_transaction")?.aborted).toBe(true)
    expect(store.getModelRun("model_transaction")?.status).toBe("queued")
    expect(store.requestCancellation("model_transaction")).toBe("already_requested")
    expect(run_events).toEqual([])
    expect(list_statuses).toEqual([])
  } finally {
    await rm(model_dir, { recursive: true, force: true })
  }
})

test("ModelRunStore does not expose a creation whose first checkpoint fails", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-create-failure-"))
  const store = new ModelRunStore({
    checkpoint_writer() {
      throw new Error("fixture initial model checkpoint failure")
    },
  })
  const list_statuses: string[] = []
  store.subscribeToModelRunList((summary) => list_statuses.push(summary.status))
  try {
    expect(() =>
      store.createModelRun({
        model_run_id: "model_not_created",
        job_id: "job_not_created",
        model_dir,
        effort_multiplier: 1,
      }),
    ).toThrow("fixture initial model checkpoint failure")
    expect(store.getModelRun("model_not_created")).toBeUndefined()
    expect(store.getModelRunForJob("job_not_created")).toBeUndefined()
    expect(list_statuses).toEqual([])
  } finally {
    await rm(model_dir, { recursive: true, force: true })
  }
})

test("ModelRunStore durably appends one log event before memory and never checkpoints logs", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-log-order-"))
  let checkpoint_writes = 0
  let release_first_append: (() => void) | undefined
  const first_append_gate = new Promise<void>((resolve) => {
    release_first_append = resolve
  })
  const persisted_logs: JobLog[] = []
  let log_attempt = 0
  const store = new ModelRunStore({
    checkpoint_writer(path, value) {
      checkpoint_writes += 1
      atomicWriteJsonSync(path, value)
    },
    async log_writer(_path, log) {
      log_attempt += 1
      if (log_attempt === 1) await first_append_gate
      else throw new Error("fixture log append failure")
      persisted_logs.push(log)
    },
  })
  const published_logs: JobLog[] = []
  try {
    store.createModelRun({
      model_run_id: "model_log_order",
      job_id: "job_log_order",
      model_dir,
      effort_multiplier: 1,
    })
    const checkpoint_before = await readFile(join(model_dir, "model-run.json"), "utf8")
    store.subscribe("model_log_order", (event) => {
      if (event.event_type === "log") published_logs.push(event.log)
    })

    const pending_append = store.appendLog("model_log_order", {
      stream: "stdout",
      message: "durable first",
    })
    expect(store.getModelRun("model_log_order")?.logs).toEqual([])
    expect(published_logs).toEqual([])
    release_first_append?.()
    const first_log = await pending_append

    expect(persisted_logs).toEqual([first_log])
    expect(store.getModelRun("model_log_order")?.logs).toEqual([first_log])
    expect(published_logs).toEqual([first_log])
    expect(checkpoint_writes).toBe(1)
    expect(await readFile(join(model_dir, "model-run.json"), "utf8")).toBe(checkpoint_before)

    await expect(
      store.appendLog("model_log_order", { stream: "stderr", message: "must roll back" }),
    ).rejects.toThrow("fixture log append failure")
    expect(store.getModelRun("model_log_order")?.logs).toEqual([first_log])
    expect(published_logs).toEqual([first_log])
    expect(checkpoint_writes).toBe(1)
  } finally {
    await rm(model_dir, { recursive: true, force: true })
  }
})

test("ModelRunStore writes a real log append as one NDJSON record without rewriting its checkpoint", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-log-ndjson-"))
  const store = new ModelRunStore()
  try {
    store.createModelRun({
      model_run_id: "model_log_ndjson",
      job_id: "job_log_ndjson",
      model_dir,
      effort_multiplier: 1,
    })
    const checkpoint_before = await readFile(join(model_dir, "model-run.json"), "utf8")
    const log = await store.appendLog("model_log_ndjson", {
      stream: "stdout",
      message: "first line\nsecond line\n",
    })
    const persisted_lines = (await readFile(join(model_dir, "model-agent.log"), "utf8")).trimEnd().split("\n")

    expect(persisted_lines).toHaveLength(1)
    expect(JSON.parse(persisted_lines[0] ?? "null")).toEqual(log)
    expect(await readFile(join(model_dir, "model-run.json"), "utf8")).toBe(checkpoint_before)
  } finally {
    await rm(model_dir, { recursive: true, force: true })
  }
})

test("ModelRunStore bounds retained logs without dropping live log events", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-log-window-"))
  const store = new ModelRunStore({ log_writer: async () => undefined })
  let published_count = 0
  try {
    store.createModelRun({
      model_run_id: "model_log_window",
      job_id: "job_log_window",
      model_dir,
      effort_multiplier: 1,
    })
    store.subscribe("model_log_window", (event) => {
      if (event.event_type === "log") published_count += 1
    })
    const event_count = RECENT_LOG_EVENT_LIMIT + 12
    for (let index = 0; index < event_count; index += 1) {
      await store.appendLog("model_log_window", { stream: "stdout", message: `model-${index}` })
    }

    const retained = store.getModelRun("model_log_window")?.logs ?? []
    expect(retained).toHaveLength(RECENT_LOG_EVENT_LIMIT)
    expect(retained[0]?.message).toBe("model-12")
    expect(retained.at(-1)?.message).toBe(`model-${event_count - 1}`)
    expect(published_count).toBe(event_count)
  } finally {
    await rm(model_dir, { recursive: true, force: true })
  }
})
