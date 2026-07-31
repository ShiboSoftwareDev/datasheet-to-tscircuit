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
