import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentClient } from "@/server/infrastructure/agent"
import { runAgentArtifactStage } from "@/server/infrastructure/agent"
import type { StageWorkspace } from "@/server/infrastructure/artifacts"
import { ProcessError } from "@/server/infrastructure/process"
import { PipelineError } from "@/server/pipeline"

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
  const prompts: string[] = []
  const agent_client: AgentClient = {
    async run(input) {
      agent_count += 1
      prompts.push(input.prompt)
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
