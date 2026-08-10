import { expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runDebugCli } from "@/cli/pipeline-debug"
import { JobStore } from "@/server/job-store"
import { restorePersistedJobs } from "@/server/job-restorer"
import { createLocalRunApiHandler } from "@/server/local-run-api"
import { ModelRunStore } from "@/server/model-run-store"
import { retainPipelineTaskInputFiles } from "@/server/pipeline"
import type { LocalRunDetail, LocalRunSummary } from "@/shared/local-run"
import type { PipelineTaskInputEnvelope } from "@/shared/pipeline-types"

async function createRepairInput(rootDir: string): Promise<string> {
  const jobId = "local-api-job"
  const jobDir = join(rootDir, ".runtime", "jobs", jobId)
  const debugRef = "runs/component_generation/original/.pipeline/stages/05-repair_component"
  const debugDir = join(jobDir, debugRef)
  await mkdir(debugDir, { recursive: true })
  await writeFile(join(jobDir, "datasheet.pdf"), "%PDF-1.4\nLocal API fixture\n%%EOF\n")
  const store = new JobStore()
  store.createJob({ job_id: jobId, job_dir: jobDir, file_name: "local-api.pdf" })
  await Promise.all([
    writeFile(join(jobDir, "index.circuit.tsx"), "export default () => null\n"),
    writeFile(
      join(jobDir, "component-validation.json"),
      `${JSON.stringify({
        version: 1,
        passed: true,
        errors: [],
        circuit_json: [
          {
            type: "source_component",
            source_component_id: "source_component_u1",
            name: "U1",
          },
        ],
      })}\n`,
    ),
  ])
  store.updateJob(jobId, {
    display_status: "complete",
    is_complete: true,
    pipeline: {
      pipeline_id: "component_generation",
      status: "completed",
      sequence: 1,
      started_at: "2026-08-05T08:00:00.000Z",
      updated_at: "2026-08-05T08:00:01.000Z",
      stage_results: {
        repair_component: {
          stage_id: "repair_component",
          status: "completed",
          debug_ref: debugRef,
        },
      },
    },
  })
  const inputFiles = await retainPipelineTaskInputFiles({
    root_dir: jobDir,
    debug_dir: debugDir,
    objects_dir: join(jobDir, "runs", "component_generation", "original", ".pipeline", "input-objects"),
    excluded_roots: ["spice"],
  })
  const envelope: PipelineTaskInputEnvelope = {
    version: 2,
    kind: "pipeline_task_input",
    pipeline_id: "component_generation",
    task_id: "repair_component",
    run_id: "source-run",
    execution_context: {
      job_id: jobId,
      job_dir: jobDir,
      use_openai: false,
      invocation_id: "source-invocation",
    },
    depends_on: ["validate_component"],
    dependency_statuses: { validate_component: "completed" },
    dependency_outputs: {
      validate_component: {
        result_path: join(jobDir, "component-validation.json"),
        passed: true,
        errors: [],
      },
    },
    input_files: inputFiles,
  }
  const inputPath = join(debugDir, "input.json")
  await writeFile(inputPath, `${JSON.stringify(envelope, null, 2)}\n`)
  return inputPath
}

type LocalHandler = ReturnType<typeof createLocalRunApiHandler>

async function handleResponse(handler: LocalHandler, request: Request): Promise<Response> {
  const response = await handler(request)
  if (!response) throw new Error(`Local handler ignored ${request.method} ${request.url}`)
  return response
}

async function waitForLocalCompletion(handler: LocalHandler, localRunId: string): Promise<LocalRunDetail> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await handleResponse(
      handler,
      new Request(`http://localhost/api/local-run/get?local_run_id=${encodeURIComponent(localRunId)}`),
    )
    if (response.ok) {
      const detail = (await response.json()) as LocalRunDetail
      if (detail.local_run.status !== "running") return detail
    }
    await Bun.sleep(20)
  }
  throw new Error(`Local run ${localRunId} did not complete`)
}

test("the server runs and reruns Local tasks in their selected regular job", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "datasheet-local-api-"))
  try {
    await createRepairInput(rootDir)

    const jobStore = new JobStore()
    const modelRunStore = new ModelRunStore()
    await restorePersistedJobs({
      jobs_root: join(rootDir, ".runtime", "jobs"),
      job_store: jobStore,
      model_run_store: modelRunStore,
    })
    const handler = createLocalRunApiHandler({
      root_dir: rootDir,
      jobs_root: join(rootDir, ".runtime", "jobs"),
      local_runs_root: join(rootDir, ".runtime", "local"),
      job_store: jobStore,
      model_run_store: modelRunStore,
      agent_bin: join(rootDir, "node_modules", ".bin", "tsci-agent"),
      tsci_bin: join(rootDir, "node_modules", ".bin", "tsci"),
    })

    const startResponse = await handleResponse(
      handler,
      new Request("http://localhost/api/local-run/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: "local-api-job",
          pipeline_id: "component_generation",
          mode: "stage",
          stage_id: "repair_component",
        }),
      }),
    )
    expect(startResponse.status).toBe(202)
    const started = (await startResponse.json()) as { local_run: LocalRunSummary }
    const firstDetail = await waitForLocalCompletion(handler, started.local_run.local_run_id)
    const first = firstDetail.local_run
    expect(first).toMatchObject({
      version: 2,
      execution_kind: "in_place",
      source_job_id: "local-api-job",
      target_job_id: "local-api-job",
      status: "completed",
      workspace_dir: join(rootDir, ".runtime", "jobs", "local-api-job"),
    })

    const cliList = (await runDebugCli(["local", "list", "--root", rootDir])) as {
      local_runs: LocalRunSummary[]
    }
    expect(cliList.local_runs.map(({ local_run_id }) => local_run_id)).toContain(first.local_run_id)
    expect(
      await handler(new Request(`http://localhost/?local_run_id=${encodeURIComponent(first.local_run_id)}`)),
    ).toBeUndefined()

    const listResponse = await handleResponse(handler, new Request("http://localhost/api/local-runs"))
    expect(listResponse.ok).toBe(true)
    const listed = (await listResponse.json()) as { local_runs: LocalRunSummary[] }
    expect(listed.local_runs.map(({ local_run_id }) => local_run_id)).toContain(first.local_run_id)

    const detailResponse = await handleResponse(
      handler,
      new Request(
        `http://localhost/api/local-run/get?local_run_id=${encodeURIComponent(first.local_run_id)}`,
      ),
    )
    expect(detailResponse.ok).toBe(true)
    const detail = (await detailResponse.json()) as LocalRunDetail
    expect(detail.job.file_name).toBe("local-api.pdf")
    expect(detail.job.display_status).toBe("complete")

    expect(detail.job.job_id).toBe("local-api-job")
    expect(
      await handler(
        new Request(
          `http://localhost/api/job/file?job_id=local-api-job&file=log&local_run_id=${encodeURIComponent(first.local_run_id)}`,
        ),
      ),
    ).toBeUndefined()

    const rerunResponse = await handleResponse(
      handler,
      new Request("http://localhost/api/local-run/rerun", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ local_run_id: first.local_run_id }),
      }),
    )
    expect(rerunResponse.status).toBe(202)
    const rerun = (await rerunResponse.json()) as { local_run: LocalRunSummary }
    expect(rerun.local_run.local_run_id).not.toBe(first.local_run_id)
    expect(rerun.local_run.parent_local_run_id).toBe(first.local_run_id)
    expect(rerun.local_run.target_job_id).toBe("local-api-job")
    const completedRerun = await waitForLocalCompletion(handler, rerun.local_run.local_run_id)
    expect(completedRerun.local_run.status).toBe("completed")

    const latestListResponse = await handleResponse(handler, new Request("http://localhost/api/local-runs"))
    const latestListed = (await latestListResponse.json()) as { local_runs: LocalRunSummary[] }
    expect(latestListed.local_runs).toHaveLength(1)
    expect(latestListed.local_runs[0]?.local_run_id).toBe(rerun.local_run.local_run_id)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test("an already-running server imports a regular job created by a separate CLI process", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "datasheet-local-cli-sync-"))
  try {
    const inputPath = await createRepairInput(rootDir)
    const jobStore = new JobStore()
    const modelRunStore = new ModelRunStore()
    await restorePersistedJobs({
      jobs_root: join(rootDir, ".runtime", "jobs"),
      job_store: jobStore,
      model_run_store: modelRunStore,
    })
    const handler = createLocalRunApiHandler({
      root_dir: rootDir,
      jobs_root: join(rootDir, ".runtime", "jobs"),
      local_runs_root: join(rootDir, ".runtime", "local"),
      job_store: jobStore,
      model_run_store: modelRunStore,
      agent_bin: join(rootDir, "node_modules", ".bin", "tsci-agent"),
      tsci_bin: join(rootDir, "node_modules", ".bin", "tsci"),
    })

    const cliRun = (await runDebugCli([
      "task",
      "run",
      "--input",
      inputPath,
      "--root",
      rootDir,
    ])) as LocalRunSummary
    expect(cliRun.execution_kind).toBe("clone")
    expect(jobStore.getJob(cliRun.target_job_id!)).toBeUndefined()

    const listResponse = await handleResponse(handler, new Request("http://localhost/api/local-runs"))
    expect(listResponse.ok).toBe(true)
    const listed = (await listResponse.json()) as { local_runs: LocalRunSummary[] }
    expect(listed.local_runs.map(({ local_run_id }) => local_run_id)).toContain(cliRun.local_run_id)
    const detail = await handleResponse(
      handler,
      new Request(
        `http://localhost/api/local-run/get?local_run_id=${encodeURIComponent(cliRun.local_run_id)}`,
      ),
    )
    expect(detail.ok).toBe(true)
    expect(jobStore.getJob(cliRun.target_job_id!)?.job_id).toBe(cliRun.target_job_id)
    expect(((await detail.json()) as LocalRunDetail).job.job_id).toBe(cliRun.target_job_id!)
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test("Local records whose target job was deleted are omitted without checkpoint refresh", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "datasheet-local-deleted-target-"))
  try {
    const inputPath = await createRepairInput(rootDir)
    const cliRun = (await runDebugCli([
      "task",
      "run",
      "--input",
      inputPath,
      "--root",
      rootDir,
    ])) as LocalRunSummary
    if (!cliRun.target_job_id) throw new Error("Expected the CLI run to create a target job")
    await rm(join(rootDir, ".runtime", "jobs", cliRun.target_job_id), {
      recursive: true,
      force: true,
    })

    const jobStore = new JobStore()
    const modelRunStore = new ModelRunStore()
    await restorePersistedJobs({
      jobs_root: join(rootDir, ".runtime", "jobs"),
      job_store: jobStore,
      model_run_store: modelRunStore,
    })
    const handler = createLocalRunApiHandler({
      root_dir: rootDir,
      jobs_root: join(rootDir, ".runtime", "jobs"),
      local_runs_root: join(rootDir, ".runtime", "local"),
      job_store: jobStore,
      model_run_store: modelRunStore,
      agent_bin: join(rootDir, "node_modules", ".bin", "tsci-agent"),
      tsci_bin: join(rootDir, "node_modules", ".bin", "tsci"),
    })

    const listResponse = await handleResponse(handler, new Request("http://localhost/api/local-runs"))
    expect(listResponse.ok).toBe(true)
    expect((await listResponse.json()) as { local_runs: LocalRunSummary[] }).toEqual({
      local_runs: [],
    })
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test("the server reconciles an abandoned CLI execution instead of showing it as running forever", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "datasheet-local-interrupted-"))
  try {
    await createRepairInput(rootDir)
    const completed = (await runDebugCli([
      "local",
      "run",
      "local-api-job",
      "--pipeline",
      "component_generation",
      "--task",
      "repair_component",
      "--root",
      rootDir,
    ])) as LocalRunSummary

    const savedSummary = JSON.parse(await readFile(completed.summary_path, "utf8")) as Record<string, unknown>
    delete savedSummary.completed_at
    delete savedSummary.error_message
    await writeFile(
      completed.summary_path,
      `${JSON.stringify({
        ...savedSummary,
        status: "running",
        heartbeat_at: "2026-08-01T00:00:00.000Z",
      })}\n`,
    )

    const jobCheckpointPath = join(rootDir, ".runtime", "jobs", "local-api-job", "job.json")
    const jobCheckpoint = JSON.parse(await readFile(jobCheckpointPath, "utf8")) as Record<string, unknown>
    delete jobCheckpoint.completed_at
    delete jobCheckpoint.error_message
    await writeFile(
      jobCheckpointPath,
      `${JSON.stringify({
        ...jobCheckpoint,
        display_status: "agent_running",
        is_complete: false,
        has_errors: false,
      })}\n`,
    )

    const jobStore = new JobStore()
    const modelRunStore = new ModelRunStore()
    await restorePersistedJobs({
      jobs_root: join(rootDir, ".runtime", "jobs"),
      job_store: jobStore,
      model_run_store: modelRunStore,
    })
    const handler = createLocalRunApiHandler({
      root_dir: rootDir,
      jobs_root: join(rootDir, ".runtime", "jobs"),
      local_runs_root: join(rootDir, ".runtime", "local"),
      job_store: jobStore,
      model_run_store: modelRunStore,
      agent_bin: join(rootDir, "node_modules", ".bin", "tsci-agent"),
      tsci_bin: join(rootDir, "node_modules", ".bin", "tsci"),
    })

    const response = await handleResponse(
      handler,
      new Request(
        `http://localhost/api/local-run/get?local_run_id=${encodeURIComponent(completed.local_run_id)}`,
      ),
    )
    expect(response.ok).toBe(true)
    const detail = (await response.json()) as LocalRunDetail
    expect(detail.local_run).toMatchObject({ status: "failed" })
    expect(detail.local_run.error_message).toContain("stopped before it recorded a terminal result")
    expect(detail.job).toMatchObject({ display_status: "failed", is_complete: true, has_errors: true })
  } finally {
    await rm(rootDir, { recursive: true, force: true })
  }
})

test("regular-job Local records rebase and remain runnable after the runtime root is mounted elsewhere", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "datasheet-local-source-"))
  try {
    await createRepairInput(sourceRoot)
    const sourceJobStore = new JobStore()
    const sourceModelRunStore = new ModelRunStore()
    await restorePersistedJobs({
      jobs_root: join(sourceRoot, ".runtime", "jobs"),
      job_store: sourceJobStore,
      model_run_store: sourceModelRunStore,
    })
    const sourceHandler = createLocalRunApiHandler({
      root_dir: sourceRoot,
      jobs_root: join(sourceRoot, ".runtime", "jobs"),
      local_runs_root: join(sourceRoot, ".runtime", "local"),
      job_store: sourceJobStore,
      model_run_store: sourceModelRunStore,
      agent_bin: join(sourceRoot, "node_modules", ".bin", "tsci-agent"),
      tsci_bin: join(sourceRoot, "node_modules", ".bin", "tsci"),
    })
    const startResponse = await handleResponse(
      sourceHandler,
      new Request("http://localhost/api/local-run/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: "local-api-job",
          pipeline_id: "component_generation",
          mode: "stage",
          stage_id: "repair_component",
        }),
      }),
    )
    const started = (await startResponse.json()) as { local_run: LocalRunSummary }
    const first = (await waitForLocalCompletion(sourceHandler, started.local_run.local_run_id)).local_run
    const mountedRoot = join(sourceRoot, "container-root")
    const mountedLocalRoot = join(mountedRoot, ".runtime", "local")
    const mountedRunDir = join(mountedLocalRoot, first.local_run_id)
    await mkdir(mountedLocalRoot, { recursive: true })
    await cp(first.execution_dir, mountedRunDir, { recursive: true })
    await mkdir(join(mountedRoot, ".runtime", "jobs"), { recursive: true })
    await cp(
      join(sourceRoot, ".runtime", "jobs", "local-api-job"),
      join(mountedRoot, ".runtime", "jobs", "local-api-job"),
      { recursive: true },
    )
    const realMountedRunDir = await realpath(mountedRunDir)

    const mountedJobStore = new JobStore()
    const mountedModelRunStore = new ModelRunStore()
    await restorePersistedJobs({
      jobs_root: join(mountedRoot, ".runtime", "jobs"),
      job_store: mountedJobStore,
      model_run_store: mountedModelRunStore,
    })

    const handler = createLocalRunApiHandler({
      root_dir: mountedRoot,
      jobs_root: join(mountedRoot, ".runtime", "jobs"),
      local_runs_root: mountedLocalRoot,
      job_store: mountedJobStore,
      model_run_store: mountedModelRunStore,
      agent_bin: join(mountedRoot, "node_modules", ".bin", "tsci-agent"),
      tsci_bin: join(mountedRoot, "node_modules", ".bin", "tsci"),
    })

    const listResponse = await handleResponse(handler, new Request("http://localhost/api/local-runs"))
    const listed = (await listResponse.json()) as { local_runs: LocalRunSummary[] }
    expect(listed.local_runs).toHaveLength(1)
    expect(listed.local_runs[0]).toMatchObject({
      local_run_id: first.local_run_id,
      execution_dir: realMountedRunDir,
      workspace_dir: join(mountedRoot, ".runtime", "jobs", "local-api-job"),
    })
    expect(JSON.stringify(listed.local_runs[0]?.selected_task_result)).not.toContain(first.execution_dir)

    const detailResponse = await handleResponse(
      handler,
      new Request(
        `http://localhost/api/local-run/get?local_run_id=${encodeURIComponent(first.local_run_id)}`,
      ),
    )
    expect(detailResponse.ok).toBe(true)
    const detail = (await detailResponse.json()) as LocalRunDetail
    expect(detail.job.file_name).toBe("local-api.pdf")

    const rerunResponse = await handleResponse(
      handler,
      new Request("http://localhost/api/local-run/rerun", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ local_run_id: first.local_run_id }),
      }),
    )
    expect(rerunResponse.status).toBe(202)
    const rerun = (await rerunResponse.json()) as { local_run: LocalRunSummary }
    const completedRerun = await waitForLocalCompletion(handler, rerun.local_run.local_run_id)
    expect(completedRerun.local_run.status).toBe("completed")
  } finally {
    await rm(sourceRoot, { recursive: true, force: true })
  }
})
