import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { JobStore } from "@/server/job-store"
import { ModelRunStore } from "@/server/model-run-store"
import { ModelStrategyRegistry } from "@/server/modeling"
import {
  waitForComponentBeforePublication,
  waitForModelEvidenceBeforeComparison,
  waitForComponentStage,
} from "@/server/model-workflow/stages/wait-for-component"

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

test("the publication join rejects a terminal failed component with its own diagnostic", async () => {
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
  let caught: unknown
  try {
    await waitForComponentStage.execute({
      run_id: "failed_component_model",
      pipeline_id: "spice_generation",
      stage_id: "wait_for_component",
      debug_dir: join(model_dir, "debug"),
      context: {
        model_run_id: "failed_component_model",
        job_id: "failed_component",
        job_dir,
        model_dir,
        use_openai: false,
        max_repair_attempts: 1,
        invocation_id: "failed-component",
      },
      services: {
        job_store,
        model_run_store,
        agent_client: {
          async run() {
            throw new Error("agent must not run")
          },
        },
        process_runner: {
          async run() {
            throw new Error("process must not run")
          },
        },
        strategy_registry: new ModelStrategyRegistry(),
        tsci_bin: "unused",
        ngspice_bin: "unused",
        ngspice_executor: async () => {
          throw new Error("ngspice must not run")
        },
      },
      dependency_outputs: {
        repair_spice_model: {
          result_path: "unused",
          model_path: "unused",
          model_card_path: "unused",
          manifest_path: "unused",
          contract_path: "unused",
          plan_path: "unused",
          evidence_dir: "unused",
          passed: true,
          repair_attempts: 0,
          revision: "unused",
        },
      },
      signal: new AbortController().signal,
    })
  } catch (error) {
    caught = error
  }
  expect(caught).toMatchObject({
    diagnostic: {
      code: "component_not_ready",
      message: "Component pinout could not be resolved",
    },
  })
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
  const wait_promise = waitForComponentBeforePublication({
    job_id: "publishing_component",
    model_run_id: "publishing_component_model",
    job_store,
    model_run_store,
    signal: new AbortController().signal,
  })

  await waitUntil(
    () => model_run_store.getModelRun("publishing_component_model")?.status === "waiting_for_component",
    "the model run to enter its component wait stage",
  )
  await Bun.sleep(10)
  expect(model_run_store.getModelRun("publishing_component_model")?.is_complete).toBe(false)

  const pipeline_timestamp = new Date().toISOString()
  job_store.updateJob("publishing_component", {
    pipelines: {
      component_generation: {
        pipeline_id: "component_generation",
        status: "completed",
        sequence: 1,
        started_at: pipeline_timestamp,
        updated_at: pipeline_timestamp,
        stage_results: {
          repair_component: {
            stage_id: "repair_component",
            status: "completed",
            debug_ref: "runs/test/.pipeline/stages/repair_component",
          },
        },
      },
    },
  })
  await wait_promise

  const run = model_run_store.getModelRun("publishing_component_model")
  expect(run?.status).toBe("waiting_for_component")
  expect(run?.is_complete).toBe(false)
})

test("a Local model-evidence barrier refreshes an externally advancing job", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "model-evidence-external-refresh-"))
  temporary_directories.push(job_dir)
  const model_dir = join(job_dir, "spice")
  const job_store = new JobStore()
  const model_run_store = new ModelRunStore()
  job_store.createJob({ job_id: "external_evidence", job_dir, file_name: "external.pdf" })
  job_store.updateJob("external_evidence", {
    display_status: "agent_running",
    is_complete: false,
    has_errors: false,
    pipelines: {
      component_generation: {
        pipeline_id: "component_generation",
        status: "running",
        sequence: 1,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        stage_results: {},
      },
      typical_application: {
        pipeline_id: "typical_application",
        status: "running",
        sequence: 1,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        stage_results: {},
      },
    },
  })
  model_run_store.createModelRun({
    model_run_id: "external_evidence_model",
    job_id: "external_evidence",
    model_dir,
    effort_multiplier: 1,
  })

  let refresh_count = 0
  const wait_promise = waitForModelEvidenceBeforeComparison({
    job_id: "external_evidence",
    model_run_id: "external_evidence_model",
    job_store,
    model_run_store,
    signal: new AbortController().signal,
    refresh_interval_ms: 1,
    refresh_job: async () => {
      refresh_count += 1
      if (refresh_count < 2) return
      const timestamp = new Date().toISOString()
      job_store.updateJob("external_evidence", {
        evidence_available: true,
        pipelines: {
          component_generation: {
            pipeline_id: "component_generation",
            status: "running",
            sequence: 1,
            started_at: timestamp,
            updated_at: timestamp,
            stage_results: {},
          },
          typical_application: {
            pipeline_id: "typical_application",
            status: "running",
            sequence: 2,
            started_at: timestamp,
            updated_at: timestamp,
            stage_results: {
              extract_application_evidence: {
                stage_id: "extract_application_evidence",
                status: "completed",
                debug_ref: "runs/test/extract_application_evidence",
              },
            },
          },
        },
      })
    },
  })

  await wait_promise
  expect(refresh_count).toBe(2)
})
