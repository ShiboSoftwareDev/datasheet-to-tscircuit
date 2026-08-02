import { describe, expect, test } from "bun:test"
import { TsciAgentClient } from "../src/server/infrastructure/agent"
import {
  BunProcessRunner,
  ProcessError,
  type ProcessRunRequest,
  type ProcessRunResult,
  type ProcessRunner,
} from "../src/server/infrastructure/process"

describe("BunProcessRunner", () => {
  test("streams output and returns a bounded diagnostic tail", async () => {
    const chunks: string[] = []
    const result = await new BunProcessRunner().run({
      command: [process.execPath, "-e", "console.log('hello'); console.error('world')"],
      command_label: "test child",
      cwd: process.cwd(),
      signal: new AbortController().signal,
      on_output: (_stream, message) => {
        chunks.push(message)
      },
    })

    expect(result.exit_code).toBe(0)
    expect(chunks.join("")).toContain("hello")
    expect(chunks.join("")).toContain("world")
    expect(result.output_tail).toContain("hello")
  })

  test("never retains more than the configured diagnostic output limit", async () => {
    const result = await new BunProcessRunner().run({
      command: [process.execPath, "-e", "process.stdout.write('x'.repeat(20_000))"],
      command_label: "verbose child",
      cwd: process.cwd(),
      signal: new AbortController().signal,
      max_output_chars: 1_000,
    })

    expect(result.output_tail).toHaveLength(1_000)
    expect(result.output_tail).toBe("x".repeat(1_000))
  })

  test("retains a typed failure without exposing command arguments", async () => {
    const error = await new BunProcessRunner()
      .run({
        command: [process.execPath, "-e", "console.error('useful diagnostic'); process.exit(7)"],
        command_label: "secret-bearing command",
        cwd: process.cwd(),
        signal: new AbortController().signal,
      })
      .catch((caught) => caught)

    expect(error).toBeInstanceOf(ProcessError)
    expect(error.code).toBe("process_exit_failed")
    expect(error.exit_code).toBe(7)
    expect(error.output_tail).toContain("useful diagnostic")
    expect(error.message).not.toContain("process.exit")
  })

  test("cancels the detached process group", async () => {
    const controller = new AbortController()
    const running = new BunProcessRunner().run({
      command: [process.execPath, "-e", "setInterval(() => console.log('alive'), 25)"],
      command_label: "long child",
      cwd: process.cwd(),
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 80)
    const error = await running.catch((caught) => caught)
    expect(error).toBeInstanceOf(ProcessError)
    expect(error.code).toBe("process_cancelled")
  })

  test("does not miss cancellation between startup checks and listener registration", async () => {
    const controller = new AbortController()
    const started_at = performance.now()
    const running = new BunProcessRunner().run({
      command: [process.execPath, "-e", "setTimeout(() => {}, 5_000)"],
      command_label: "startup-race child",
      cwd: process.cwd(),
      signal: controller.signal,
      wall_timeout_ms: 2_000,
    })
    controller.abort()

    const error = await running.catch((caught) => caught)
    expect(error).toBeInstanceOf(ProcessError)
    expect(error.code).toBe("process_cancelled")
    expect(performance.now() - started_at).toBeLessThan(1_000)
  })

  test("reports an idle timeout as its own failure category", async () => {
    const error = await new BunProcessRunner()
      .run({
        command: [process.execPath, "-e", "setTimeout(() => {}, 5_000)"],
        command_label: "silent child",
        cwd: process.cwd(),
        signal: new AbortController().signal,
        idle_timeout_ms: 150,
      })
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(ProcessError)
    expect(error.code).toBe("process_idle_timeout")
  })

  test("enforces an absolute timeout even while the process is producing output", async () => {
    const error = await new BunProcessRunner()
      .run({
        command: [process.execPath, "-e", "setInterval(() => console.log('busy'), 20)"],
        command_label: "busy child",
        cwd: process.cwd(),
        signal: new AbortController().signal,
        idle_timeout_ms: 1_000,
        wall_timeout_ms: 150,
      })
      .catch((caught) => caught)
    expect(error).toBeInstanceOf(ProcessError)
    expect(error.code).toBe("process_wall_timeout")
    expect(error.output_tail).toContain("busy")
  })

  test("a stalled output sink cannot defeat the absolute process deadline", async () => {
    const started_at = performance.now()
    const error = await new BunProcessRunner()
      .run({
        command: [process.execPath, "-e", "console.log('blocked sink'); setTimeout(() => {}, 5_000)"],
        command_label: "blocked output child",
        cwd: process.cwd(),
        signal: new AbortController().signal,
        wall_timeout_ms: 150,
        on_output: () => new Promise<void>(() => undefined),
      })
      .catch((caught) => caught)

    expect(error).toBeInstanceOf(ProcessError)
    expect(error.code).toBe("process_wall_timeout")
    expect(performance.now() - started_at).toBeLessThan(1_000)
  })

  test("reports output sink failures separately from child-process failures", async () => {
    const sink_error = new Error("checkpoint volume is unavailable")
    const error = await new BunProcessRunner()
      .run({
        command: [process.execPath, "-e", "console.log('persist me'); setTimeout(() => {}, 5_000)"],
        command_label: "output failure child",
        cwd: process.cwd(),
        signal: new AbortController().signal,
        wall_timeout_ms: 2_000,
        on_output: () => {
          throw sink_error
        },
      })
      .catch((caught) => caught)

    expect(error).toBeInstanceOf(ProcessError)
    expect(error.code).toBe("process_output_handler_failed")
    expect(error.cause).toBe(sink_error)
  })

  test("cancellation wins a race with an output sink failure", async () => {
    const controller = new AbortController()
    const error = await new BunProcessRunner()
      .run({
        command: [process.execPath, "-e", "console.log('cancel now'); setTimeout(() => {}, 5_000)"],
        command_label: "cancelled output child",
        cwd: process.cwd(),
        signal: controller.signal,
        wall_timeout_ms: 2_000,
        on_output: () => {
          controller.abort()
          throw new Error("late output failure")
        },
      })
      .catch((caught) => caught)

    expect(error).toBeInstanceOf(ProcessError)
    expect(error.code).toBe("process_cancelled")
  })
})

test("server runtime commands are centralized in the supervised process runner", async () => {
  const direct_spawn_files: string[] = []
  const glob = new Bun.Glob("src/server/**/*.ts")
  for await (const file_path of glob.scan(".")) {
    if (file_path.endsWith("/infrastructure/process/process-runner.ts")) continue
    if ((await Bun.file(file_path).text()).includes("Bun.spawn(")) direct_spawn_files.push(file_path)
  }

  expect(direct_spawn_files).toEqual([])
})

class FakeProcessRunner implements ProcessRunner {
  calls = 0
  requests: ProcessRunRequest[] = []

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls += 1
    this.requests.push(request)
    if (this.calls === 1) {
      throw new ProcessError({
        code: "process_exit_failed",
        command_label: request.command_label,
        message: "transport failed",
        exit_code: 1,
        output_tail: "provider: too many concurrent requests; try again",
      })
    }
    return { exit_code: 0, duration_ms: 1, output_tail: "done" }
  }
}

test("TsciAgentClient retries only classified transport failures", async () => {
  const process_runner = new FakeProcessRunner()
  const attempts: string[] = []
  const client = new TsciAgentClient({
    process_runner,
    agent_bin: "unused-agent",
    max_attempts: 2,
    retry_base_delay_ms: 0,
  })
  const result = await client.run({
    workspace: process.cwd(),
    prompt: "private prompt",
    use_openai: false,
    signal: new AbortController().signal,
    phase_label: "analysis agent",
    on_output: () => undefined,
    on_attempt: ({ event }) => {
      attempts.push(event)
    },
  })

  expect(process_runner.calls).toBe(2)
  expect(result.attempts).toBe(2)
  expect(attempts).toEqual([
    "attempt_started",
    "attempt_failed",
    "retry_scheduled",
    "attempt_started",
    "attempt_completed",
  ])
})

test("TsciAgentClient confines model candidates to scoped read/write tools", async () => {
  const process_runner = new FakeProcessRunner()
  const client = new TsciAgentClient({
    process_runner,
    agent_bin: "unused-agent",
    max_attempts: 2,
    retry_base_delay_ms: 0,
  })
  await client.run({
    workspace: process.cwd(),
    prompt: "generate the model",
    use_openai: false,
    signal: new AbortController().signal,
    phase_label: "model generation",
    tool_profile: "model_candidate_files",
    model_candidate_check: { ngspice_path: "/trusted/bin/ngspice" },
    on_output: () => undefined,
  })

  for (const request of process_runner.requests) {
    expect(request.command).toContain("--no-builtin-tools")
    expect(request.command).toContain("--no-extensions")
    expect(request.command).toContain("--no-skills")
    expect(request.command).toContain("--no-prompt-templates")
    expect(request.command).toContain("--no-context-files")
    expect(request.command).toContain("--system-prompt")
    expect(request.command).toContain("--append-system-prompt")
    expect(request.command).toContain("workspace_read,model_output_write,check_model_candidate")
    expect(request.env).toMatchObject({
      DATASHEET_MODEL_CHECK_NGSPICE_BIN: "/trusted/bin/ngspice",
    })
    const extension_index = request.command.indexOf("--extension")
    expect(request.command[extension_index + 1]).toEndWith("model-candidate-tools-extension.ts")
  }
})

test("TsciAgentClient rejects extra extensions in the confined model profile", async () => {
  const process_runner = new FakeProcessRunner()
  const client = new TsciAgentClient({ process_runner, agent_bin: "unused-agent" })
  await expect(
    client.run({
      workspace: process.cwd(),
      prompt: "generate the model",
      use_openai: false,
      signal: new AbortController().signal,
      phase_label: "model generation",
      tool_profile: "model_candidate_files",
      extensions: ["untrusted-extension.ts"],
      on_output: () => undefined,
    }),
  ).rejects.toThrow("does not permit additional extensions")
  expect(process_runner.calls).toBe(0)
})
