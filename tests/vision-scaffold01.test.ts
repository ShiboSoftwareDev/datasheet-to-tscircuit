import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { VISION_RENDERER_FILENAME, writeVisionRenderer } from "@/server/vision-scaffold"

test("the scaffolded vision renderer converts tscircuit SVG output to PNG", async () => {
  const workspace_tmp = join(process.cwd(), "tmp")
  await mkdir(workspace_tmp, { recursive: true })
  const directory = await mkdtemp(join(workspace_tmp, "vision-renderer-"))

  try {
    const svg_path = join(directory, "schematic.svg")
    await Bun.write(
      svg_path,
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="white"/><path d="M10 40h100" stroke="black" stroke-width="4"/></svg>',
    )
    await writeVisionRenderer(directory)

    const child_process = Bun.spawn([process.execPath, join(directory, VISION_RENDERER_FILENAME), svg_path], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exit_code, stdout, stderr] = await Promise.all([
      child_process.exited,
      new Response(child_process.stdout).text(),
      new Response(child_process.stderr).text(),
    ])

    expect(stderr).toBe("")
    expect(exit_code).toBe(0)
    expect(stdout).toContain("schematic.png")
    const png = new Uint8Array(await Bun.file(join(directory, "schematic.png")).arrayBuffer())
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
