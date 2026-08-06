import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evidencePrompt } from "@/server/component-workflow/prompts"
import type { AgentClient } from "@/server/infrastructure/agent"
import { runAgentArtifactStage } from "@/server/infrastructure/agent"
import {
  readBoundedJsonArtifact,
  readBoundedTextArtifact,
  retainStageRejection,
  seedStageWorkspaceFromRejection,
  type StageWorkspace,
} from "@/server/infrastructure/artifacts"
import { ProcessError } from "@/server/infrastructure/process"
import { buildCharacterizationPrompt } from "@/server/modeling/prompts"
import { PipelineError, toPipelineError } from "@/server/pipeline"

function createWorkspaceFactory(root: string, on_create: () => void) {
  return async (attempt: number): Promise<StageWorkspace> => {
    on_create()
    const path = join(root, `candidate-${attempt}`)
    await mkdir(path, { recursive: true })
    return {
      path,
      dispose: () => rm(path, { recursive: true, force: true }),
    }
  }
}

test("agent artifact stages retry validation failures and retain rejected candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-artifact-validation-"))
  const debug_dir = join(root, "debug")
  let workspace_count = 0
  let agent_count = 0
  let promote_count = 0
  let seeded_candidate: string | undefined
  const prompts: string[] = []
  const agent_client: AgentClient = {
    async run(input) {
      agent_count += 1
      prompts.push(input.prompt)
      if (agent_count === 2) {
        seeded_candidate = await Bun.file(join(input.workspace, "candidate.txt")).text()
      }
      await Bun.write(
        join(input.workspace, "candidate.txt"),
        agent_count === 1 ? "invalid candidate" : "valid candidate",
      )
      return { attempts: 1, duration_ms: 7, output_tail: "" }
    },
  }

  try {
    const result = await runAgentArtifactStage({
      stage_id: "generate_candidate",
      phase_label: "Generate candidate",
      max_artifact_attempts: 3,
      signal: new AbortController().signal,
      use_openai: false,
      agent_client,
      create_workspace: createWorkspaceFactory(root, () => {
        workspace_count += 1
      }),
      build_prompt: (feedback) => `write candidate${feedback ? `; fix: ${feedback}` : ""}`,
      async validate(workspace) {
        const value = await readFile(join(workspace, "candidate.txt"), "utf8")
        if (!value.startsWith("valid ")) throw new Error("candidate contract failed")
        return value
      },
      async promote() {
        promote_count += 1
      },
      rejection_debug: { debug_dir, files: ["candidate.txt"] },
      on_output() {},
    })

    expect(result).toEqual({ value: "valid candidate", attempts: 2, agent_duration_ms: 14 })
    expect({ workspace_count, agent_count, promote_count }).toEqual({
      workspace_count: 2,
      agent_count: 2,
      promote_count: 1,
    })
    expect(prompts[1]).toContain("candidate contract failed")
    expect(seeded_candidate).toBe("invalid candidate")
    expect(await readFile(join(debug_dir, "rejected-attempts", "1", "candidate.txt"), "utf8")).toBe(
      "invalid candidate",
    )
    expect(
      await readFile(join(debug_dir, "rejected-attempts", "1", "validation-error.txt"), "utf8"),
    ).toContain("candidate contract failed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("artifact correction carries cumulative diagnostics without regressing prior work", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-artifact-cumulative-"))
  const debug_dir = join(root, "debug")
  const prompts: string[] = []
  const seeds: string[] = []
  let agent_count = 0

  try {
    const result = await runAgentArtifactStage({
      stage_id: "extract_evidence",
      phase_label: "Extract evidence",
      max_artifact_attempts: 3,
      signal: new AbortController().signal,
      use_openai: false,
      agent_client: {
        async run(input) {
          agent_count += 1
          prompts.push(input.prompt)
          if (await Bun.file(join(input.workspace, "candidate.txt")).exists()) {
            seeds.push(await Bun.file(join(input.workspace, "candidate.txt")).text())
          }
          await Bun.write(
            join(input.workspace, "candidate.txt"),
            agent_count === 1 ? "missing version" : agent_count === 2 ? "numeric pins" : "valid",
          )
          return { attempts: 1, duration_ms: 1, output_tail: "" }
        },
      },
      create_workspace: createWorkspaceFactory(root, () => undefined),
      build_prompt: (feedback) => `repair${feedback ? `\n${feedback}` : ""}`,
      async validate(workspace) {
        const candidate = await Bun.file(join(workspace, "candidate.txt")).text()
        if (candidate === "missing version") throw new Error("version must equal 1")
        if (candidate === "numeric pins") throw new Error("pin identifiers must be strings")
        return candidate
      },
      async promote() {},
      rejection_debug: { debug_dir, files: ["candidate.txt"] },
      on_output() {},
    })

    expect(result.value).toBe("valid")
    expect(seeds).toEqual(["missing version", "numeric pins"])
    expect(prompts[2]).toContain("version must equal 1")
    expect(prompts[2]).toContain("pin identifiers must be strings")
    const history = await Bun.file(join(debug_dir, "attempt-history.json")).json()
    expect(
      history.failures.map(({ attempt, error }: { attempt: number; error: string }) => ({
        attempt,
        error,
      })),
    ).toEqual([
      { attempt: 1, error: "version must equal 1" },
      { attempt: 2, error: "pin identifiers must be strings" },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("aggregate diagnostics are presented once per actionable detail", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-artifact-aggregate-diagnostic-"))
  let attempt = 0
  let correction_feedback = ""
  try {
    await runAgentArtifactStage({
      stage_id: "extract_evidence",
      phase_label: "Extract evidence",
      max_artifact_attempts: 2,
      signal: new AbortController().signal,
      use_openai: false,
      agent_client: {
        async run() {
          attempt += 1
          return { attempts: 1, duration_ms: 1, output_tail: "" }
        },
      },
      create_workspace: createWorkspaceFactory(root, () => undefined),
      build_prompt: (feedback) => {
        correction_feedback = feedback ?? ""
        return "write candidate"
      },
      async validate() {
        if (attempt === 1) {
          throw new AggregateError(
            [new Error("first actionable detail"), new Error("second actionable detail")],
            "Combined validation failed\nfirst actionable detail\nsecond actionable detail",
          )
        }
        return "valid"
      },
      async promote() {},
      rejection_debug: { debug_dir: join(root, "debug") },
      on_output() {},
    })

    expect(correction_feedback.split("first actionable detail")).toHaveLength(2)
    expect(correction_feedback.split("second actionable detail")).toHaveLength(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("terminal artifact diagnostics reference every rejected attempt and contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-artifact-history-"))
  const debug_dir = join(root, "debug")
  try {
    const error = await runAgentArtifactStage({
      stage_id: "extract_evidence",
      phase_label: "Extract evidence",
      max_artifact_attempts: 2,
      signal: new AbortController().signal,
      use_openai: false,
      agent_client: {
        async run(input) {
          await Bun.write(join(input.workspace, "candidate.txt"), "invalid")
          return { attempts: 1, duration_ms: 1, output_tail: "" }
        },
      },
      create_workspace: createWorkspaceFactory(root, () => undefined),
      build_prompt: () => "repair",
      async validate() {
        throw new Error("candidate remains invalid")
      },
      async promote() {},
      contract_id: "test-contract/v1",
      contract_sha256: "a".repeat(64),
      rejection_debug: { debug_dir, files: ["candidate.txt"] },
      on_output() {},
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(PipelineError)
    const diagnostic = (error as PipelineError).diagnostic
    expect(diagnostic.artifact_refs.map(({ path }) => path)).toEqual([
      join(debug_dir, "attempt-history.json"),
      join(debug_dir, "rejected-attempts", "1"),
      join(debug_dir, "rejected-attempts", "2"),
    ])
    expect(diagnostic.message).toContain("Rejected attempt 1")
    expect(diagnostic.message).toContain("Rejected attempt 2")
    expect(await Bun.file(join(debug_dir, "attempt-history.json")).json()).toMatchObject({
      contract_id: "test-contract/v1",
      contract_sha256: "a".repeat(64),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("agent process failures propagate without creating extra artifact attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-artifact-process-"))
  const process_error = new ProcessError({
    code: "process_exit_failed",
    command_label: "agent",
    message: "agent exited",
    exit_code: 2,
    output_tail: "fatal generation failure",
  })
  let workspace_count = 0
  let agent_count = 0
  let validate_count = 0
  let caught: unknown

  try {
    await runAgentArtifactStage({
      stage_id: "extract_evidence",
      phase_label: "Extract evidence",
      max_artifact_attempts: 4,
      signal: new AbortController().signal,
      use_openai: false,
      agent_client: {
        async run() {
          agent_count += 1
          throw process_error
        },
      },
      create_workspace: createWorkspaceFactory(root, () => {
        workspace_count += 1
      }),
      build_prompt: () => "extract",
      async validate() {
        validate_count += 1
        return "unreachable"
      },
      async promote() {
        throw new Error("unreachable")
      },
      rejection_debug: { debug_dir: join(root, "debug") },
      on_output() {},
    }).catch((error) => {
      caught = error
    })

    expect(caught).toBe(process_error)
    expect({ workspace_count, agent_count, validate_count }).toEqual({
      workspace_count: 1,
      agent_count: 1,
      validate_count: 0,
    })
    expect(await Bun.file(join(root, "debug", "rejected-attempts", "1")).exists()).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("promotion failures are server failures and never rerun the generation agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-artifact-promotion-"))
  let workspace_count = 0
  let agent_count = 0
  let promote_count = 0
  let caught: unknown

  try {
    await runAgentArtifactStage({
      stage_id: "generate_model",
      phase_label: "Generate model",
      max_artifact_attempts: 4,
      signal: new AbortController().signal,
      use_openai: false,
      agent_client: {
        async run(input) {
          agent_count += 1
          await Bun.write(join(input.workspace, "model.lib"), ".SUBCKT PART A B\n.ENDS PART\n")
          return { attempts: 1, duration_ms: 1, output_tail: "" }
        },
      },
      create_workspace: createWorkspaceFactory(root, () => {
        workspace_count += 1
      }),
      build_prompt: () => "generate",
      validate: (workspace) => Bun.file(join(workspace, "model.lib")).text(),
      async promote() {
        promote_count += 1
        throw new Error("publication volume is read-only")
      },
      rejection_debug: { debug_dir: join(root, "debug"), files: ["model.lib"] },
      on_output() {},
    }).catch((error) => {
      caught = error
    })

    expect(caught).toBeInstanceOf(PipelineError)
    expect((caught as PipelineError).diagnostic).toMatchObject({
      code: "generate_model_artifact_promotion_failed",
      retryable: false,
    })
    expect({ workspace_count, agent_count, promote_count }).toEqual({
      workspace_count: 1,
      agent_count: 1,
      promote_count: 1,
    })
    expect(await Bun.file(join(root, "debug", "rejected-attempts", "1")).exists()).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("cancellation after the agent returns prevents validation and promotion", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-artifact-cancel-agent-"))
  const controller = new AbortController()
  let validate_count = 0
  let promote_count = 0

  try {
    const error = await runAgentArtifactStage({
      stage_id: "generate_component",
      phase_label: "Generate component",
      max_artifact_attempts: 2,
      signal: controller.signal,
      use_openai: false,
      agent_client: {
        async run() {
          controller.abort(new Error("cancelled after agent"))
          return { attempts: 1, duration_ms: 1, output_tail: "" }
        },
      },
      create_workspace: createWorkspaceFactory(root, () => undefined),
      build_prompt: () => "generate",
      async validate() {
        validate_count += 1
        return "candidate"
      },
      async promote() {
        promote_count += 1
      },
      rejection_debug: { debug_dir: join(root, "debug") },
      on_output() {},
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("cancelled after agent")
    expect({ validate_count, promote_count }).toEqual({ validate_count: 0, promote_count: 0 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("cancellation during validation prevents canonical promotion", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-artifact-cancel-validation-"))
  const controller = new AbortController()
  const canonical_path = join(root, "canonical.txt")
  let promote_count = 0

  try {
    await Bun.write(canonical_path, "existing canonical value")
    const error = await runAgentArtifactStage({
      stage_id: "generate_component",
      phase_label: "Generate component",
      max_artifact_attempts: 2,
      signal: controller.signal,
      use_openai: false,
      agent_client: {
        async run() {
          return { attempts: 1, duration_ms: 1, output_tail: "" }
        },
      },
      create_workspace: createWorkspaceFactory(root, () => undefined),
      build_prompt: () => "generate",
      async validate() {
        controller.abort(new Error("cancelled during validation"))
        return "candidate"
      },
      async promote() {
        promote_count += 1
        await Bun.write(canonical_path, "new candidate")
      },
      rejection_debug: { debug_dir: join(root, "debug") },
      on_output() {},
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("cancelled during validation")
    expect(promote_count).toBe(0)
    expect(await readFile(canonical_path, "utf8")).toBe("existing canonical value")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("workspace cleanup failures cannot replace a successful stage result", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-artifact-cleanup-"))
  const messages: string[] = []
  try {
    const result = await runAgentArtifactStage({
      stage_id: "generate_component",
      phase_label: "Generate component",
      max_artifact_attempts: 1,
      signal: new AbortController().signal,
      use_openai: false,
      agent_client: {
        async run() {
          return { attempts: 1, duration_ms: 3, output_tail: "" }
        },
      },
      async create_workspace() {
        return {
          path: root,
          async dispose() {
            throw new Error("temporary volume cleanup failed")
          },
        }
      },
      build_prompt: () => "generate",
      validate: async () => "valid candidate",
      promote: async () => undefined,
      rejection_debug: { debug_dir: join(root, "debug") },
      on_output: (_stream, message) => {
        messages.push(message)
      },
    })

    expect(result.value).toBe("valid candidate")
    expect(messages.join("\n")).toContain("temporary volume cleanup failed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a storage failure wins over cancellation once promotion has begun", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-artifact-promotion-race-"))
  const controller = new AbortController()
  try {
    const error = await runAgentArtifactStage({
      stage_id: "generate_component",
      phase_label: "Generate component",
      max_artifact_attempts: 1,
      signal: controller.signal,
      use_openai: false,
      agent_client: {
        async run() {
          return { attempts: 1, duration_ms: 1, output_tail: "" }
        },
      },
      create_workspace: createWorkspaceFactory(root, () => undefined),
      build_prompt: () => "generate",
      validate: async () => "valid candidate",
      async promote() {
        controller.abort(new Error("operator cancelled"))
        throw new Error("canonical volume write failed")
      },
      rejection_debug: { debug_dir: join(root, "debug") },
      on_output() {},
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(PipelineError)
    expect((error as PipelineError).diagnostic.code).toBe("generate_component_artifact_promotion_failed")
    expect((error as Error).message).toContain("canonical volume write failed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("partially retained candidates are never seeded into a correction workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-artifact-partial-retention-"))
  const workspace = join(root, "workspace")
  const correction = join(root, "correction")
  const debug_dir = join(root, "debug")
  await Promise.all([mkdir(workspace), mkdir(correction)])
  await Bun.write(join(workspace, "first.txt"), "must not survive a partial retention")
  await Bun.write(join(workspace, "oversized.bin"), new Uint8Array(4 * 1024 * 1024 + 1))

  try {
    await expect(
      retainStageRejection({
        workspace,
        debug_dir,
        attempt: 1,
        error_message: "candidate is invalid",
        files: ["first.txt", "oversized.bin"],
      }),
    ).rejects.toThrow("unexpectedly large")
    expect(await Bun.file(join(debug_dir, "rejected-attempts", "1")).exists()).toBe(false)
    expect(
      await seedStageWorkspaceFromRejection({
        workspace: correction,
        debug_dir,
        attempt: 1,
        files: ["first.txt", "oversized.bin"],
      }),
    ).toBe(false)
    expect(await Bun.file(join(correction, "first.txt")).exists()).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a failed current retention never reuses a stale marker-backed candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-artifact-stale-retention-"))
  const debug_dir = join(root, "debug")
  const stale_workspace = join(root, "stale")
  const seeded: boolean[] = []
  let attempts = 0

  try {
    await mkdir(stale_workspace)
    await Bun.write(join(stale_workspace, "candidate.txt"), "stale candidate")
    await retainStageRejection({
      workspace: stale_workspace,
      debug_dir,
      attempt: 1,
      error_message: "stale rejection",
      files: ["candidate.txt"],
    })

    const result = await runAgentArtifactStage({
      stage_id: "extract_evidence",
      phase_label: "Extract evidence",
      max_artifact_attempts: 2,
      signal: new AbortController().signal,
      use_openai: false,
      agent_client: {
        async run(input) {
          attempts += 1
          seeded.push(await Bun.file(join(input.workspace, "candidate.txt")).exists())
          await Bun.write(
            join(input.workspace, "candidate.txt"),
            attempts === 1 ? "current invalid candidate" : "valid candidate",
          )
          return { attempts: 1, duration_ms: 1, output_tail: "" }
        },
      },
      create_workspace: createWorkspaceFactory(root, () => undefined),
      build_prompt: () => "extract",
      async validate(workspace) {
        const candidate = await Bun.file(join(workspace, "candidate.txt")).text()
        if (candidate !== "valid candidate") throw new Error("candidate contract failed")
        return candidate
      },
      async promote() {},
      rejection_debug: { debug_dir, files: ["candidate.txt"] },
      on_output() {},
    })

    expect(result.value).toBe("valid candidate")
    expect(seeded).toEqual([false, false])
    expect(await Bun.file(join(debug_dir, "attempt-history.json")).json()).toMatchObject({
      failures: [{ attempt: 1, retained: false }],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("artifact log observers cannot abort agent output or correction retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-artifact-observer-"))
  let attempts = 0
  try {
    const result = await runAgentArtifactStage({
      stage_id: "extract_evidence",
      phase_label: "Extract evidence",
      max_artifact_attempts: 2,
      signal: new AbortController().signal,
      use_openai: false,
      agent_client: {
        async run(input) {
          attempts += 1
          await input.on_output("stdout", "agent progress\n")
          await Bun.write(join(input.workspace, "candidate.txt"), attempts === 1 ? "invalid" : "valid")
          return { attempts: 1, duration_ms: 1, output_tail: "" }
        },
      },
      create_workspace: createWorkspaceFactory(root, () => undefined),
      build_prompt: () => "extract",
      async validate(workspace) {
        const candidate = await Bun.file(join(workspace, "candidate.txt")).text()
        if (candidate !== "valid") throw new Error("candidate contract failed")
        return candidate
      },
      async promote() {},
      rejection_debug: { debug_dir: join(root, "debug"), files: ["candidate.txt"] },
      on_output() {
        throw new Error("log store is unavailable")
      },
    })

    expect(result).toMatchObject({ value: "valid", attempts: 2 })
    expect(attempts).toBe(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("validation process errors retain the enclosing candidate without consuming artifact retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-artifact-validation-process-"))
  const debug_dir = join(root, "debug")
  const process_error = new ProcessError({
    code: "process_exit_failed",
    command_label: "independent verifier",
    message: "verifier process exited",
    exit_code: 2,
    output_tail: "fatal verifier failure",
  })
  let agent_attempts = 0

  try {
    const caught = await runAgentArtifactStage({
      stage_id: "extract_evidence",
      phase_label: "Extract evidence",
      max_artifact_attempts: 4,
      signal: new AbortController().signal,
      use_openai: false,
      agent_client: {
        async run(input) {
          agent_attempts += 1
          await Bun.write(join(input.workspace, "candidate.txt"), "corrected outer candidate")
          return { attempts: 1, duration_ms: 1, output_tail: "" }
        },
      },
      create_workspace: createWorkspaceFactory(root, () => undefined),
      build_prompt: () => "extract",
      async validate() {
        throw process_error
      },
      async promote() {},
      rejection_debug: { debug_dir, files: ["candidate.txt"] },
      on_output() {},
    }).catch((error) => error)

    expect(caught).toBe(process_error)
    expect(agent_attempts).toBe(1)
    expect(await readFile(join(debug_dir, "rejected-attempts", "1", "candidate.txt"), "utf8")).toBe(
      "corrected outer candidate",
    )
    expect(await Bun.file(join(debug_dir, "attempt-history.json")).json()).toMatchObject({
      stage_id: "extract_evidence",
      failures: [{ attempt: 1, error: "verifier process exited", retained: true }],
    })
    const terminal_error = toPipelineError(caught, {
      code: "stage_execution_failed",
      fallback_message: "Extract evidence failed",
      stage_id: "extract_evidence",
      operation: "execute_stage",
    })
    expect(terminal_error.diagnostic.artifact_refs).toEqual([
      { path: join(debug_dir, "attempt-history.json") },
      { path: join(debug_dir, "rejected-attempts", "1") },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("nested verifier exhaustion retains agent-73's enclosing third evidence candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-artifact-nested-verifier-"))
  const debug_dir = join(root, "debug")
  const nested_history = join(root, "nested-connectivity", "attempt-history.json")
  const nested_cause = new Error("connectivity review endpoint 48V BATT is invalid")
  const nested_error = new PipelineError(
    {
      code: "verify_application_connectivity_artifact_invalid",
      message: "Independent application connectivity verification exhausted two attempts",
      stage_id: "verify_application_connectivity",
      operation: "validate_agent_artifact",
      artifact_refs: [{ path: nested_history }],
      hint: "Inspect the nested connectivity attempts.",
      retryable: false,
    },
    { cause: nested_cause },
  )
  let agent_attempts = 0
  let promote_attempts = 0

  try {
    const caught = await runAgentArtifactStage({
      stage_id: "extract_evidence",
      phase_label: "Datasheet evidence extraction",
      max_artifact_attempts: 4,
      signal: new AbortController().signal,
      use_openai: false,
      agent_client: {
        async run(input) {
          agent_attempts += 1
          await Bun.write(
            join(input.workspace, "typical-application-plan.json"),
            agent_attempts === 3
              ? "outer attempt 3 with corrected inventory"
              : `outer attempt ${agent_attempts}`,
          )
          return { attempts: 1, duration_ms: 1, output_tail: "" }
        },
      },
      create_workspace: createWorkspaceFactory(root, () => undefined),
      build_prompt: (feedback) => feedback ?? "extract",
      async validate(_workspace, attempt) {
        if (attempt === 1) throw new Error("unsupported footprint_source_references")
        if (attempt === 2) throw new Error("independent inventory contains B1 and SW1")
        throw nested_error
      },
      async promote() {
        promote_attempts += 1
      },
      contract_id: "component-evidence/v1",
      contract_sha256: "b".repeat(64),
      rejection_debug: { debug_dir, files: ["typical-application-plan.json"] },
      on_output() {},
    }).catch((error) => error)

    expect(caught).toBeInstanceOf(PipelineError)
    expect(caught).not.toBe(nested_error)
    const enriched = caught as PipelineError
    expect(enriched.diagnostic).toMatchObject({
      code: nested_error.diagnostic.code,
      message: nested_error.diagnostic.message,
      stage_id: nested_error.diagnostic.stage_id,
      operation: nested_error.diagnostic.operation,
      hint: nested_error.diagnostic.hint,
      retryable: nested_error.diagnostic.retryable,
    })
    expect(enriched.cause).toBe(nested_cause)
    expect(enriched.diagnostic.cause_chain).toEqual(nested_error.diagnostic.cause_chain)
    expect(enriched.diagnostic.artifact_refs).toEqual([
      { path: nested_history },
      { path: join(debug_dir, "attempt-history.json") },
      { path: join(debug_dir, "rejected-attempts", "3") },
    ])
    expect({ agent_attempts, promote_attempts }).toEqual({ agent_attempts: 3, promote_attempts: 0 })
    expect(
      await readFile(join(debug_dir, "rejected-attempts", "3", "typical-application-plan.json"), "utf8"),
    ).toBe("outer attempt 3 with corrected inventory")
    expect(await Bun.file(join(debug_dir, "attempt-history.json")).json()).toMatchObject({
      stage_id: "extract_evidence",
      contract_id: "component-evidence/v1",
      failures: [
        { attempt: 1, error: "unsupported footprint_source_references", retained: true },
        { attempt: 2, error: "independent inventory contains B1 and SW1", retained: true },
        {
          attempt: 3,
          error: "Independent application connectivity verification exhausted two attempts",
          retained: true,
        },
      ],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("cancellation bypasses enclosing retention for a nested typed validation failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-artifact-nested-cancellation-"))
  const debug_dir = join(root, "debug")
  const controller = new AbortController()
  const cancellation = new Error("operator cancelled nested verification")
  const nested_error = new PipelineError({
    code: "nested_verifier_failed",
    message: "nested verifier failed",
    stage_id: "verify_application_connectivity",
    operation: "validate_agent_artifact",
  })

  try {
    const caught = await runAgentArtifactStage({
      stage_id: "extract_evidence",
      phase_label: "Extract evidence",
      max_artifact_attempts: 4,
      signal: controller.signal,
      use_openai: false,
      agent_client: {
        async run(input) {
          await Bun.write(join(input.workspace, "candidate.txt"), "must not be retained")
          return { attempts: 1, duration_ms: 1, output_tail: "" }
        },
      },
      create_workspace: createWorkspaceFactory(root, () => undefined),
      build_prompt: () => "extract",
      async validate() {
        controller.abort(cancellation)
        throw nested_error
      },
      async promote() {},
      rejection_debug: { debug_dir, files: ["candidate.txt"] },
      on_output() {},
    }).catch((error) => error)

    expect(caught).toBe(cancellation)
    expect(await Bun.file(join(debug_dir, "attempt-history.json")).exists()).toBe(false)
    expect(await Bun.file(join(debug_dir, "rejected-attempts", "1")).exists()).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("bounded cumulative feedback preserves every attempt and the newest diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-artifact-bounded-feedback-"))
  const prompts: string[] = []
  try {
    const result = await runAgentArtifactStage({
      stage_id: "extract_evidence",
      phase_label: "Extract evidence",
      max_artifact_attempts: 4,
      signal: new AbortController().signal,
      use_openai: false,
      agent_client: {
        async run(input) {
          prompts.push(input.prompt)
          return { attempts: 1, duration_ms: 1, output_tail: "" }
        },
      },
      create_workspace: createWorkspaceFactory(root, () => undefined),
      build_prompt: (feedback) => feedback ?? "first attempt",
      async validate(_workspace, attempt) {
        if (attempt <= 3) {
          throw new Error(
            `attempt-${attempt}-prefix:${"x".repeat(3_500)}:attempt-${attempt}-middle-detail:${"y".repeat(3_500)}:attempt-${attempt}-latest-detail`,
          )
        }
        return "valid"
      },
      async promote() {},
      rejection_debug: { debug_dir: join(root, "debug") },
      on_output() {},
    })

    expect(result.attempts).toBe(4)
    expect(prompts[3]!.length).toBeLessThanOrEqual(14_000)
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(prompts[3]).toContain(`Rejected attempt ${attempt}`)
      expect(prompts[3]).toContain(`attempt-${attempt}-prefix`)
      expect(prompts[3]).toContain(`attempt-${attempt}-latest-detail`)
    }
    expect(prompts[3]).toContain("attempt-3-middle-detail")
    expect(prompts[3]).not.toContain("attempt-1-middle-detail")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("cancellation during rejection tracing remains the terminal outcome", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-artifact-cancel-retention-"))
  const controller = new AbortController()
  const cancellation = new Error("cancelled while retaining rejection")
  try {
    const error = await runAgentArtifactStage({
      stage_id: "extract_evidence",
      phase_label: "Extract evidence",
      max_artifact_attempts: 1,
      signal: controller.signal,
      use_openai: false,
      agent_client: {
        async run(input) {
          await Bun.write(join(input.workspace, "candidate.txt"), "invalid")
          return { attempts: 1, duration_ms: 1, output_tail: "" }
        },
      },
      create_workspace: createWorkspaceFactory(root, () => undefined),
      build_prompt: () => "extract",
      async validate() {
        const validation_error = new Error("candidate contract failed")
        throw new Proxy(validation_error, {
          get(target, property, receiver) {
            if (property === "message") controller.abort(cancellation)
            return Reflect.get(target, property, receiver)
          },
        })
      },
      async promote() {},
      rejection_debug: { debug_dir: join(root, "debug"), files: ["candidate.txt"] },
      on_output() {},
    }).catch((caught) => caught)

    expect(error).toBe(cancellation)
    expect(await Bun.file(join(root, "debug", "attempt-history.json")).exists()).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("component and model prompts retain the newest feedback when applying their final bound", () => {
  const feedback = `obsolete-prefix:${"x".repeat(15_000)}:newest-actionable-detail`
  const component = evidencePrompt({ feedback })
  const model = buildCharacterizationPrompt(feedback)

  expect(component).toContain("[Earlier feedback truncated.]")
  expect(component).toContain("newest-actionable-detail")
  expect(model).toContain("[Earlier feedback truncated.]")
  expect(model).toContain("newest-actionable-detail")
})

test("bounded JSON artifact reads reject oversized, deeply nested, broad, and symlink inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "bounded-json-artifact-"))
  const valid_path = join(root, "valid.json")
  const link_path = join(root, "linked.json")
  try {
    await Bun.write(valid_path, '{"items":[1,2]}\n')
    expect(
      await readBoundedJsonArtifact({
        path: valid_path,
        max_bytes: 64,
        max_depth: 3,
        max_nodes: 5,
      }),
    ).toEqual({ items: [1, 2] })
    await expect(
      readBoundedJsonArtifact({ path: valid_path, max_bytes: 8, max_depth: 3, max_nodes: 5 }),
    ).rejects.toThrow("unexpectedly large")
    await expect(
      readBoundedJsonArtifact({ path: valid_path, max_bytes: 64, max_depth: 2, max_nodes: 5 }),
    ).rejects.toThrow("depth limit")
    await expect(
      readBoundedJsonArtifact({ path: valid_path, max_bytes: 64, max_depth: 3, max_nodes: 3 }),
    ).rejects.toThrow("node limit")
    await symlink(valid_path, link_path)
    await expect(
      readBoundedJsonArtifact({ path: link_path, max_bytes: 64, max_depth: 3, max_nodes: 5 }),
    ).rejects.toThrow("not a symlink")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("bounded text artifact reads reject oversized, invalid UTF-8, and symlink inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "bounded-text-artifact-"))
  const valid_path = join(root, "valid.txt")
  const invalid_path = join(root, "invalid.txt")
  const link_path = join(root, "linked.txt")
  try {
    await Bun.write(valid_path, "valid candidate\n")
    await Bun.write(invalid_path, Uint8Array.from([0xc3, 0x28]))
    expect(await readBoundedTextArtifact({ path: valid_path, max_bytes: 64 })).toBe("valid candidate\n")
    await expect(readBoundedTextArtifact({ path: valid_path, max_bytes: 4 })).rejects.toThrow(
      "unexpectedly large",
    )
    await expect(readBoundedTextArtifact({ path: invalid_path, max_bytes: 64 })).rejects.toThrow(
      "valid UTF-8 text",
    )
    await symlink(valid_path, link_path)
    await expect(readBoundedTextArtifact({ path: link_path, max_bytes: 64 })).rejects.toThrow("not a symlink")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
