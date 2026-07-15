import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOrVerifyBenchmarkLock, verifyBenchmarkLock } from "@/server/model-benchmark-lock"

const benchmarkSource = `import Component from "../component-with-model.circuit"

export default function TransferBenchmark() {
  return (
    <board routingDisabled>
      <Component name="DUT" />
      <voltageprobe name="VOUT" connectsTo="DUT.pin2" />
      <analogsimulation duration="1ms" timePerStep="0.1ms" spiceEngine="ngspice" />
    </board>
  )
}
`

async function createLockedFixture(model_dir: string): Promise<void> {
  await Promise.all([
    mkdir(join(model_dir, "benchmarks"), { recursive: true }),
    mkdir(join(model_dir, "evidence", "curves"), { recursive: true }),
  ])
  await Promise.all([
    Bun.write(join(model_dir, "benchmarks", "transfer.circuit.tsx"), benchmarkSource),
    Bun.write(join(model_dir, "evidence", "curves", "transfer.csv"), "x,y\n0,0\n1,1\n"),
    Bun.write(
      join(model_dir, "benchmarks.json"),
      JSON.stringify({
        version: 1,
        locked_at: new Date().toISOString(),
        benchmarks: [
          {
            id: "transfer",
            tolerance: 0.05,
            reference_file: "evidence/curves/transfer.csv",
            simulation: { kind: "transient_voltage", probe_name: "VOUT" },
          },
        ],
      }),
    ),
  ])
}

test("server-owned benchmark locks reject tolerance and evidence tampering", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-benchmark-lock-"))
  const model_dir = join(job_dir, "spice")
  await createLockedFixture(model_dir)
  await createOrVerifyBenchmarkLock(model_dir)
  expect(await Bun.file(join(job_dir, ".model-benchmark-lock", "lock.json")).exists()).toBe(true)
  expect(await verifyBenchmarkLock(model_dir)).toMatchObject({ benchmark_ids: ["transfer"] })

  const manifest = JSON.parse(await Bun.file(join(model_dir, "benchmarks.json")).text())
  manifest.benchmarks[0].tolerance = 1
  await Bun.write(join(model_dir, "benchmarks.json"), JSON.stringify(manifest))
  await expect(createOrVerifyBenchmarkLock(model_dir)).rejects.toThrow("locked benchmark suite")

  await rm(job_dir, { recursive: true, force: true })
})

test("benchmark locks reject synthetic channels and unconsumed sweep props", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-benchmark-contract-"))
  const model_dir = join(job_dir, "spice")
  await createLockedFixture(model_dir)
  await Bun.write(
    join(model_dir, "benchmarks", "transfer.circuit.tsx"),
    benchmarkSource.replace('<Component name="DUT" />', '<Component name="DUT" benchmarkCode={1} />'),
  )
  await expect(createOrVerifyBenchmarkLock(model_dir)).rejects.toThrow("synthetic benchmark backchannel")

  await Bun.write(join(model_dir, "benchmarks", "transfer.circuit.tsx"), benchmarkSource)
  const manifest = JSON.parse(await Bun.file(join(model_dir, "benchmarks.json")).text())
  manifest.benchmarks[0].simulation = {
    kind: "parameter_sweep",
    probe_name: "VOUT",
    points: [
      { x: 0, props: { sweepValue: 0 } },
      { x: 1, props: { sweepValue: 1 } },
    ],
  }
  await Bun.write(join(model_dir, "benchmarks.json"), JSON.stringify(manifest))
  await expect(createOrVerifyBenchmarkLock(model_dir)).rejects.toThrow("does not consume injected prop")

  manifest.benchmarks[0].reference_file = "evidence/../benchmarks/transfer.circuit.tsx"
  manifest.benchmarks[0].simulation = { kind: "transient_voltage", probe_name: "VOUT" }
  await Bun.write(join(model_dir, "benchmarks.json"), JSON.stringify(manifest))
  await expect(createOrVerifyBenchmarkLock(model_dir)).rejects.toThrow("must stay under evidence")

  await rm(job_dir, { recursive: true, force: true })
})
