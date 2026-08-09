import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { INTERRUPTED_LOCAL_RUN_MESSAGE, reconcileInterruptedLocalRun } from "@/server/local-runs"
import type { LocalRunSummary } from "@/shared/local-run"

async function writeRunningSummary(root: string, heartbeatAt: string): Promise<LocalRunSummary> {
  const localRunId = "local-11111111-2222-4333-8444-555555555555"
  const executionDir = join(root, ".runtime", "local", localRunId)
  const workspaceDir = join(root, ".runtime", "jobs", "heartbeat-job")
  const summaryPath = join(executionDir, "summary.json")
  const summary: LocalRunSummary = {
    version: 2,
    local_run_id: localRunId,
    execution_kind: "in_place",
    mode: "task",
    pipeline_id: "spice_generation",
    task_id: "repair_spice_model",
    source_run_id: "source-run",
    source_job_id: "heartbeat-job",
    target_job_id: "heartbeat-job",
    file_name: "heartbeat.pdf",
    status: "running",
    created_at: "2026-08-09T00:00:00.000Z",
    heartbeat_at: heartbeatAt,
    execution_dir: executionDir,
    workspace_dir: workspaceDir,
    input_path: join(executionDir, "input.json"),
    pipeline_dir: join(workspaceDir, "spice", "runs", "invocation", ".pipeline"),
    events_path: join(workspaceDir, "spice", "runs", "invocation", ".pipeline", "events.ndjson"),
    summary_path: summaryPath,
    stage_results: {},
  }
  await mkdir(executionDir, { recursive: true })
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  return summary
}

test("a fresh Local heartbeat remains running", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-heartbeat-fresh-"))
  try {
    const summary = await writeRunningSummary(root, "2026-08-09T00:00:55.000Z")
    const reconciled = await reconcileInterruptedLocalRun({
      local_root: join(root, ".runtime", "local"),
      local_run_id: summary.local_run_id,
      now: new Date("2026-08-09T00:01:00.000Z").valueOf(),
      stale_after_ms: 10_000,
    })
    expect(reconciled.status).toBe("running")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an expired Local heartbeat becomes a durable interrupted failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-heartbeat-stale-"))
  try {
    const summary = await writeRunningSummary(root, "2026-08-09T00:00:20.000Z")
    const reconciled = await reconcileInterruptedLocalRun({
      local_root: join(root, ".runtime", "local"),
      local_run_id: summary.local_run_id,
      now: new Date("2026-08-09T00:01:00.000Z").valueOf(),
      stale_after_ms: 10_000,
    })
    expect(reconciled).toMatchObject({
      status: "failed",
      completed_at: "2026-08-09T00:01:00.000Z",
      error_message: INTERRUPTED_LOCAL_RUN_MESSAGE,
    })
    expect(JSON.parse(await readFile(summary.summary_path, "utf8"))).toMatchObject({
      status: "failed",
      error_message: INTERRUPTED_LOCAL_RUN_MESSAGE,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
