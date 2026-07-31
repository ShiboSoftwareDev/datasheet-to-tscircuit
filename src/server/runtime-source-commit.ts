import { repositoryRoot } from "./paths/repository-paths"
import { BunProcessRunner, type ProcessRunner } from "./infrastructure/process"

export async function getRuntimeSourceCommit(
  environment: NodeJS.ProcessEnv = process.env,
  process_runner: ProcessRunner = new BunProcessRunner(),
): Promise<string> {
  const configured =
    environment.SOURCE_COMMIT ??
    environment.GIT_COMMIT ??
    environment.VERCEL_GIT_COMMIT_SHA ??
    environment.GITHUB_SHA
  if (configured?.trim() && configured.trim() !== "unavailable") return configured.trim()

  let output = ""
  try {
    await process_runner.run({
      command: ["git", "rev-parse", "HEAD"],
      command_label: "resolve workflow source commit",
      cwd: repositoryRoot,
      signal: new AbortController().signal,
      idle_timeout_ms: 1_000,
      wall_timeout_ms: 2_000,
      max_output_chars: 4_096,
      on_output(stream, message) {
        if (stream === "stdout") output = `${output}${message}`.slice(-4_096)
      },
    })
    const commit = output.trim()
    return /^[0-9a-f]{40}$/i.test(commit) ? commit : "unavailable"
  } catch {
    return "unavailable"
  }
}
