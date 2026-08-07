import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { ProcessError } from "@/server/infrastructure/process"
import {
  createPipelineArtifact,
  createPipelineStageFactory,
  loadPipelineTaskInputBundle,
  PipelineError,
  runPipeline,
  validatePipelineDefinition,
} from "@/server/pipeline"
import type {
  PipelineArtifact,
  PipelineDefinition,
  PipelineJsonValue,
  PipelineRunSnapshot,
  PipelineStageStatus,
} from "@/shared/pipeline-types"

type BasicOutputs = {
  read_source: { text: string }
  normalize_text: { normalized: string }
  build_report: { report: string }
}

type BasicContext = {
  source_text: string
  artifact_path: string
}

type BasicServices = {
  write_text(path: string, content: string): Promise<void>
}

const defineBasicStage = createPipelineStageFactory<BasicOutputs, BasicContext, BasicServices>()

const createBasicDefinition = (calls: string[]) => {
  const stages = [
    defineBasicStage({
      id: "read_source",
      depends_on: [],
      async execute({ context }) {
        calls.push("read_source")
        return {
          status: "completed",
          output: { text: context.source_text },
          metrics: { character_count: context.source_text.length },
        }
      },
    }),
    defineBasicStage({
      id: "normalize_text",
      depends_on: ["read_source"],
      async execute({ dependency_outputs }) {
        calls.push("normalize_text")
        expect(Object.keys(dependency_outputs)).toEqual(["read_source"])
        expect(Object.isFrozen(dependency_outputs)).toBe(true)
        return {
          status: "completed",
          output: {
            normalized: dependency_outputs.read_source.text.trim().toUpperCase(),
          },
        }
      },
    }),
    defineBasicStage({
      id: "build_report",
      depends_on: ["normalize_text"],
      async execute({ context, dependency_outputs, services }) {
        calls.push("build_report")
        const report = `REPORT: ${dependency_outputs.normalize_text.normalized}`
        await services.write_text(context.artifact_path, report)
        const artifact = await createPipelineArtifact({
          artifact_id: "generated_report",
          path: context.artifact_path,
          media_type: "text/plain",
          role: "stage_output",
        })
        return {
          status: "completed",
          output: { report },
          artifacts: [artifact],
          diagnostics: [
            {
              code: "report_created",
              severity: "info",
              message: "Report artifact created",
              stage_id: "build_report",
              operation: "write_report",
              entity_refs: [{ entity_type: "report", entity_id: "primary" }],
              artifact_refs: [{ artifact_id: artifact.artifact_id, path: artifact.path }],
              cause_chain: [],
              retryable: false,
            },
          ],
        }
      },
    }),
  ] as const

  return {
    pipeline_id: "basic_generation",
    stages,
  } satisfies PipelineDefinition<BasicOutputs, BasicContext, BasicServices>
}

const readNdjson = async (path: string): Promise<readonly PipelineJsonValue[]> =>
  (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PipelineJsonValue)

test("pipeline executes ordered dependencies and exposes immutable keyed results", async () => {
  const workspace_dir = await mkdtemp(join(tmpdir(), "pipeline-ordered-"))
  const artifact_path = join(workspace_dir, "report.txt")
  const calls: string[] = []
  const snapshots: PipelineRunSnapshot<BasicOutputs>[] = []

  try {
    const result = await runPipeline({
      definition: createBasicDefinition(calls),
      run_id: "run_ordered",
      workspace_dir,
      context: { source_text: "  model data  ", artifact_path },
      services: {
        write_text: async (path, content) => {
          await Bun.write(path, content)
        },
      },
      on_snapshot(snapshot) {
        snapshots.push(snapshot)
      },
    })

    expect(calls).toEqual(["read_source", "normalize_text", "build_report"])
    expect(result.status).toBe("completed")
    expect(result.stage_results.read_source.status).toBe("completed")
    expect(result.stage_results.normalize_text.status).toBe("completed")
    expect(result.stage_results.build_report.status).toBe("completed")
    if (result.stage_results.build_report.status !== "completed") {
      throw new Error("build_report did not complete")
    }
    expect(result.stage_results.build_report.output.report).toBe("REPORT: MODEL DATA")
    expect(Object.isFrozen(result.stage_results)).toBe(true)
    expect(Object.isFrozen(result.stage_results.build_report.output)).toBe(true)

    const observed_statuses = snapshots.flatMap((snapshot) =>
      Object.values(snapshot.stage_results).map((stage) => stage.status),
    )
    expect(observed_statuses).toContain("pending")
    expect(observed_statuses).toContain("running")
    expect(observed_statuses).toContain("completed")
    expect(snapshots.every(Object.isFrozen)).toBe(true)
  } finally {
    await rm(workspace_dir, { recursive: true, force: true })
  }
})

test("an isolated stage runs only from its explicit persisted-style input", async () => {
  const workspace_dir = await mkdtemp(join(tmpdir(), "pipeline-isolated-stage-"))
  const calls: string[] = []

  try {
    const result = await runPipeline({
      definition: createBasicDefinition(calls),
      run_id: "isolated_normalize",
      workspace_dir,
      context: { source_text: "must not be read", artifact_path: join(workspace_dir, "unused.txt") },
      services: {
        write_text: async () => {
          throw new Error("a later stage must not run")
        },
      },
      target: {
        mode: "stage",
        stage_id: "normalize_text",
        dependency_outputs: { read_source: { text: "  isolated input  " } },
      },
    })

    expect(calls).toEqual(["normalize_text"])
    expect(result.status).toBe("completed")
    expect(result.stage_results.read_source.status).toBe("skipped")
    expect(result.stage_results.normalize_text).toMatchObject({
      status: "completed",
      output: { normalized: "ISOLATED INPUT" },
    })
    expect(result.stage_results.build_report.status).toBe("skipped")
    const input = await Bun.file(
      join(workspace_dir, ".pipeline", "stages", "02-normalize_text", "input.json"),
    ).json()
    expect(input).toMatchObject({
      version: 2,
      kind: "pipeline_task_input",
      pipeline_id: "basic_generation",
      task_id: "normalize_text",
      run_id: "isolated_normalize",
      execution_context: {
        source_text: "must not be read",
        artifact_path: join(workspace_dir, "unused.txt"),
      },
      dependency_statuses: { read_source: "provided" },
      dependency_outputs: { read_source: { text: "  isolated input  " } },
    })
  } finally {
    await rm(workspace_dir, { recursive: true, force: true })
  }
})

test("runnable stages retain a complete content-addressed input filesystem", async () => {
  const temporary_root = await mkdtemp(join(tmpdir(), "pipeline-retained-input-"))
  const job_dir = join(temporary_root, "job")
  const workspace_dir = join(job_dir, "runs", "basic_generation", "retained_run")
  const artifact_path = join(job_dir, "report.txt")
  try {
    await mkdir(workspace_dir, { recursive: true })
    await Bun.write(join(job_dir, "source.txt"), "retained source")
    const result = await runPipeline({
      definition: createBasicDefinition([]),
      run_id: "retained_run",
      workspace_dir,
      context: { source_text: "retained source", artifact_path },
      services: { write_text: (path, content) => Bun.write(path, content).then(() => undefined) },
      task_input_root: job_dir,
    })

    const bundle = await loadPipelineTaskInputBundle(
      join(result.pipeline_dir, "stages", "01-read_source", "input.json"),
    )
    expect(bundle.manifest.files.find(({ path }) => path === "source.txt")).toMatchObject({
      path: "source.txt",
      hash: createHash("sha256").update("retained source").digest("hex"),
      size_bytes: Buffer.byteLength("retained source"),
    })
    expect(bundle.manifest.files.some(({ path }) => path.startsWith(`runs${sep}`))).toBe(false)
    expect(await readdir(bundle.objects_dir)).toHaveLength(1)
  } finally {
    await rm(temporary_root, { recursive: true, force: true })
  }
})

test("runtime synchronization completes before a task input filesystem is retained", async () => {
  const temporary_root = await mkdtemp(join(tmpdir(), "pipeline-synchronized-input-"))
  const job_dir = join(temporary_root, "job")
  const workspace_dir = join(job_dir, "runs", "basic_generation", "synchronized_run")
  try {
    await mkdir(workspace_dir, { recursive: true })
    const result = await runPipeline({
      definition: createBasicDefinition([]),
      run_id: "synchronized_run",
      workspace_dir,
      context: { source_text: "source", artifact_path: join(job_dir, "report.txt") },
      services: { write_text: (path, content) => Bun.write(path, content).then(() => undefined) },
      task_input_root: job_dir,
      async before_stage_start({ stage_id }) {
        if (stage_id === "normalize_text") {
          await Bun.write(join(job_dir, "synchronized.txt"), "captured after the barrier")
        }
      },
    })

    const before = await loadPipelineTaskInputBundle(
      join(result.pipeline_dir, "stages", "01-read_source", "input.json"),
    )
    const after = await loadPipelineTaskInputBundle(
      join(result.pipeline_dir, "stages", "02-normalize_text", "input.json"),
    )
    expect(before.manifest.files.some(({ path }) => path === "synchronized.txt")).toBe(false)
    expect(after.manifest.files.find(({ path }) => path === "synchronized.txt")).toMatchObject({
      path: "synchronized.txt",
      hash: createHash("sha256").update("captured after the barrier").digest("hex"),
    })
  } finally {
    await rm(temporary_root, { recursive: true, force: true })
  }
})

test("pipeline records artifacts, append-only events, and complete per-stage debug bundles", async () => {
  const workspace_dir = await mkdtemp(join(tmpdir(), "pipeline-debug-"))
  const artifact_path = join(workspace_dir, "report.txt")
  const definition = createBasicDefinition([])
  const base_options = {
    definition,
    workspace_dir,
    context: { source_text: "evidence", artifact_path },
    services: {
      write_text: async (path: string, content: string) => {
        await Bun.write(path, content)
      },
    },
  }

  try {
    const first = await runPipeline({ ...base_options, run_id: "debug_run_1" })
    const first_events = await readNdjson(first.events_path)
    const report_result = first.stage_results.build_report
    expect(report_result.status).toBe("completed")
    if (report_result.status !== "completed") {
      throw new Error("build_report did not complete")
    }

    expect(report_result.artifacts).toHaveLength(1)
    expect(report_result.artifacts[0]).toMatchObject({
      artifact_id: "generated_report",
      hash: {
        algorithm: "sha256",
        value: createHash("sha256").update("REPORT: EVIDENCE").digest("hex"),
      },
      size_bytes: Buffer.byteLength("REPORT: EVIDENCE"),
      media_type: "text/plain",
      role: "stage_output",
    })

    const debug_dir = join(workspace_dir, ".pipeline", "stages", "03-build_report")
    const immutable_artifact_path = report_result.artifacts[0]?.path
    if (immutable_artifact_path === undefined) throw new Error("artifact snapshot is missing")
    expect(immutable_artifact_path.startsWith(`${join(debug_dir, "artifacts")}${sep}`)).toBe(true)
    expect(immutable_artifact_path).not.toBe(artifact_path)
    expect(await readFile(immutable_artifact_path, "utf8")).toBe("REPORT: EVIDENCE")

    await Bun.write(artifact_path, "CANONICAL FILE WAS MUTATED")
    expect(await readFile(immutable_artifact_path, "utf8")).toBe("REPORT: EVIDENCE")

    const [input, output, metrics, error] = await Promise.all([
      Bun.file(join(debug_dir, "input.json")).json(),
      Bun.file(join(debug_dir, "output.json")).json(),
      Bun.file(join(debug_dir, "metrics.json")).json(),
      Bun.file(join(debug_dir, "error.json")).json(),
    ])
    expect(input.dependency_outputs).toEqual({
      normalize_text: { normalized: "EVIDENCE" },
    })
    expect(output.artifacts[0].artifact_id).toBe("generated_report")
    expect(output.artifacts[0].path).toBe(immutable_artifact_path)
    expect(metrics.status).toBe("completed")
    expect(metrics.artifact_count).toBe(1)
    expect(error).toBeNull()

    expect(first_events[0]).toMatchObject({
      event_type: "pipeline_started",
      sequence: 1,
      run_id: "debug_run_1",
    })
    expect(first_events.at(-1)).toMatchObject({
      event_type: "pipeline_completed",
      status: "completed",
    })

    const second = await runPipeline({
      ...base_options,
      run_id: "debug_run_2",
      context: { source_text: "different evidence", artifact_path },
    })
    const second_report = second.stage_results.build_report
    if (second_report.status !== "completed") throw new Error("second report did not complete")
    expect(second_report.artifacts[0]?.path).not.toBe(immutable_artifact_path)
    expect(await readFile(artifact_path, "utf8")).toBe("REPORT: DIFFERENT EVIDENCE")
    expect(await readFile(immutable_artifact_path, "utf8")).toBe("REPORT: EVIDENCE")
    const appended_events = await readNdjson(first.events_path)
    expect(appended_events.length).toBe(first_events.length * 2)
    expect(appended_events.slice(0, first_events.length)).toEqual([...first_events])
  } finally {
    await rm(workspace_dir, { recursive: true, force: true })
  }
})

type ArtifactOutputs = {
  emit_artifact: { emitted: boolean }
}

type ArtifactContext = {
  artifact: PipelineArtifact
}

const defineArtifactStage = createPipelineStageFactory<
  ArtifactOutputs,
  ArtifactContext,
  Record<string, never>
>()

const artifactDefinition = {
  pipeline_id: "artifact_snapshot_validation",
  stages: [
    defineArtifactStage({
      id: "emit_artifact",
      depends_on: [],
      execute({ context }) {
        return {
          status: "completed",
          output: { emitted: true },
          artifacts: [context.artifact],
        }
      },
    }),
  ],
} satisfies PipelineDefinition<ArtifactOutputs, ArtifactContext, Record<string, never>>

test("pipeline fails a stage when declared artifact metadata does not match its bytes", async () => {
  const workspace_dir = await mkdtemp(join(tmpdir(), "pipeline-artifact-mismatch-"))
  const artifact_path = join(workspace_dir, "candidate.lib")

  try {
    await Bun.write(artifact_path, "stable artifact bytes")
    const artifact = await createPipelineArtifact({
      artifact_id: "candidate_model",
      path: artifact_path,
      media_type: "text/plain",
      role: "candidate",
    })
    const result = await runPipeline({
      definition: artifactDefinition,
      run_id: "artifact_mismatch_run",
      workspace_dir,
      context: {
        artifact: {
          ...artifact,
          hash: { algorithm: "sha256", value: "0".repeat(64) },
        },
      },
      services: {},
    })

    expect(result.status).toBe("failed")
    const stage = result.stage_results.emit_artifact
    expect(stage.status).toBe("failed")
    if (stage.status !== "failed") throw new Error("expected artifact stage to fail")
    expect(stage.error).toMatchObject({
      code: "artifact_hash_mismatch",
      operation: "snapshot_stage_artifact",
      stage_id: "emit_artifact",
      retryable: false,
    })
    const debug_error = await Bun.file(join(stage.debug_dir, "error.json")).json()
    expect(debug_error.code).toBe("artifact_hash_mismatch")
  } finally {
    await rm(workspace_dir, { recursive: true, force: true })
  }
})

test("pipeline rejects a declared artifact whose path is a symlink", async () => {
  const workspace_dir = await mkdtemp(join(tmpdir(), "pipeline-artifact-symlink-"))
  const target_path = join(workspace_dir, "target.lib")
  const artifact_path = join(workspace_dir, "candidate.lib")

  try {
    await Bun.write(target_path, "model bytes")
    await symlink(target_path, artifact_path)
    const target_artifact = await createPipelineArtifact({
      artifact_id: "candidate_model",
      path: target_path,
      media_type: "text/plain",
      role: "candidate",
    })
    const result = await runPipeline({
      definition: artifactDefinition,
      run_id: "artifact_symlink_run",
      workspace_dir,
      context: { artifact: { ...target_artifact, path: artifact_path } },
      services: {},
    })

    expect(result.status).toBe("failed")
    const stage = result.stage_results.emit_artifact
    expect(stage.status).toBe("failed")
    if (stage.status !== "failed") throw new Error("expected symlink artifact stage to fail")
    expect(stage.error.code).toBe("artifact_source_is_symlink")
  } finally {
    await rm(workspace_dir, { recursive: true, force: true })
  }
})

type BranchOutputs = {
  extract_evidence: { evidence: string }
  fit_model: { model: string }
  independent_audit: { audited: boolean }
}

type BranchContext = Record<string, never>
type BranchServices = Record<string, never>

const defineBranchStage = createPipelineStageFactory<BranchOutputs, BranchContext, BranchServices>()

test("structured failure skips dependents, continues independent work, and is never retried", async () => {
  const workspace_dir = await mkdtemp(join(tmpdir(), "pipeline-failure-"))
  let attempts = 0
  const root_cause = new Error("datasheet table was malformed")
  const definition = {
    pipeline_id: "failure_branches",
    stages: [
      defineBranchStage({
        id: "extract_evidence",
        depends_on: [],
        execute() {
          attempts += 1
          throw new PipelineError(
            {
              code: "evidence_parse_failed",
              message: "Could not parse evidence table",
              stage_id: "extract_evidence",
              operation: "parse_evidence_table",
              entity_refs: [{ entity_type: "datasheet_page", entity_id: "page_7" }],
              artifact_refs: [{ path: "datasheet.pdf" }],
              hint: "Inspect the table crop in the stage debug bundle.",
              retryable: false,
            },
            { cause: root_cause },
          )
        },
      }),
      defineBranchStage({
        id: "fit_model",
        depends_on: ["extract_evidence"],
        execute() {
          throw new Error("dependent stage must not execute")
        },
      }),
      defineBranchStage({
        id: "independent_audit",
        depends_on: [],
        execute() {
          return { status: "completed", output: { audited: true } }
        },
      }),
    ],
  } satisfies PipelineDefinition<BranchOutputs, BranchContext, BranchServices>

  try {
    const result = await runPipeline({
      definition,
      run_id: "failure_run",
      workspace_dir,
      context: {},
      services: {},
    })

    expect(attempts).toBe(1)
    expect(result.status).toBe("failed")
    expect(result.stage_results.extract_evidence.status).toBe("failed")
    expect(result.stage_results.fit_model.status).toBe("skipped")
    expect(result.stage_results.independent_audit.status).toBe("completed")

    const failed = result.stage_results.extract_evidence
    if (failed.status !== "failed") throw new Error("expected failed result")
    expect(failed.error).toMatchObject({
      code: "evidence_parse_failed",
      stage_id: "extract_evidence",
      operation: "parse_evidence_table",
      hint: "Inspect the table crop in the stage debug bundle.",
      retryable: false,
    })
    expect(failed.error.cause_chain[0]).toMatchObject({
      name: "Error",
      message: "datasheet table was malformed",
    })

    const error_json = await Bun.file(
      join(workspace_dir, ".pipeline", "stages", "01-extract_evidence", "error.json"),
    ).json()
    expect(error_json.code).toBe("evidence_parse_failed")
  } finally {
    await rm(workspace_dir, { recursive: true, force: true })
  }
})

test("typed process failures retain their actionable code in the pipeline trace", async () => {
  const workspace_dir = await mkdtemp(join(tmpdir(), "pipeline-process-failure-"))
  const defineStage = createPipelineStageFactory<
    { execute_tool: { completed: boolean } },
    Record<string, never>,
    Record<string, never>
  >()
  try {
    const result = await runPipeline({
      definition: {
        pipeline_id: "process_failure",
        stages: [
          defineStage({
            id: "execute_tool",
            depends_on: [],
            execute() {
              throw new ProcessError({
                code: "process_spawn_failed",
                command_label: "ngspice validation",
                message: "ngspice executable was not found",
              })
            },
          }),
        ],
      },
      run_id: "process_failure_run",
      workspace_dir,
      context: {},
      services: {},
    })
    const stage = result.stage_results.execute_tool
    expect(stage.status).toBe("failed")
    if (stage.status !== "failed") throw new Error("expected process stage to fail")
    expect(stage.error).toMatchObject({
      code: "process_spawn_failed",
      operation: "run_external_process",
      retryable: true,
    })
  } finally {
    await rm(workspace_dir, { recursive: true, force: true })
  }
})

type SkipOutputs = {
  optional_reference: { found: boolean }
  compare_reference: { compared: boolean }
  publish_summary: { published: boolean }
}

const defineSkipStage = createPipelineStageFactory<
  SkipOutputs,
  Record<string, never>,
  Record<string, never>
>()

test("explicit skips propagate only to dependent stages", async () => {
  const workspace_dir = await mkdtemp(join(tmpdir(), "pipeline-skip-"))
  const definition = {
    pipeline_id: "optional_reference_flow",
    stages: [
      defineSkipStage({
        id: "optional_reference",
        depends_on: [],
        execute() {
          return {
            status: "skipped",
            reason: "No reference curve was present",
            metrics: { pages_examined: 12 },
          }
        },
      }),
      defineSkipStage({
        id: "compare_reference",
        depends_on: ["optional_reference"],
        execute() {
          throw new Error("dependent stage must not execute")
        },
      }),
      defineSkipStage({
        id: "publish_summary",
        depends_on: [],
        execute() {
          return { status: "completed", output: { published: true } }
        },
      }),
    ],
  } satisfies PipelineDefinition<SkipOutputs, Record<string, never>, Record<string, never>>

  try {
    const result = await runPipeline({
      definition,
      run_id: "skip_run",
      workspace_dir,
      context: {},
      services: {},
    })
    expect(result.status).toBe("completed")
    expect(result.stage_results.optional_reference.status).toBe("skipped")
    expect(result.stage_results.compare_reference.status).toBe("skipped")
    expect(result.stage_results.publish_summary.status).toBe("completed")
  } finally {
    await rm(workspace_dir, { recursive: true, force: true })
  }
})

type CancelOutputs = {
  long_task: { value: number }
  finalize_task: { value: number }
}

type CancelServices = {
  cancel(reason: string): void
}

const defineCancelStage = createPipelineStageFactory<CancelOutputs, Record<string, never>, CancelServices>()

test("cancellation cancels the active and all remaining stages with trace bundles", async () => {
  const workspace_dir = await mkdtemp(join(tmpdir(), "pipeline-cancel-"))
  const controller = new AbortController()
  const definition = {
    pipeline_id: "cancel_flow",
    stages: [
      defineCancelStage({
        id: "long_task",
        depends_on: [],
        execute({ services }) {
          services.cancel("operator cancelled run")
          return { status: "completed", output: { value: 1 } }
        },
      }),
      defineCancelStage({
        id: "finalize_task",
        depends_on: ["long_task"],
        execute() {
          throw new Error("cancelled stage must not execute")
        },
      }),
    ],
  } satisfies PipelineDefinition<CancelOutputs, Record<string, never>, CancelServices>

  try {
    const result = await runPipeline({
      definition,
      run_id: "cancel_run",
      workspace_dir,
      context: {},
      services: { cancel: (reason) => controller.abort(reason) },
      signal: controller.signal,
    })
    expect(result.status).toBe("cancelled")
    expect(result.stage_results.long_task.status).toBe("cancelled")
    expect(result.stage_results.finalize_task.status).toBe("cancelled")

    for (const stage_dir of ["01-long_task", "02-finalize_task"]) {
      const metrics = await Bun.file(
        join(workspace_dir, ".pipeline", "stages", stage_dir, "metrics.json"),
      ).json()
      expect(metrics.status).toBe("cancelled")
    }
  } finally {
    await rm(workspace_dir, { recursive: true, force: true })
  }
})

test("cancellation after a final-stage commit does not hide the published result", async () => {
  const workspace_dir = await mkdtemp(join(tmpdir(), "pipeline-commit-barrier-"))
  const controller = new AbortController()
  let published = false
  const definition = {
    pipeline_id: "commit_barrier_flow",
    stages: [
      defineCancelStage({
        id: "long_task",
        depends_on: [],
        execute({ services, signal }) {
          signal.throwIfAborted()
          published = true
          services.cancel("operator cancelled after publication")
          return {
            status: "completed",
            commit_state: "committed",
            output: { value: 1 },
          }
        },
      }),
    ],
  } satisfies PipelineDefinition<CancelOutputs, Record<string, never>, CancelServices>

  try {
    const result = await runPipeline({
      definition,
      run_id: "commit_barrier_run",
      workspace_dir,
      context: {},
      services: { cancel: (reason) => controller.abort(reason) },
      signal: controller.signal,
    })

    expect(published).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    expect(result.status).toBe("completed")
    expect(result.stage_results.long_task.status).toBe("completed")
    const events = await readNdjson(result.events_path)
    expect(events.at(-2)).toMatchObject({
      event_type: "stage_completed",
      stage_id: "long_task",
      status: "completed",
    })
    expect(events.at(-1)).toMatchObject({
      event_type: "pipeline_completed",
      status: "completed",
    })
  } finally {
    await rm(workspace_dir, { recursive: true, force: true })
  }
})

test("artifact trace failures after a commit cannot downgrade the published stage", async () => {
  const workspace_dir = await mkdtemp(join(tmpdir(), "pipeline-post-commit-artifact-"))
  const artifact_path = join(workspace_dir, "published.txt")
  const definition = {
    pipeline_id: "post_commit_artifact_flow",
    stages: [
      defineCancelStage({
        id: "long_task",
        depends_on: [],
        async execute() {
          await Bun.write(artifact_path, "durably published")
          const artifact = await createPipelineArtifact({
            artifact_id: "published_result",
            path: artifact_path,
            media_type: "text/plain",
            role: "publication",
          })
          await rm(artifact_path)
          return {
            status: "completed",
            commit_state: "committed",
            output: { value: 1 },
            artifacts: [artifact],
          }
        },
      }),
    ],
  } satisfies PipelineDefinition<CancelOutputs, Record<string, never>, CancelServices>

  try {
    const result = await runPipeline({
      definition,
      run_id: "post_commit_artifact_run",
      workspace_dir,
      context: {},
      services: { cancel: () => undefined },
    })

    expect(result.status).toBe("completed")
    const stage = result.stage_results.long_task
    expect(stage.status).toBe("completed")
    if (stage.status !== "completed") throw new Error("Committed stage was downgraded")
    expect(stage.output).toEqual({ value: 1 })
    expect(stage.diagnostics).toContainEqual(
      expect.objectContaining({ code: "post_commit_trace_failure", severity: "warning" }),
    )
    expect(await readNdjson(join(workspace_dir, ".pipeline", "observer-errors.ndjson"))).toEqual([
      expect.objectContaining({
        event_type: "post_commit_trace_failure",
        stage_id: "long_task",
        operation: "record_committed_stage_result",
      }),
    ])
  } finally {
    await rm(workspace_dir, { recursive: true, force: true })
  }
})

test("terminal event storage failures after a commit do not reject pipeline completion", async () => {
  const workspace_dir = await mkdtemp(join(tmpdir(), "pipeline-post-commit-event-"))
  const events_path = join(workspace_dir, ".pipeline", "events.ndjson")
  const definition = {
    pipeline_id: "post_commit_event_flow",
    stages: [
      defineCancelStage({
        id: "long_task",
        depends_on: [],
        async execute() {
          await rm(events_path)
          await mkdir(events_path)
          return {
            status: "completed",
            commit_state: "committed",
            output: { value: 1 },
          }
        },
      }),
    ],
  } satisfies PipelineDefinition<CancelOutputs, Record<string, never>, CancelServices>

  try {
    const result = await runPipeline({
      definition,
      run_id: "post_commit_event_run",
      workspace_dir,
      context: {},
      services: { cancel: () => undefined },
    })

    expect(result.status).toBe("completed")
    expect(result.stage_results.long_task.status).toBe("completed")
    const trace_failures = await readNdjson(join(workspace_dir, ".pipeline", "observer-errors.ndjson"))
    expect(trace_failures).toEqual([
      expect.objectContaining({
        stage_id: "long_task",
        operation: "record_committed_stage_result",
      }),
      expect.objectContaining({
        stage_id: "pipeline",
        operation: "record_pipeline_terminal_event",
      }),
    ])
  } finally {
    await rm(workspace_dir, { recursive: true, force: true })
  }
})

test("snapshot observer failures are recorded without changing stage terminal states", async () => {
  const workspace_dir = await mkdtemp(join(tmpdir(), "pipeline-observer-failure-"))
  const definition = {
    pipeline_id: "observer_failure_flow",
    stages: [
      defineCancelStage({
        id: "long_task",
        depends_on: [],
        execute() {
          return {
            status: "completed",
            commit_state: "committed",
            output: { value: 1 },
          }
        },
      }),
    ],
  } satisfies PipelineDefinition<CancelOutputs, Record<string, never>, CancelServices>

  try {
    const result = await runPipeline({
      definition,
      run_id: "observer_failure_run",
      workspace_dir,
      context: {},
      services: { cancel: () => undefined },
      on_snapshot() {
        throw new Error("observer persistence unavailable")
      },
    })

    expect(result.status).toBe("completed")
    expect(result.stage_results.long_task.status).toBe("completed")
    const events = await readNdjson(result.events_path)
    const event_types = events.flatMap((event) =>
      typeof event === "object" &&
      event !== null &&
      "event_type" in event &&
      typeof event.event_type === "string"
        ? [event.event_type]
        : [],
    )
    expect(event_types.filter((event_type) => event_type === "stage_completed")).toHaveLength(1)
    expect(event_types.filter((event_type) => event_type === "stage_failed")).toHaveLength(0)
    expect(events.at(-1)).toMatchObject({ event_type: "pipeline_completed" })
    const observer_errors = await readNdjson(join(workspace_dir, ".pipeline", "observer-errors.ndjson"))
    expect(observer_errors).toHaveLength(events.length)
    expect(observer_errors[0]).toMatchObject({
      event_type: "pipeline_started",
      message: "observer persistence unavailable",
    })
  } finally {
    await rm(workspace_dir, { recursive: true, force: true })
  }
})

test("a stalled snapshot observer cannot hang pipeline completion", async () => {
  const workspace_dir = await mkdtemp(join(tmpdir(), "pipeline-observer-timeout-"))
  const definition = {
    pipeline_id: "observer_timeout_flow",
    stages: [
      defineCancelStage({
        id: "long_task",
        depends_on: [],
        execute() {
          return { status: "completed", output: { value: 1 } }
        },
      }),
    ],
  } satisfies PipelineDefinition<CancelOutputs, Record<string, never>, CancelServices>

  try {
    const started_at = performance.now()
    const result = await runPipeline({
      definition,
      run_id: "observer_timeout_run",
      workspace_dir,
      context: {},
      services: { cancel: () => undefined },
      snapshot_timeout_ms: 25,
      on_snapshot: () => new Promise<void>(() => undefined),
    })

    expect(result.status).toBe("completed")
    expect(performance.now() - started_at).toBeLessThan(500)
    const observer_errors = await readNdjson(join(workspace_dir, ".pipeline", "observer-errors.ndjson"))
    expect(observer_errors.at(-1)).toMatchObject({
      event_type: "pipeline_completed",
      message: "Pipeline snapshot observer exceeded 25 ms",
    })
  } finally {
    await rm(workspace_dir, { recursive: true, force: true })
  }
})

type ValidationOutputs = {
  first_stage: { value: number }
  second_stage: { value: number }
}

const defineValidationStage = createPipelineStageFactory<
  ValidationOutputs,
  Record<string, never>,
  Record<string, never>
>()

const getDefinitionErrorCode = (
  definition: PipelineDefinition<ValidationOutputs, Record<string, never>, Record<string, never>>,
): string => {
  try {
    validatePipelineDefinition(definition)
  } catch (error) {
    if (!(error instanceof PipelineError)) throw error
    return error.diagnostic.code
  }
  throw new Error("Expected definition validation to fail")
}

const completedValidationStage = (id: "first_stage" | "second_stage") =>
  defineValidationStage({
    id,
    depends_on: [],
    execute() {
      return { status: "completed", output: { value: 1 } }
    },
  })

test("pipeline definition validation rejects unstable ids and invalid dependency order", () => {
  expect(
    getDefinitionErrorCode({
      pipeline_id: "invalid-pipeline",
      stages: [completedValidationStage("first_stage")],
    }),
  ).toBe("invalid_pipeline_id")

  expect(
    getDefinitionErrorCode({
      pipeline_id: "valid_pipeline",
      stages: [
        defineValidationStage({
          id: "first_stage",
          depends_on: ["second_stage"],
          execute() {
            return { status: "completed", output: { value: 1 } }
          },
        }),
        completedValidationStage("second_stage"),
      ],
    }),
  ).toBe("stage_dependency_not_prior")

  expect(
    getDefinitionErrorCode({
      pipeline_id: "valid_pipeline",
      stages: [
        completedValidationStage("first_stage"),
        defineValidationStage({
          id: "second_stage",
          depends_on: ["first_stage", "first_stage"],
          execute() {
            return { status: "completed", output: { value: 2 } }
          },
        }),
      ],
    }),
  ).toBe("duplicate_stage_dependency")

  expect(
    getDefinitionErrorCode({
      pipeline_id: "valid_pipeline",
      stages: [completedValidationStage("first_stage"), completedValidationStage("first_stage")],
    }),
  ).toBe("duplicate_stage_id")

  expect(
    getDefinitionErrorCode({
      pipeline_id: "valid_pipeline",
      stages: [],
    }),
  ).toBe("pipeline_has_no_stages")

  const invalid_stage = {
    id: "InvalidStage",
    depends_on: [],
    execute() {
      return { status: "completed", output: { value: 1 } } as const
    },
  }
  expect(
    getDefinitionErrorCode({
      pipeline_id: "valid_pipeline",
      stages: [invalid_stage as unknown as ReturnType<typeof completedValidationStage>],
    }),
  ).toBe("invalid_stage_id")
})

test("stage status union includes every lifecycle state", () => {
  const statuses: readonly PipelineStageStatus[] = [
    "pending",
    "running",
    "completed",
    "skipped",
    "failed",
    "cancelled",
  ]
  expect(statuses).toHaveLength(6)
})
