import { runDebugCli } from "./pipeline-debug-command"
import { createStderrProgressReporter, projectDebugCliStdout } from "./pipeline-debug-output"

const SIGNAL_EXIT_CODES = [
  { signal: "SIGHUP", exit_code: 129 },
  { signal: "SIGINT", exit_code: 130 },
  { signal: "SIGTERM", exit_code: 143 },
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function runPipelineDebugMain(args = Bun.argv.slice(2)): Promise<void> {
  const cancellation = new AbortController()
  let signalExitCode: number | undefined
  const handlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = []
  for (const { signal, exit_code } of SIGNAL_EXIT_CODES) {
    const handler = () => {
      signalExitCode = exit_code
      process.stderr.write(`[local] ${signal} received; cancelling the active execution...\n`)
      cancellation.abort(new Error(`Local execution interrupted by ${signal}`))
    }
    handlers.push({ signal, handler })
    process.on(signal, handler)
  }

  try {
    const result = await runDebugCli(args, {
      signal: cancellation.signal,
      on_progress: createStderrProgressReporter(),
    })
    process.stdout.write(`${JSON.stringify(projectDebugCliStdout(result), null, 2)}\n`)
    if (isRecord(result) && (result.status === "failed" || result.status === "cancelled")) {
      process.exitCode = signalExitCode ?? 1
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(
        {
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
          },
        },
        null,
        2,
      )}\n`,
    )
    process.exitCode = signalExitCode ?? 1
  } finally {
    for (const { signal, handler } of handlers) process.off(signal, handler)
  }
}
