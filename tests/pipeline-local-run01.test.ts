import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { runDebugCli } from "@/cli/pipeline-debug"
import { JobStore } from "@/server/job-store"
import { ModelRunStore } from "@/server/model-run-store"
import {
  loadPipelineTaskInput,
  loadPipelineTaskInputBundle,
  retainPipelineTaskInputFiles,
} from "@/server/pipeline"
import { clonePipelineJob } from "@/server/pipeline-local-run"
import type { LocalRunSummary } from "@/shared/local-run"
import type { PipelineTaskInputEnvelope } from "@/shared/pipeline-types"

async function writeRetainedInput(input: {
  sourceJobDir: string
  debugRef: string
  envelope: Omit<PipelineTaskInputEnvelope, "input_files">
  excludedRoots?: readonly string[]
}): Promise<string> {
  const inputPath = join(input.sourceJobDir, input.debugRef, "input.json")
  const debugDir = resolve(inputPath, "..")
  await mkdir(debugDir, { recursive: true })
  const inputFiles = await retainPipelineTaskInputFiles({
    root_dir: input.sourceJobDir,
    debug_dir: debugDir,
    objects_dir: join(resolve(debugDir, "../.."), "input-objects"),
    excluded_roots: input.excludedRoots,
  })
  await writeFile(
    inputPath,
    `${JSON.stringify({ ...input.envelope, input_files: inputFiles }, null, 2)}\n`,
    "utf8",
  )
  return inputPath
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  )
}

test("the CLI catalog exposes every independently runnable task", async () => {
  const result = (await runDebugCli(["catalog"])) as {
    pipelines: Array<{ pipeline_id: string; tasks: Array<{ id: string; depends_on: string[] }> }>
  }
  expect(result.pipelines.map(({ pipeline_id: pipelineId }) => pipelineId)).toEqual([
    "component_generation",
    "typical_application",
    "spice_generation",
  ])
  expect(
    result.pipelines.find(({ pipeline_id: pipelineId }) => pipelineId === "spice_generation")?.tasks,
  ).toContainEqual({
    id: "run_simulations",
    depends_on: ["create_simulation_tsx"],
  })
})

test("input references and --job clone while a positional job runs in place", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pipeline-task-local-"))
  const sourceJobDir = join(temporaryRoot, ".runtime", "jobs", "local-job")
  const store = new JobStore()
  try {
    await Bun.write(join(sourceJobDir, "datasheet.pdf"), "%PDF-1.4\nLocal fixture\n%%EOF\n")
    store.createJob({ job_id: "local-job", job_dir: sourceJobDir, file_name: "fixture.pdf" })
    const retainedDebugRef = "runs/component_generation/original/.pipeline/stages/01-prepare"
    const retainedInputPath = join(sourceJobDir, retainedDebugRef, "input.json")
    store.updateJob("local-job", {
      display_status: "complete",
      is_complete: true,
      pipeline: {
        pipeline_id: "component_generation",
        status: "completed",
        sequence: 3,
        started_at: "2026-08-05T08:00:00.000Z",
        updated_at: "2026-08-05T08:00:01.000Z",
        stage_results: {
          prepare: {
            stage_id: "prepare",
            status: "completed",
            debug_ref: retainedDebugRef,
          },
        },
      },
    })
    const envelope: Omit<PipelineTaskInputEnvelope, "input_files"> = {
      version: 2,
      kind: "pipeline_task_input",
      pipeline_id: "component_generation",
      task_id: "prepare",
      run_id: "original-run",
      execution_context: {
        job_id: "local-job",
        job_dir: "/app/.runtime/jobs/local-job",
        use_openai: false,
        invocation_id: "original-invocation",
      },
      depends_on: [],
      dependency_statuses: {},
      dependency_outputs: {},
    }
    await writeRetainedInput({
      sourceJobDir,
      debugRef: retainedDebugRef,
      envelope,
      excludedRoots: ["spice"],
    })
    const sourceCheckpointBefore = await readFile(join(sourceJobDir, "job.json"), "utf8")
    const retainedDatasheetHash = createHash("sha256")
      .update(await readFile(join(sourceJobDir, "datasheet.pdf")))
      .digest("hex")
    await writeFile(join(sourceJobDir, "datasheet.pdf"), "%PDF-1.4\nmutated after retention\n%%EOF\n")

    const inspection = (await runDebugCli(["task", "inspect", "--input", retainedInputPath])) as {
      envelope: PipelineTaskInputEnvelope
      retained_files: { count: number; total_bytes: number }
    }
    expect(inspection.envelope.task_id).toBe("prepare")
    expect(inspection.retained_files.count).toBeGreaterThanOrEqual(2)
    expect(inspection.retained_files.total_bytes).toBeGreaterThan(0)

    const summary = (await runDebugCli([
      "task",
      "run",
      "--input",
      retainedInputPath,
      "--root",
      temporaryRoot,
    ])) as LocalRunSummary

    expect(summary.status).toBe("completed")
    expect(summary.workspace_dir).not.toBe(sourceJobDir)
    expect(await readFile(join(sourceJobDir, "job.json"), "utf8")).toBe(sourceCheckpointBefore)
    expect(await Bun.file(join(summary.workspace_dir, "provenance.json")).exists()).toBe(true)
    const localProvenance = (await Bun.file(join(summary.workspace_dir, "provenance.json")).json()) as {
      datasheet_sha256: string
    }
    expect(localProvenance.datasheet_sha256).toBe(retainedDatasheetHash)
    const localInput = await loadPipelineTaskInput(
      join(summary.pipeline_dir, "stages", "01-prepare", "input.json"),
    )
    expect(localInput.execution_context.job_dir).toBe(summary.workspace_dir)
    expect(localInput.execution_context.invocation_id).not.toBe("original-invocation")
    expect(localInput.execution_context.job_id).toBe(summary.target_job_id!)

    const sourceLocal = (await runDebugCli([
      "local",
      "run",
      "local-job",
      "--pipeline",
      "component_generation",
      "--task",
      "prepare",
      "--root",
      temporaryRoot,
    ])) as LocalRunSummary
    expect(sourceLocal).toMatchObject({
      version: 2,
      execution_kind: "in_place",
      source_job_id: "local-job",
      target_job_id: "local-job",
      workspace_dir: sourceJobDir,
      status: "completed",
    })
    expect(await readFile(join(sourceJobDir, "datasheet.pdf"), "utf8")).toBe(
      "%PDF-1.4\nLocal fixture\n%%EOF\n",
    )
    expect(await readFile(join(sourceJobDir, "job.json"), "utf8")).not.toBe(sourceCheckpointBefore)
    const sourceLocalSummaryBefore = await readFile(sourceLocal.summary_path, "utf8")
    const sourceStageResults = sourceLocal.stage_results as Record<
      string,
      { debug_dir: string; status: string }
    >
    const continuationInputPath = join(sourceStageResults.extract_evidence.debug_dir, "input.json")
    const continuationBundle = await loadPipelineTaskInputBundle(continuationInputPath)
    expect(continuationBundle.envelope.dependency_statuses).toEqual({ prepare: "completed" })
    expect(continuationBundle.envelope.dependency_outputs.prepare).toBeDefined()

    const clonedLocal = (await runDebugCli([
      "local",
      "run",
      "--job",
      "local-job",
      "--pipeline",
      "component_generation",
      "--task",
      "prepare",
      "--root",
      temporaryRoot,
    ])) as LocalRunSummary
    expect(clonedLocal).toMatchObject({
      version: 2,
      execution_kind: "clone",
      source_job_id: "local-job",
      status: "completed",
    })
    expect(clonedLocal.target_job_id).not.toBe("local-job")
    expect(clonedLocal.workspace_dir).not.toBe(sourceLocal.workspace_dir)
    expect(await readFile(sourceLocal.summary_path, "utf8")).toBe(sourceLocalSummaryBefore)
    expect(JSON.parse(await readFile(join(sourceJobDir, "job.json"), "utf8")).job_id).toBe("local-job")
    const clonedCheckpoint = JSON.parse(await readFile(join(clonedLocal.workspace_dir, "job.json"), "utf8"))
    expect(clonedCheckpoint.job_id).toBe(clonedLocal.target_job_id)

    const portableRoot = join(temporaryRoot, "portable-input")
    await cp(resolve(retainedInputPath, "../../.."), portableRoot, { recursive: true })
    await rm(sourceJobDir, { recursive: true, force: true })
    const independentInput = join(portableRoot, "stages", "01-prepare", "input.json")
    const independentClone = (await runDebugCli([
      "task",
      "run",
      "--input",
      independentInput,
      "--root",
      temporaryRoot,
    ])) as LocalRunSummary
    expect(independentClone).toMatchObject({
      execution_kind: "clone",
      source_job_id: "local-job",
      status: "completed",
    })
    expect(independentClone.target_job_id).not.toBe("local-job")
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test("a task with Docker-local dependency paths is rewritten to its cloned regular job", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pipeline-docker-path-local-"))
  const sourceJobDir = join(temporaryRoot, ".runtime", "jobs", "repair-job")
  const store = new JobStore()
  try {
    await mkdir(sourceJobDir, { recursive: true })
    await writeFile(join(sourceJobDir, "datasheet.pdf"), "%PDF-1.4\nrepair fixture\n%%EOF\n")
    store.createJob({ job_id: "repair-job", job_dir: sourceJobDir, file_name: "repair.pdf" })
    await writeFile(join(sourceJobDir, "index.circuit.tsx"), "export default () => null\n")
    await writeFile(
      join(sourceJobDir, "component-validation.json"),
      `${JSON.stringify({ passed: true, errors: [], circuit_json: [] })}\n`,
    )
    const inputPath = await writeRetainedInput({
      sourceJobDir,
      debugRef: "runs/component_generation/original/.pipeline/stages/06-repair_component",
      excludedRoots: ["spice"],
      envelope: {
        version: 2,
        kind: "pipeline_task_input",
        pipeline_id: "component_generation",
        task_id: "repair_component",
        run_id: "docker-run",
        execution_context: {
          job_id: "repair-job",
          job_dir: "/app/.runtime/jobs/repair-job",
          use_openai: false,
          invocation_id: "docker-invocation",
        },
        depends_on: ["validate_component"],
        dependency_statuses: { validate_component: "completed" },
        dependency_outputs: {
          validate_component: {
            result_path: "/app/.runtime/jobs/repair-job/component-validation.json",
            passed: true,
          },
        },
      },
    })

    const summary = (await runDebugCli([
      "task",
      "run",
      "--input",
      inputPath,
      "--root",
      temporaryRoot,
    ])) as LocalRunSummary
    expect(summary.status).toBe("completed")
    expect(summary.selected_task_result).toMatchObject({
      status: "completed",
      output: {
        result_path: join(summary.workspace_dir, "component-validation.json"),
        passed: true,
      },
    })
    expect(await readFile(join(summary.workspace_dir, "component.circuit.tsx"), "utf8")).toBe(
      "export default () => null\n",
    )
    expect(await pathExists(join(sourceJobDir, "component.circuit.tsx"))).toBe(false)

    const jobsBeforeInvalidRun = (await runDebugCli(["job", "list", "--root", temporaryRoot])) as {
      jobs: unknown[]
    }
    await expect(
      runDebugCli(["pipeline", "run", "--input", inputPath, "--root", temporaryRoot]),
    ).rejects.toThrow("requires the retained input for prepare")
    const jobsAfterInvalidRun = (await runDebugCli(["job", "list", "--root", temporaryRoot])) as {
      jobs: unknown[]
    }
    expect(jobsAfterInvalidRun.jobs).toHaveLength(jobsBeforeInvalidRun.jobs.length)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test("invalid dependency input is rejected before a Local directory is created", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pipeline-invalid-dependency-"))
  const sourceJobDir = join(temporaryRoot, ".runtime", "jobs", "simulation-job")
  const store = new JobStore()
  try {
    await mkdir(sourceJobDir, { recursive: true })
    await writeFile(join(sourceJobDir, "datasheet.pdf"), "%PDF-1.4\nsimulation fixture\n%%EOF\n")
    store.createJob({ job_id: "simulation-job", job_dir: sourceJobDir, file_name: "simulation.pdf" })
    const inputPath = await writeRetainedInput({
      sourceJobDir,
      debugRef: "spice/runs/original/.pipeline/stages/08-run_simulations",
      envelope: {
        version: 2,
        kind: "pipeline_task_input",
        pipeline_id: "spice_generation",
        task_id: "run_simulations",
        run_id: "original-run",
        execution_context: {
          model_run_id: "model-run",
          job_id: "simulation-job",
          job_dir: "/app/.runtime/jobs/simulation-job",
          model_dir: "/app/.runtime/jobs/simulation-job/spice",
          use_openai: false,
          max_repair_attempts: 2,
          invocation_id: "original-invocation",
        },
        depends_on: ["create_simulation_tsx"],
        dependency_statuses: {},
        dependency_outputs: {},
      },
    })

    await expect(runDebugCli(["task", "run", "--input", inputPath, "--root", temporaryRoot])).rejects.toThrow(
      "Missing: create_simulation_tsx",
    )
    expect(await pathExists(join(temporaryRoot, ".runtime", "local"))).toBe(false)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test("a SPICE clone receives new job/model identities and no cross-wired accepted publication", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pipeline-spice-clone-"))
  const jobsRoot = join(temporaryRoot, ".runtime", "jobs")
  const sourceJobId = "spice-source"
  const sourceJobDir = join(jobsRoot, sourceJobId)
  const sourceModelDir = join(sourceJobDir, "spice")
  const jobStore = new JobStore()
  const modelRunStore = new ModelRunStore()
  try {
    await mkdir(sourceModelDir, { recursive: true })
    await writeFile(join(sourceJobDir, "datasheet.pdf"), "%PDF-1.4\nSPICE clone\n%%EOF\n")
    jobStore.createJob({ job_id: sourceJobId, job_dir: sourceJobDir, file_name: "spice.pdf" })
    modelRunStore.createModelRun({
      model_run_id: "source-model",
      job_id: sourceJobId,
      model_dir: sourceModelDir,
      effort_multiplier: 2,
    })
    const modelSource = ".subckt fixture IN OUT\nR1 IN OUT 1k\n.ends fixture\n"
    const revision = createHash("sha256").update(modelSource.trim()).digest("hex").slice(0, 16)
    modelRunStore.projectDevelopmentModel("source-model", {
      model_source: modelSource,
      model_card: "Development fixture",
      manifest: {
        version: 1,
        part_number: "fixture",
        dialect: "ngspice",
        entry_name: "fixture",
        model_file: "model.lib",
        revision,
        simulator: "ngspice",
        generated_at: "2026-08-08T00:00:00.000Z",
        pins: [
          { component_pin: "IN", spice_node: "IN" },
          { component_pin: "OUT", spice_node: "OUT" },
        ],
      },
    })
    await mkdir(join(sourceJobDir, "published-models", "accepted"), { recursive: true })
    await mkdir(join(sourceModelDir, "accepted-revisions", "accepted"), { recursive: true })
    await writeFile(join(sourceJobDir, "published-model.json"), "{}\n")
    await writeFile(join(sourceJobDir, "published-models", "accepted", "bundle.json"), "{}\n")
    await writeFile(join(sourceModelDir, "accepted-revisions", "accepted", "bundle.json"), "{}\n")
    const inputPath = await writeRetainedInput({
      sourceJobDir,
      debugRef: "spice/runs/source/.pipeline/stages/01-find_reference_graphs",
      envelope: {
        version: 2,
        kind: "pipeline_task_input",
        pipeline_id: "spice_generation",
        task_id: "find_reference_graphs",
        run_id: "source-model",
        execution_context: {
          model_run_id: "source-model",
          job_id: sourceJobId,
          job_dir: sourceJobDir,
          model_dir: sourceModelDir,
          use_openai: false,
          max_repair_attempts: 2,
          invocation_id: "source-invocation",
        },
        depends_on: [],
        dependency_statuses: {},
        dependency_outputs: {},
      },
    })

    const clone = await clonePipelineJob({
      context: {
        rootDir: temporaryRoot,
        jobsRoot,
        localRunsRoot: join(temporaryRoot, ".runtime", "local"),
        jobStore,
        modelRunStore,
      },
      sourceJobId,
      bundle: await loadPipelineTaskInputBundle(inputPath),
    })
    expect(clone.jobId).not.toBe(sourceJobId)
    expect(clone.bundle.envelope.execution_context).toMatchObject({
      job_id: clone.jobId,
      job_dir: join(jobsRoot, clone.jobId),
      model_dir: join(jobsRoot, clone.jobId, "spice"),
    })
    expect(clone.bundle.envelope.execution_context.model_run_id).not.toBe("source-model")
    const clonedModel = modelRunStore.getModelRunForJob(clone.jobId)
    expect(clonedModel?.development_model?.model_source).toBe(modelSource)
    expect(clonedModel?.model_source).toBeUndefined()
    expect(await pathExists(join(jobsRoot, clone.jobId, "published-model.json"))).toBe(false)
    expect(await pathExists(join(jobsRoot, clone.jobId, "published-models"))).toBe(false)
    expect(await pathExists(join(jobsRoot, clone.jobId, "spice", "accepted-revisions"))).toBe(false)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test("a retained file whose bytes no longer match its manifest is refused", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pipeline-corrupt-input-"))
  const sourceJobDir = join(temporaryRoot, ".runtime", "jobs", "corrupt-job")
  const store = new JobStore()
  try {
    await mkdir(sourceJobDir, { recursive: true })
    await writeFile(join(sourceJobDir, "datasheet.pdf"), "%PDF-1.4\noriginal bytes\n%%EOF\n")
    store.createJob({ job_id: "corrupt-job", job_dir: sourceJobDir, file_name: "corrupt.pdf" })
    const inputPath = await writeRetainedInput({
      sourceJobDir,
      debugRef: "runs/component_generation/original/.pipeline/stages/01-prepare",
      excludedRoots: ["spice"],
      envelope: {
        version: 2,
        kind: "pipeline_task_input",
        pipeline_id: "component_generation",
        task_id: "prepare",
        run_id: "original-run",
        execution_context: {
          job_id: "corrupt-job",
          job_dir: "/app/.runtime/jobs/corrupt-job",
          use_openai: false,
          invocation_id: "original-invocation",
        },
        depends_on: [],
        dependency_statuses: {},
        dependency_outputs: {},
      },
    })
    const manifest = (await Bun.file(join(resolve(inputPath, ".."), "input-files.json")).json()) as {
      files: Array<{ path: string; hash: string }>
    }
    const datasheetObject = manifest.files.find(({ path }) => path === "datasheet.pdf")
    if (!datasheetObject) throw new Error("test bundle did not retain datasheet.pdf")
    const objectPath = join(resolve(inputPath, "../../.."), "input-objects", datasheetObject.hash)
    await chmod(objectPath, 0o600)
    await writeFile(objectPath, "corrupted")

    await expect(runDebugCli(["task", "inspect", "--input", inputPath])).rejects.toThrow(
      "does not match its manifest",
    )
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test("the CLI rejects unknown options instead of silently changing the Local run request", async () => {
  await expect(runDebugCli(["catalog", "--typo", "ignored"])).rejects.toThrow("Unknown option --typo")
})
