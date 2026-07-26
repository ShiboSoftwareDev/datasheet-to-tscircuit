import { expect, test } from "bun:test"
import { getRuntimeSourceCommit } from "@/server/runtime-source-commit"

test("Docker start rebuilds current source and injects its revision into the runtime", async () => {
  const [package_json, compose, docker_helper] = await Promise.all([
    Bun.file("package.json").json() as Promise<{ scripts: Record<string, string> }>,
    Bun.file("compose.yaml").text(),
    Bun.file("scripts/docker-compose-with-source.sh").text(),
  ])

  expect(package_json.scripts.start).toContain("up --build")
  expect(package_json.scripts.start).not.toContain("--no-build")
  expect(package_json.scripts.build).toContain("docker-compose-with-source.sh")
  expect(compose).toContain("SOURCE_COMMIT: ${SOURCE_COMMIT:-unavailable}")
  expect(docker_helper).toContain("git rev-parse HEAD")
  expect(docker_helper).toContain("git status --porcelain")
  expect(docker_helper).toContain('export SOURCE_COMMIT="$source_commit"')
})

test("an injected Docker source revision wins over repository fallback", async () => {
  const source_commit = "0123456789abcdef0123456789abcdef01234567"
  expect(await getRuntimeSourceCommit({ SOURCE_COMMIT: source_commit })).toBe(source_commit)
})
