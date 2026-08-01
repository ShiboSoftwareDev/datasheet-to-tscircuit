import { afterEach, expect, test } from "bun:test"
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createModelCandidateFileTools } from "../src/server/infrastructure/agent/model-candidate-tools-extension"

const temporary_directories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporary_directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporary_directories.push(directory)
  return directory
}

async function executeTool(tool: unknown, parameters: Record<string, unknown>) {
  return (tool as { execute: (...args: unknown[]) => Promise<unknown> }).execute(
    "test-call",
    parameters,
    new AbortController().signal,
    () => undefined,
    undefined,
  )
}

test("model candidate tools are visible to the agent under their scoped capability names", async () => {
  const workspace = await makeTemporaryDirectory("model-tools-workspace-")
  const [read_tool, write_tool] = createModelCandidateFileTools(workspace)

  expect(read_tool.name).toBe("workspace_read")
  expect(read_tool.label).toBe("workspace_read")
  expect(read_tool.description).toContain("isolated model-candidate workspace")
  expect(read_tool.description).not.toContain("bash")
  expect(read_tool.promptSnippet).toContain("isolated model-candidate workspace")
  expect(read_tool.promptGuidelines).toEqual([
    "Use workspace_read to inspect declared candidate-workspace inputs.",
  ])

  expect(write_tool.name).toBe("model_output_write")
  expect(write_tool.label).toBe("model_output_write")
  expect(write_tool.description).toContain("model.lib or model-card.md")
  expect(write_tool.promptSnippet).toContain("model.lib or model-card.md")
  expect(write_tool.promptGuidelines).toEqual([
    "Use model_output_write only for model.lib and model-card.md.",
  ])
})

test("model candidate tools cannot read outside their workspace or through an escaping symlink", async () => {
  const workspace = await makeTemporaryDirectory("model-tools-workspace-")
  const outside = await makeTemporaryDirectory("model-tools-outside-")
  await writeFile(join(workspace, "model-contract.json"), "inside", "utf8")
  await symlink(join(workspace, "model-contract.json"), join(workspace, "internal-link.json"))
  await writeFile(join(outside, "private-validation-plan.json"), "secret", "utf8")
  await symlink(join(outside, "private-validation-plan.json"), join(workspace, "escaped.json"))
  await link(join(outside, "private-validation-plan.json"), join(workspace, "hard-linked.json"))
  const [read_tool] = createModelCandidateFileTools(workspace)

  const inside_result = (await executeTool(read_tool, { path: "model-contract.json" })) as {
    content: Array<{ type: string; text?: string }>
  }
  expect(inside_result.content[0]?.text).toContain("inside")
  await expect(
    executeTool(read_tool, { path: join(outside, "private-validation-plan.json") }),
  ).rejects.toThrow("only access files")
  await expect(executeTool(read_tool, { path: "escaped.json" })).rejects.toThrow(
    "may not read symbolic links",
  )
  await expect(executeTool(read_tool, { path: "internal-link.json" })).rejects.toThrow(
    "may not read symbolic links",
  )
  await expect(executeTool(read_tool, { path: "hard-linked.json" })).rejects.toThrow("hard-linked files")
})

test("model candidate tools may write only the two declared outputs and never follow output links", async () => {
  const workspace = await makeTemporaryDirectory("model-tools-workspace-")
  const outside = await makeTemporaryDirectory("model-tools-outside-")
  const outside_file = join(outside, "do-not-touch.lib")
  await writeFile(outside_file, "unchanged", "utf8")
  const [, write_tool] = createModelCandidateFileTools(workspace)

  await executeTool(write_tool, { path: "model.lib", content: ".SUBCKT X A B\n.ENDS X\n" })
  expect(await readFile(join(workspace, "model.lib"), "utf8")).toContain(".SUBCKT X")
  await expect(executeTool(write_tool, { path: "model-contract.json", content: "tampered" })).rejects.toThrow(
    "write only model.lib and model-card.md",
  )
  await mkdir(join(workspace, "nested"))
  await expect(executeTool(write_tool, { path: "nested/model-card.md", content: "no" })).rejects.toThrow(
    "Model generation",
  )

  await symlink(outside_file, join(workspace, "model-card.md"))
  await expect(executeTool(write_tool, { path: "model-card.md", content: "tampered" })).rejects.toThrow(
    "regular file",
  )
  expect(await readFile(outside_file, "utf8")).toBe("unchanged")

  await rm(join(workspace, "model-card.md"))
  await link(outside_file, join(workspace, "model-card.md"))
  await expect(executeTool(write_tool, { path: "model-card.md", content: "tampered" })).rejects.toThrow(
    "regular file",
  )
  expect(await readFile(outside_file, "utf8")).toBe("unchanged")
})
