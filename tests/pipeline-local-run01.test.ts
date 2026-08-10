import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { projectDebugCliStdout, runDebugCli } from "@/cli/pipeline-debug"
import { JobStore } from "@/server/job-store"
import { ModelRunStore } from "@/server/model-run-store"
import {
  loadPipelineTaskInput,
  loadPipelineTaskInputBundle,
  restorePipelineTaskInputFiles,
  retainPipelineTaskInputFiles,
} from "@/server/pipeline"
import {
  clonePipelineJob,
  deriveSpiceInputBundle,
  normalizePartialPipeline,
} from "@/server/pipeline-local-run"
import type { PublicPipelineSnapshot, PublicPipelineStage } from "@/shared/job-types"
import type { LocalRunSummary } from "@/shared/local-run"
import type { PipelineTaskInputEnvelope } from "@/shared/pipeline-types"
import { publishCommittedEvidenceFixture } from "./fixtures/committed-evidence"

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

test("a never-run SPICE pipeline derives only its initial job boundary", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pipeline-derived-spice-"))
  const sourceJobDir = join(temporaryRoot, "job")
  const localRunsRoot = join(temporaryRoot, "local")
  const restoredRoot = join(temporaryRoot, "restored")
  await mkdir(join(sourceJobDir, "spice"), { recursive: true })
  await Promise.all([
    writeFile(join(sourceJobDir, "job.json"), '{"job_id":"fresh-job"}\n'),
    writeFile(join(sourceJobDir, "datasheet.pdf"), "datasheet"),
    writeFile(join(sourceJobDir, "component.circuit.tsx"), "component"),
    writeFile(join(sourceJobDir, "typical-application.circuit.tsx"), "application"),
    writeFile(join(sourceJobDir, "spice", "stale-candidate.lib"), "stale"),
  ])
  const derived = await deriveSpiceInputBundle({
    sourceJobId: "fresh-job",
    sourceJobDir,
    localRunsRoot,
    modelRunId: "fresh-model-run",
    useOpenai: true,
  })
  try {
    expect(derived.bundle.envelope).toMatchObject({
      pipeline_id: "spice_generation",
      task_id: "find_reference_graphs",
      depends_on: [],
      dependency_outputs: {},
      execution_context: {
        job_id: "fresh-job",
        model_run_id: "fresh-model-run",
        model_dir: join(sourceJobDir, "spice"),
        use_openai: true,
      },
    })
    await mkdir(restoredRoot, { recursive: true })
    await restorePipelineTaskInputFiles({
      bundle: derived.bundle,
      destination_root: restoredRoot,
    })
    expect(await readFile(join(restoredRoot, "datasheet.pdf"), "utf8")).toBe("datasheet")
    expect(await readFile(join(restoredRoot, "component.circuit.tsx"), "utf8")).toBe("component")
    expect(await readFile(join(restoredRoot, "typical-application.circuit.tsx"), "utf8")).toBe("application")
    expect(await pathExists(join(restoredRoot, "spice"))).toBe(false)
  } finally {
    await derived.cleanup()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test("in-place input restoration preserves accumulated SPICE graphs and previews", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pipeline-preserve-spice-"))
  const jobDir = join(temporaryRoot, "job")
  const debugDir = join(jobDir, "spice", "runs", "original", ".pipeline", "stages", "07-repair")
  try {
    await mkdir(join(jobDir, "spice", "current-previews", "old", "cases"), { recursive: true })
    await writeFile(join(jobDir, "datasheet.pdf"), "original datasheet")
    await writeFile(join(jobDir, "job.json"), '{"status":"retained"}\n')
    await writeFile(join(jobDir, "spice", "current-preview.json"), '{"revision":"old"}\n')
    await writeFile(
      join(jobDir, "spice", "current-previews", "old", "cases", "figure.circuit.tsx"),
      "old circuit",
    )
    await mkdir(debugDir, { recursive: true })
    const inputFiles = await retainPipelineTaskInputFiles({
      root_dir: jobDir,
      debug_dir: debugDir,
      objects_dir: join(jobDir, "spice", "runs", "original", ".pipeline", "input-objects"),
    })
    const inputPath = join(debugDir, "input.json")
    await writeFile(
      inputPath,
      `${JSON.stringify({
        version: 2,
        kind: "pipeline_task_input",
        pipeline_id: "spice_generation",
        task_id: "repair_spice_model",
        run_id: "original",
        execution_context: {
          model_run_id: "model-run",
          job_id: "job",
          job_dir: jobDir,
          model_dir: join(jobDir, "spice"),
          use_openai: false,
          repair_budget_ms: 60_000,
          invocation_id: "original",
        },
        depends_on: ["compare_simulation_outputs"],
        dependency_statuses: { compare_simulation_outputs: "completed" },
        dependency_outputs: { compare_simulation_outputs: {} },
        input_files: inputFiles,
      })}\n`,
    )
    await writeFile(join(jobDir, "datasheet.pdf"), "mutated datasheet")
    await writeFile(join(jobDir, "job.json"), '{"status":"live"}\n')
    await writeFile(join(jobDir, "spice", "current-preview.json"), '{"revision":"new"}\n')
    await mkdir(join(jobDir, "spice", "current-previews", "new", "cases"), { recursive: true })
    const newGraph = join(jobDir, "spice", "current-previews", "new", "cases", "figure.circuit.json")
    await writeFile(newGraph, "new simulation graph")

    await restorePipelineTaskInputFiles({
      bundle: await loadPipelineTaskInputBundle(inputPath),
      destination_root: jobDir,
      preserved_roots: ["spice"],
      preserved_paths: ["job.json"],
    })

    expect(await readFile(join(jobDir, "datasheet.pdf"), "utf8")).toBe("original datasheet")
    expect(await readFile(join(jobDir, "job.json"), "utf8")).toBe('{"status":"live"}\n')
    expect(await readFile(join(jobDir, "spice", "current-preview.json"), "utf8")).toBe('{"revision":"new"}\n')
    expect(await readFile(newGraph, "utf8")).toBe("new simulation graph")
    expect(
      await readFile(join(jobDir, "spice", "current-previews", "old", "cases", "figure.circuit.tsx"), "utf8"),
    ).toBe("old circuit")
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

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

test("Local CLI stdout is compact while retaining the complete summary path", () => {
  const projected = projectDebugCliStdout({
    version: 2,
    local_run_id: "local-1",
    execution_kind: "clone",
    mode: "pipeline",
    pipeline_id: "spice_generation",
    source_job_id: "source-job",
    target_job_id: "target-job",
    status: "failed",
    created_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:01:00.000Z",
    summary_path: "/runtime/local/local-1/summary.json",
    stage_results: {
      find_reference_graphs: { status: "completed", output: { huge: "x".repeat(10_000) } },
      create_comparison_graphs: {
        status: "failed",
        error: { code: "artifact_invalid", message: "current failure\nlarge history" },
      },
    },
  })

  expect(projected).toEqual({
    version: 2,
    local_run_id: "local-1",
    execution_kind: "clone",
    mode: "pipeline",
    pipeline_id: "spice_generation",
    task_id: undefined,
    source_job_id: "source-job",
    target_job_id: "target-job",
    status: "failed",
    created_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:01:00.000Z",
    summary_path: "/runtime/local/local-1/summary.json",
    completed_stages: ["find_reference_graphs"],
    failed_stage: {
      stage_id: "create_comparison_graphs",
      code: "artifact_invalid",
      message: "current failure",
    },
  })
  expect(JSON.stringify(projected)).not.toContain("large history")
  expect(JSON.stringify(projected)).not.toContain("xxxxxxxx")
})

test("in-place partial progress retains earlier completed checkpoints", () => {
  const timestamp = "2026-08-09T00:00:00.000Z"
  const stage = (
    stage_id: string,
    status: "pending" | "running" | "completed" | "skipped",
  ): PublicPipelineStage => ({
    stage_id,
    status,
    debug_ref: stage_id,
  })
  const baseline: PublicPipelineSnapshot = {
    pipeline_id: "spice_generation",
    status: "completed",
    sequence: 1,
    started_at: timestamp,
    updated_at: timestamp,
    stage_results: {
      find_reference_graphs: stage("find_reference_graphs", "completed"),
      create_comparison_graphs: stage("create_comparison_graphs", "completed"),
      infer_spice_model: stage("infer_spice_model", "completed"),
      create_simulation_tsx: stage("create_simulation_tsx", "pending"),
    },
  }
  const active: PublicPipelineSnapshot = {
    ...baseline,
    status: "running",
    sequence: 2,
    stage_results: {
      find_reference_graphs: stage("find_reference_graphs", "skipped"),
      create_comparison_graphs: stage("create_comparison_graphs", "skipped"),
      infer_spice_model: stage("infer_spice_model", "skipped"),
      create_simulation_tsx: stage("create_simulation_tsx", "running"),
    },
  }

  const normalized = normalizePartialPipeline({
    snapshot: active,
    baselineSnapshot: baseline,
    mode: "from_task",
    taskId: "create_simulation_tsx",
    status: "running",
  })

  expect(Object.values(normalized!.stage_results).map(({ status }) => status)).toEqual([
    "completed",
    "completed",
    "completed",
    "running",
  ])
})

test("input references and --job clone while a positional job runs in place", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pipeline-task-local-"))
  const sourceJobDir = join(temporaryRoot, ".runtime", "jobs", "local-job")
  const store = new JobStore()
  try {
    await Bun.write(join(sourceJobDir, "datasheet.pdf"), "%PDF-1.4\nLocal fixture\n%%EOF\n")
    store.createJob({ job_id: "local-job", job_dir: sourceJobDir, file_name: "fixture.pdf" })
    await writeFile(join(sourceJobDir, "index.circuit.tsx"), "export default () => null\n")
    await writeFile(
      join(sourceJobDir, "component-validation.json"),
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
    )
    const retainedDebugRef = "runs/component_generation/original/.pipeline/stages/05-repair_component"
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
          repair_component: {
            stage_id: "repair_component",
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
      task_id: "repair_component",
      run_id: "original-run",
      execution_context: {
        job_id: "local-job",
        job_dir: "/app/.runtime/jobs/local-job",
        use_openai: false,
        invocation_id: "original-invocation",
      },
      depends_on: ["validate_component"],
      dependency_statuses: { validate_component: "completed" },
      dependency_outputs: {
        validate_component: {
          result_path: "/app/.runtime/jobs/local-job/component-validation.json",
          passed: true,
          errors: [],
        },
      },
    }
    await writeRetainedInput({
      sourceJobDir,
      debugRef: retainedDebugRef,
      envelope,
      excludedRoots: ["spice"],
    })
    const retainedCheckpoint = await readFile(join(sourceJobDir, "job.json"), "utf8")
    store.updateJob("local-job", { component_ready: true })
    await writeFile(join(sourceJobDir, "component.circuit.tsx"), "stale published component\n")
    const liveCheckpointBefore = await readFile(join(sourceJobDir, "job.json"), "utf8")
    await writeFile(join(sourceJobDir, "datasheet.pdf"), "%PDF-1.4\nmutated after retention\n%%EOF\n")

    const inspection = (await runDebugCli(["task", "inspect", "--input", retainedInputPath])) as {
      envelope: PipelineTaskInputEnvelope
      retained_files: { count: number; total_bytes: number }
    }
    expect(inspection.envelope.task_id).toBe("repair_component")
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

    expect({ status: summary.status, error: summary.error_message }).toEqual({
      status: "completed",
      error: undefined,
    })
    expect(summary.workspace_dir).not.toBe(sourceJobDir)
    expect(await readFile(join(sourceJobDir, "job.json"), "utf8")).toBe(liveCheckpointBefore)
    const localInput = await loadPipelineTaskInput(
      join(summary.pipeline_dir, "stages", "05-repair_component", "input.json"),
    )
    expect(localInput.execution_context.job_dir).toBe(summary.workspace_dir)
    expect(localInput.execution_context.invocation_id).not.toBe("original-invocation")
    if (!summary.target_job_id) throw new Error("Expected the Local run to select a target job")
    expect(localInput.execution_context.job_id).toBe(summary.target_job_id)

    const progressEvents: string[] = []
    const unrelatedJobDir = join(temporaryRoot, ".runtime", "jobs", "unrelated-broken-job")
    await mkdir(unrelatedJobDir, { recursive: true })
    await writeFile(join(unrelatedJobDir, "job.json"), "not valid json\n")
    const restoreErrors: unknown[][] = []
    const originalConsoleError = console.error
    console.error = (...values: unknown[]) => restoreErrors.push(values)
    let sourceLocal: LocalRunSummary
    try {
      sourceLocal = (await runDebugCli(
        [
          "local",
          "run",
          "local-job",
          "--pipeline",
          "component_generation",
          "--task",
          "repair_component",
          "--root",
          temporaryRoot,
        ],
        { on_progress: ({ kind }) => progressEvents.push(kind) },
      )) as LocalRunSummary
    } finally {
      console.error = originalConsoleError
    }
    expect(restoreErrors.some((values) => JSON.stringify(values).includes("unrelated-broken-job"))).toBe(
      false,
    )
    expect(sourceLocal).toMatchObject({
      version: 2,
      execution_kind: "in_place",
      source_job_id: "local-job",
      target_job_id: "local-job",
      workspace_dir: sourceJobDir,
      status: "completed",
    })
    expect(progressEvents).toContain("started")
    expect(progressEvents).toContain("pipeline")
    expect(await readFile(join(sourceJobDir, "datasheet.pdf"), "utf8")).toBe(
      "%PDF-1.4\nLocal fixture\n%%EOF\n",
    )
    expect(await readFile(join(sourceJobDir, "job.json"), "utf8")).not.toBe(retainedCheckpoint)
    expect(JSON.parse(await readFile(join(sourceJobDir, "job.json"), "utf8")).component_ready).toBe(false)
    expect(await pathExists(join(sourceJobDir, "component.circuit.tsx"))).toBe(false)
    const sourceLocalSummaryBefore = await readFile(sourceLocal.summary_path, "utf8")
    const sourceStageResults = sourceLocal.stage_results as Record<
      string,
      { debug_dir: string; status: string }
    >
    const continuationInputPath = join(sourceStageResults.publish_component.debug_dir, "input.json")
    const continuationBundle = await loadPipelineTaskInputBundle(continuationInputPath)
    expect(continuationBundle.envelope.dependency_statuses).toEqual({ repair_component: "completed" })
    expect(continuationBundle.envelope.dependency_outputs.repair_component).toBeDefined()

    const clonedLocal = (await runDebugCli([
      "local",
      "run",
      "--job",
      "local-job",
      "--pipeline",
      "component_generation",
      "--task",
      "repair_component",
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
    const independentInput = join(portableRoot, "stages", "05-repair_component", "input.json")
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

test("a full application clone derives its extraction input from a component-only job", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pipeline-application-from-component-"))
  const sourceJobId = "component-only"
  const sourceJobDir = join(temporaryRoot, ".runtime", "jobs", sourceJobId)
  const store = new JobStore()
  const visualSource = {
    page: 2,
    figure: "Recommended land pattern",
    method: "pdf_visual",
    confidence: "high",
    image: "visual-reference/land-pattern.png",
    render_dpi: 200,
  } as const
  try {
    await publishCommittedEvidenceFixture({
      job_dir: sourceJobDir,
      component_evidence: {
        version: 1,
        status: "resolved",
        part_number: { value: "COMPONENT-ONLY-2", sources: [visualSource] },
        package: {
          name: { value: "Two terminal package", sources: [visualSource] },
          pin_count: { value: 2, sources: [visualSource] },
        },
        pinout: {
          pins: [
            { number: "1", labels: ["INPUT"], role: "input", sources: [visualSource] },
            { number: "2", labels: ["RETURN"], role: "ground", sources: [visualSource] },
          ],
        },
        footprint: {
          view: "pcb_top",
          units: "mm",
          drawing_orientation: { value: "pcb_top", sources: [visualSource] },
          pads: [
            {
              pin: "1",
              kind: "smt",
              x: -0.75,
              y: 0,
              width: 0.55,
              height: 0.8,
              sources: [visualSource],
            },
            {
              pin: "2",
              kind: "smt",
              x: 0.75,
              y: 0,
              width: 0.55,
              height: 0.8,
              sources: [visualSource],
            },
          ],
        },
        unresolved_ambiguities: [],
      },
      application_plan: {
        version: 4,
        availability: "not_present",
        title: "No documented typical application",
        description: "The searched sections contain no reference circuit.",
        source_references: [visualSource],
        searched_sections: ["Application information"],
        components: [],
        connections: [],
      },
    })
    store.createJob({
      job_id: sourceJobId,
      job_dir: sourceJobDir,
      file_name: "component-only.pdf",
    })
    await Promise.all([
      writeFile(
        join(sourceJobDir, "component.circuit.tsx"),
        'export default () => <chip name="U1" footprint="soic2" />\n',
      ),
      writeFile(join(sourceJobDir, "component.circuit.json"), "[]\n"),
    ])
    store.updateJob(sourceJobId, {
      component_ready: true,
      display_status: "complete",
      is_complete: true,
      pipeline: {
        pipeline_id: "component_generation",
        status: "completed",
        sequence: 1,
        started_at: "2026-08-09T00:00:00.000Z",
        updated_at: "2026-08-09T00:01:00.000Z",
        stage_results: {
          publish_component: {
            stage_id: "publish_component",
            status: "completed",
            debug_ref: "runs/component_generation/component-only/.pipeline/stages/06-publish_component",
          },
        },
      },
    })
    const sourceCheckpoint = await readFile(join(sourceJobDir, "job.json"), "utf8")

    const summary = (await runDebugCli([
      "local",
      "run",
      "--job",
      sourceJobId,
      "--pipeline",
      "typical_application",
      "--root",
      temporaryRoot,
    ])) as LocalRunSummary

    expect(summary).toMatchObject({
      execution_kind: "clone",
      mode: "pipeline",
      pipeline_id: "typical_application",
      source_job_id: sourceJobId,
      status: "failed",
      stage_results: {
        extract_application_evidence: {
          status: "failed",
          error: { code: "process_spawn_failed" },
        },
      },
    })
    expect(summary.target_job_id).not.toBe(sourceJobId)
    expect(await readFile(join(sourceJobDir, "job.json"), "utf8")).toBe(sourceCheckpoint)
    expect(
      (await readdir(join(temporaryRoot, ".runtime", "local"))).some((name) => name.startsWith(".")),
    ).toBe(false)
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
    )
    const inputPath = await writeRetainedInput({
      sourceJobDir,
      debugRef: "runs/component_generation/original/.pipeline/stages/05-repair_component",
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
    expect({ status: summary.status, error: summary.error_message }).toEqual({
      status: "completed",
      error: undefined,
    })
    expect(summary.selected_task_result).toMatchObject({
      status: "completed",
      output: {
        result_path: join(summary.workspace_dir, "component-validation.json"),
        passed: true,
      },
    })
    expect(await readFile(join(summary.workspace_dir, "index.circuit.tsx"), "utf8")).toBe(
      "export default () => null\n",
    )
    expect(await pathExists(join(summary.workspace_dir, "component.circuit.tsx"))).toBe(false)
    expect(await pathExists(join(sourceJobDir, "component.circuit.tsx"))).toBe(false)

    const jobsBeforeInvalidRun = (await runDebugCli(["job", "list", "--root", temporaryRoot])) as {
      jobs: unknown[]
    }
    await expect(
      runDebugCli(["pipeline", "run", "--input", inputPath, "--root", temporaryRoot]),
    ).rejects.toThrow("requires the retained input for extract_evidence")
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
    const retainedBundle = await loadPipelineTaskInputBundle(inputPath)

    const laterModelSource = ".subckt fixture IN OUT\nR1 IN OUT 2k\n.ends fixture\n"
    const laterRevision = createHash("sha256").update(laterModelSource.trim()).digest("hex").slice(0, 16)
    modelRunStore.projectDevelopmentModel("source-model", {
      model_source: laterModelSource,
      model_card: "Later in-place development fixture",
      manifest: {
        version: 1,
        part_number: "fixture",
        dialect: "ngspice",
        entry_name: "fixture",
        model_file: "model.lib",
        revision: laterRevision,
        simulator: "ngspice",
        generated_at: "2026-08-08T00:01:00.000Z",
        pins: [
          { component_pin: "IN", spice_node: "IN" },
          { component_pin: "OUT", spice_node: "OUT" },
        ],
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
      bundle: retainedBundle,
    })
    expect(clone.jobId).not.toBe(sourceJobId)
    expect(clone.bundle.envelope.execution_context).toMatchObject({
      job_id: clone.jobId,
      job_dir: join(jobsRoot, clone.jobId),
      model_dir: join(jobsRoot, clone.jobId, "spice"),
    })
    expect(clone.bundle.envelope.execution_context.model_run_id).not.toBe("source-model")
    const clonedModel = modelRunStore.getModelRunForJob(clone.jobId)
    expect(modelRunStore.getModelRun("source-model")?.development_model?.model_source).toBe(laterModelSource)
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
      debugRef: "runs/component_generation/original/.pipeline/stages/01-extract_evidence",
      excludedRoots: ["spice"],
      envelope: {
        version: 2,
        kind: "pipeline_task_input",
        pipeline_id: "component_generation",
        task_id: "extract_evidence",
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
