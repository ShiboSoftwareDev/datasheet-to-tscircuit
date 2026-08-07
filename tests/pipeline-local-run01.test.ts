import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { runDebugCli } from "@/cli/pipeline-debug"
import { JobStore } from "@/server/job-store"
import {
  loadPipelineTaskInput,
  loadPipelineTaskInputBundle,
  retainPipelineTaskInputFiles,
} from "@/server/pipeline"
import type { LocalRunSummary } from "@/shared/local-run"
import type { PipelineTaskInputEnvelope } from "@/shared/pipeline-types"

const repositoryRoot = resolve(import.meta.dir, "..")

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

test("standalone and retained-job task commands use the exact portable input without changing the source job", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pipeline-task-local-"))
  const sourceJobDir = join(temporaryRoot, ".runtime", "jobs", "local-job")
  const outputDir = join(temporaryRoot, "output")
  const oldJobOutputDir = join(temporaryRoot, "old-job-output")
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
      repositoryRoot,
      "--output",
      outputDir,
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
    expect(localInput.execution_context.invocation_id).toBe("original-invocation")

    const oldJobSummary = (await runDebugCli([
      "local",
      "run",
      "local-job",
      "--pipeline",
      "component_generation",
      "--task",
      "prepare",
      "--root",
      temporaryRoot,
      "--output",
      oldJobOutputDir,
    ])) as { status: string; workspace_dir: string }
    expect(oldJobSummary.status).toBe("completed")
    expect(oldJobSummary.workspace_dir).not.toBe(sourceJobDir)
    expect(await readFile(join(sourceJobDir, "job.json"), "utf8")).toBe(sourceCheckpointBefore)

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
    const sourceLocalSummaryBefore = await readFile(sourceLocal.summary_path, "utf8")
    const sourceStageResults = sourceLocal.stage_results as Record<
      string,
      { debug_dir: string; status: string }
    >
    const continuationInputPath = join(sourceStageResults.extract_evidence.debug_dir, "input.json")
    const continuationBundle = await loadPipelineTaskInputBundle(continuationInputPath)
    expect(continuationBundle.envelope.dependency_statuses).toEqual({ prepare: "completed" })
    expect(continuationBundle.envelope.dependency_outputs.prepare).toBeDefined()

    // Older task-only Local runs retained a skeleton for skipped stages. Keep
    // supporting those existing Local baselines by deriving from their final workspace.
    const sourceTaskInputPath = join(sourceStageResults.prepare.debug_dir, "input.json")
    const sourceTaskInput = await loadPipelineTaskInput(sourceTaskInputPath)
    const { input_files: _inputFiles, ...legacySourceTaskInput } = sourceTaskInput
    await writeFile(sourceTaskInputPath, `${JSON.stringify(legacySourceTaskInput, null, 2)}\n`, "utf8")
    const legacySourceTaskInputBefore = await readFile(sourceTaskInputPath, "utf8")
    const clonedLocal = (await runDebugCli([
      "local",
      "run",
      sourceLocal.local_run_id,
      "--pipeline",
      "component_generation",
      "--task",
      "prepare",
      "--root",
      temporaryRoot,
    ])) as LocalRunSummary
    expect(clonedLocal.status).toBe("completed")
    expect(clonedLocal.parent_local_run_id).toBe(sourceLocal.local_run_id)
    expect(clonedLocal.source_run_id).toBe(sourceLocal.local_run_id)
    expect(clonedLocal.workspace_dir).not.toBe(sourceLocal.workspace_dir)
    expect(await readFile(sourceLocal.summary_path, "utf8")).toBe(sourceLocalSummaryBefore)
    expect(await readFile(sourceTaskInputPath, "utf8")).toBe(legacySourceTaskInputBefore)

    const forbiddenLocalOutput = join(sourceLocal.execution_dir, "nested-output")
    await expect(
      runDebugCli([
        "local",
        "run",
        sourceLocal.local_run_id,
        "--pipeline",
        "component_generation",
        "--task",
        "prepare",
        "--root",
        temporaryRoot,
        "--output",
        forbiddenLocalOutput,
      ]),
    ).rejects.toThrow("historical jobs directory")
    expect(await pathExists(forbiddenLocalOutput)).toBe(false)

    const forbiddenOutput = join(sourceJobDir, "local-output")
    await expect(
      runDebugCli([
        "task",
        "run",
        "--input",
        retainedInputPath,
        "--root",
        repositoryRoot,
        "--output",
        forbiddenOutput,
      ]),
    ).rejects.toThrow("historical jobs directory")
    expect(await pathExists(forbiddenOutput)).toBe(false)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test("a task with Docker-local dependency paths is rewritten to its isolated Local workspace", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pipeline-docker-path-local-"))
  const sourceJobDir = join(temporaryRoot, ".runtime", "jobs", "repair-job")
  const outputDir = join(temporaryRoot, "output")
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
      repositoryRoot,
      "--output",
      outputDir,
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

    const invalidPipelineOutput = join(temporaryRoot, "invalid-pipeline-output")
    await expect(
      runDebugCli([
        "pipeline",
        "run",
        "--input",
        inputPath,
        "--root",
        repositoryRoot,
        "--output",
        invalidPipelineOutput,
      ]),
    ).rejects.toThrow("requires the retained input for prepare")
    expect(await pathExists(invalidPipelineOutput)).toBe(false)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test("invalid dependency input is rejected before a Local directory is created", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pipeline-invalid-dependency-"))
  const sourceJobDir = join(temporaryRoot, ".runtime", "jobs", "simulation-job")
  const outputDir = join(temporaryRoot, "must-not-exist")
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

    await expect(
      runDebugCli(["task", "run", "--input", inputPath, "--root", repositoryRoot, "--output", outputDir]),
    ).rejects.toThrow("Missing: create_simulation_tsx")
    expect(await pathExists(outputDir)).toBe(false)
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
