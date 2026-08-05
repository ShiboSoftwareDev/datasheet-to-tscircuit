import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { runDebugCli } from "@/cli/pipeline-debug"
import { JobStore } from "@/server/job-store"
import { loadPipelineTaskInput } from "@/server/pipeline"
import type { PipelineReplaySummary } from "@/server/pipeline-replay"
import type { PipelineTaskInputEnvelope } from "@/shared/pipeline-types"

const repositoryRoot = resolve(import.meta.dir, "..")

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

test("standalone and old-job task commands replay without changing the source job", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pipeline-task-replay-"))
  const sourceJobDir = join(temporaryRoot, ".runtime", "jobs", "replay-job")
  const outputDir = join(temporaryRoot, "output")
  const oldJobOutputDir = join(temporaryRoot, "old-job-output")
  const store = new JobStore()
  try {
    await Bun.write(join(sourceJobDir, "datasheet.pdf"), "%PDF-1.4\nreplay fixture\n%%EOF\n")
    store.createJob({ job_id: "replay-job", job_dir: sourceJobDir, file_name: "fixture.pdf" })
    const envelope: PipelineTaskInputEnvelope = {
      version: 1,
      kind: "pipeline_task_input",
      pipeline_id: "component_generation",
      task_id: "prepare",
      run_id: "original-run",
      execution_context: {
        job_id: "replay-job",
        job_dir: sourceJobDir,
        use_openai: false,
        invocation_id: "original-invocation",
      },
      depends_on: [],
      dependency_statuses: {},
      dependency_outputs: {},
    }
    const retainedDebugRef = "runs/component_generation/original/.pipeline/stages/01-prepare"
    const retainedInputPath = join(sourceJobDir, retainedDebugRef, "input.json")
    await mkdir(resolve(retainedInputPath, ".."), { recursive: true })
    await writeFile(retainedInputPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8")
    store.updateJob("replay-job", {
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
    const sourceCheckpointBefore = await readFile(join(sourceJobDir, "job.json"), "utf8")

    const inspection = (await runDebugCli(["task", "inspect", "--input", retainedInputPath])) as {
      envelope: PipelineTaskInputEnvelope
      referenced_paths: Array<{ path: string; exists: boolean }>
    }
    expect(inspection.envelope.task_id).toBe("prepare")
    expect(inspection.referenced_paths).toContainEqual({ path: sourceJobDir, exists: true })

    const summary = (await runDebugCli([
      "task",
      "run",
      "--input",
      retainedInputPath,
      "--root",
      repositoryRoot,
      "--output",
      outputDir,
    ])) as PipelineReplaySummary

    expect(summary.status).toBe("completed")
    expect(summary.workspace_dir).not.toBe(sourceJobDir)
    expect(await readFile(join(sourceJobDir, "job.json"), "utf8")).toBe(sourceCheckpointBefore)
    expect(await Bun.file(join(summary.workspace_dir, "provenance.json")).exists()).toBe(true)
    const replayInput = await loadPipelineTaskInput(
      join(summary.pipeline_dir, "stages", "01-prepare", "input.json"),
    )
    expect(replayInput.execution_context.job_dir).toBe(summary.workspace_dir)
    expect(replayInput.execution_context.invocation_id).toBe(summary.replay_id)

    const oldJobSummary = (await runDebugCli([
      "job",
      "replay",
      "replay-job",
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
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
