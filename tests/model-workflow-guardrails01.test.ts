import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentClient } from "@/server/infrastructure/agent"
import type { ProcessRunner } from "@/server/infrastructure/process"
import { JobStore } from "@/server/job-store"
import { ModelRunStore } from "@/server/model-run-store"
import { runModel } from "@/server/model-workflow"

const temporary_directories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

test("a terminal failed component is rejected by the wait stage with its own diagnostic", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "model-terminal-component-"))
  temporary_directories.push(job_dir)
  const model_dir = join(job_dir, "spice")
  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "failed_component", job_dir, file_name: "failed.pdf" })
  job_store.updateJob("failed_component", {
    display_status: "failed",
    is_complete: true,
    has_errors: true,
    component_ready: false,
    error_message: "Component pinout could not be resolved",
  })
  model_run_store.createModelRun({
    model_run_id: "failed_component_model",
    job_id: "failed_component",
    model_dir,
    effort_multiplier: 1,
  })
  const unused_agent: AgentClient = {
    async run() {
      throw new Error("agent must not run")
    },
  }
  const unused_process: ProcessRunner = {
    async run() {
      throw new Error("process must not run")
    },
  }

  await runModel(
    { model_run_id: "failed_component_model" },
    {
      job_store,
      model_run_store,
      agent_bin: "unused",
      tsci_bin: "unused",
      agent_client: unused_agent,
      process_runner: unused_process,
      ngspice_executor: async () => {
        throw new Error("ngspice must not run")
      },
    },
  )

  const run = model_run_store.getModelRun("failed_component_model")
  expect(run?.status).toBe("failed")
  expect(run?.pipeline?.stage_results.wait_for_component).toMatchObject({
    status: "failed",
    error: {
      code: "component_not_ready",
      message: "Component pinout could not be resolved",
    },
  })
  expect(run?.pipeline?.stage_results.prepare_workspace?.status).toBe("skipped")
})

test("an early component-ready milestone cannot race the final component publication", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "model-component-publication-race-"))
  temporary_directories.push(job_dir)
  const model_dir = join(job_dir, "spice")
  await Bun.write(join(job_dir, "component.circuit.tsx"), 'export default () => <chip name="U1" />\n')

  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "publishing_component", job_dir, file_name: "publishing.pdf" })
  job_store.updateJob("publishing_component", {
    display_status: "agent_running",
    is_complete: false,
    has_errors: false,
    component_ready: true,
  })
  model_run_store.createModelRun({
    model_run_id: "publishing_component_model",
    job_id: "publishing_component",
    model_dir,
    effort_multiplier: 1,
  })
  let agent_calls = 0
  let process_calls = 0
  const run_promise = runModel(
    { model_run_id: "publishing_component_model" },
    {
      job_store,
      model_run_store,
      agent_bin: "unused",
      tsci_bin: "unused",
      agent_client: {
        async run() {
          agent_calls += 1
          throw new Error("agent must not run")
        },
      },
      process_runner: {
        async run() {
          process_calls += 1
          throw new Error("process must not run")
        },
      },
      ngspice_executor: async () => {
        throw new Error("ngspice must not run")
      },
    },
  )

  await waitUntil(
    () => model_run_store.getModelRun("publishing_component_model")?.status === "waiting_for_component",
    "the model run to enter its component wait stage",
  )
  await Bun.sleep(10)
  expect(model_run_store.getModelRun("publishing_component_model")?.is_complete).toBe(false)
  expect(agent_calls).toBe(0)
  expect(process_calls).toBe(0)

  const pipeline_timestamp = new Date().toISOString()
  job_store.updateJob("publishing_component", {
    pipeline: {
      pipeline_id: "datasheet_component",
      status: "completed",
      sequence: 1,
      started_at: pipeline_timestamp,
      updated_at: pipeline_timestamp,
      stage_results: {
        publish: {
          stage_id: "publish",
          status: "completed",
          debug_ref: "runs/test/.pipeline/stages/publish",
        },
      },
    },
  })
  await run_promise

  const run = model_run_store.getModelRun("publishing_component_model")
  expect(run?.pipeline?.stage_results.wait_for_component?.status).toBe("completed")
  expect(run?.pipeline?.stage_results.prepare_workspace).toMatchObject({
    status: "failed",
    error: { message: expect.stringContaining("evidence-commit.json") },
  })
  expect(agent_calls).toBe(0)
  expect(process_calls).toBe(0)
})
