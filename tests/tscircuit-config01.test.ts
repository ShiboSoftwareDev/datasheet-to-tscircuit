import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { ensureJobTscircuitRuntimeConfig } from "@/server/job-scaffold"
import config from "../tscircuit.config"

test("runtime platform config preserves a ready ngspice engine for disabled PCB builds", () => {
  const engine = config.platformConfig.spiceEngineMap.ngspice

  expect(typeof engine.simulate).toBe("function")
})

test("generated job config keeps ngspice ready when CLI performance flags replace platform config", async () => {
  const tmp_root = join(process.cwd(), "tmp")
  await mkdir(tmp_root, { recursive: true })
  const job_dir = await mkdtemp(join(tmp_root, "ngspice-job-config-"))
  try {
    await ensureJobTscircuitRuntimeConfig(job_dir)
    const config_url = `${pathToFileURL(join(job_dir, "tscircuit.config.ts")).href}?test=${Date.now()}`
    const generated = (await import(config_url)).default as typeof config
    expect(typeof generated.platformConfig.spiceEngineMap.ngspice.simulate).toBe("function")
  } finally {
    await rm(job_dir, { recursive: true, force: true })
  }
})
