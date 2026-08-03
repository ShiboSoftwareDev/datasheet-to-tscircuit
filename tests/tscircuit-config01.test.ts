import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { ensureJobTscircuitRuntimeConfig } from "@/server/job-scaffold"
import {
  createLocalNgspiceSpiceEngine,
  normalizeTscircuitTransientInitialization,
} from "@/server/job-scaffold/local-ngspice-engine"
import config from "../tscircuit.config"

test("local engine restores operating-point initialization for tscircuit transients", () => {
  const source = ["* UIC in a comment must remain", "V_UIC uic 0 1", ".tran 1u 10u UIC", ".end", ""].join(
    "\n",
  )

  expect(normalizeTscircuitTransientInitialization(source)).toBe(
    ["* UIC in a comment must remain", "V_UIC uic 0 1", ".tran 1u 10u", ".end", ""].join("\n"),
  )
  expect(normalizeTscircuitTransientInitialization(".tran 1u 10u UIC $ generated\n")).toBe(
    ".tran 1u 10u $ generated\n",
  )
})

test("local engine solves the pre-step operating point for a generated transient", async () => {
  const engine = await createLocalNgspiceSpiceEngine()
  const result = await engine.simulate(
    [
      '* tscircuit_probe {"simulation_voltage_probe_id":"probe_out","name":"V(out)","spice_vector":"v(out)"}',
      "VREF ref 0 1",
      "RCHARGE ref out 1k",
      "COUT out 0 1u",
      ".save v(out)",
      ".tran 1u 10u UIC",
      ".end",
      "",
    ].join("\n"),
  )
  const graph = result.simulationResultCircuitJson.find(
    (element) => element.type === "simulation_transient_voltage_graph",
  ) as { voltage_levels?: number[] } | undefined

  expect(graph?.voltage_levels?.[0]).toBeCloseTo(1, 8)
  expect(graph?.voltage_levels?.at(-1)).toBeCloseTo(1, 8)
})

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
