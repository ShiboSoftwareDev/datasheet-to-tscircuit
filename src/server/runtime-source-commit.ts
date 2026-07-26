import { repositoryRoot } from "./paths/repository-paths"

export async function getRuntimeSourceCommit(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const configured =
    environment.SOURCE_COMMIT ??
    environment.GIT_COMMIT ??
    environment.VERCEL_GIT_COMMIT_SHA ??
    environment.GITHUB_SHA
  if (configured?.trim() && configured.trim() !== "unavailable") return configured.trim()

  try {
    const child = Bun.spawn(["git", "rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "ignore",
    })
    const [exit_code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]).catch(
      () => [-1, ""] as const,
    )
    const commit = output.trim()
    return exit_code === 0 && /^[0-9a-f]{40}$/i.test(commit) ? commit : "unavailable"
  } catch {
    return "unavailable"
  }
}
