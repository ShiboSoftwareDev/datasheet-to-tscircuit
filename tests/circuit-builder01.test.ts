import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProcessRunRequest, ProcessRunResult, ProcessRunner } from "@/server/infrastructure/process"
import { buildTscircuitSource } from "@/server/infrastructure/tscircuit"

class RecordingCircuitRunner implements ProcessRunner {
  readonly requests: ProcessRunRequest[] = []

  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.requests.push(request)
    if (request.command[1] === "build") {
      const output_dir = join(request.cwd, "dist", "bounded")
      await mkdir(output_dir, { recursive: true })
      await Bun.write(
        join(output_dir, "circuit.json"),
        JSON.stringify([{ type: "source_component", source_component_id: "U1" }]),
      )
    }
    return { exit_code: 0, duration_ms: 1, output_tail: "" }
  }
}

test("every tscircuit subprocess has idle and absolute deadlines", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "bounded-tscircuit-build-"))
  const process_runner = new RecordingCircuitRunner()
  try {
    await buildTscircuitSource({
      workspace,
      source_file: "index.circuit.tsx",
      output_stem: "bounded",
      tsci_bin: "tsci-fixture",
      process_runner,
      signal: new AbortController().signal,
      checks: ["netlist"],
    })

    expect(process_runner.requests).toHaveLength(2)
    for (const request of process_runner.requests) {
      expect(request.idle_timeout_ms).toBeGreaterThan(0)
      expect(request.wall_timeout_ms).toBeGreaterThan(request.idle_timeout_ms ?? 0)
      expect(request.env?.NODE_PATH).toContain("node_modules")
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
