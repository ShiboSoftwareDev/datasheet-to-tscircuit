import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createOrVerifyBenchmarkLock,
  replaceBenchmarkLockAfterCircuitRepair,
  verifyBenchmarkLock,
} from "@/server/model-benchmark-lock"

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
            title: "Transfer",
            source: { page: 3 },
            critical: true,
            weight: 1,
            tolerance: 0.05,
            reference_file: "evidence/curves/transfer.csv",
            result_file: "results/champion/transfer.csv",
            simulation: {
              kind: "transient_voltage",
              x_axis: "time_ms",
              probe_name: "VOUT",
              dut_spice_node: "OUT",
            },
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

test("benchmark locks reject synthetic channels and non-transient definitions", async () => {
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
    kind: "static_curve",
    x_axis: "input_voltage",
    probe_name: "VOUT",
    dut_spice_node: "OUT",
  }
  await Bun.write(join(model_dir, "benchmarks.json"), JSON.stringify(manifest))
  await expect(createOrVerifyBenchmarkLock(model_dir)).rejects.toThrow("transient_voltage")

  manifest.benchmarks[0].reference_file = "evidence/../benchmarks/transfer.circuit.tsx"
  manifest.benchmarks[0].simulation = {
    kind: "transient_voltage",
    x_axis: "time_ms",
    probe_name: "VOUT",
    dut_spice_node: "OUT",
  }
  await Bun.write(join(model_dir, "benchmarks.json"), JSON.stringify(manifest))
  await expect(createOrVerifyBenchmarkLock(model_dir)).rejects.toThrow("must stay under evidence")

  await rm(job_dir, { recursive: true, force: true })
})

test("benchmark locks reject voltage probes that target an unresolved net", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-benchmark-probe-target-"))
  const model_dir = join(job_dir, "spice")
  await createLockedFixture(model_dir)
  await Bun.write(
    join(model_dir, "benchmarks", "transfer.circuit.tsx"),
    benchmarkSource.replace('connectsTo="DUT.pin2"', 'connectsTo="net.OUT"'),
  )

  await expect(createOrVerifyBenchmarkLock(model_dir)).rejects.toThrow("connect directly to a DUT port")

  await rm(job_dir, { recursive: true, force: true })
})

test("benchmark locks accept direct DUT selectors containing a greater-than separator", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-benchmark-direct-probe-target-"))
  const model_dir = join(job_dir, "spice")
  await createLockedFixture(model_dir)
  await Bun.write(
    join(model_dir, "benchmarks", "transfer.circuit.tsx"),
    benchmarkSource.replace('connectsTo="DUT.pin2"', 'connectsTo=".DUT > .VOUT"'),
  )

  await expect(createOrVerifyBenchmarkLock(model_dir)).resolves.toMatchObject({
    benchmark_ids: ["transfer"],
  })

  await rm(job_dir, { recursive: true, force: true })
})

test("benchmark locks reject invalid analogsimulation props before refinement", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-benchmark-simulation-props-"))
  const model_dir = join(job_dir, "spice")
  await createLockedFixture(model_dir)
  const invalid_source = benchmarkSource.replace(
    '<analogsimulation duration="1ms"',
    '<analogsimulation simulationType="transient" duration="1ms"',
  )
  await Bun.write(join(model_dir, "benchmarks", "transfer.circuit.tsx"), invalid_source)

  await expect(createOrVerifyBenchmarkLock(model_dir)).rejects.toThrow(
    'simulationType must be omitted or exactly "spice_transient_analysis"',
  )

  await Bun.write(
    join(model_dir, "benchmarks", "transfer.circuit.tsx"),
    invalid_source.replace('simulationType="transient"', 'simulationType="spice_transient_analysis"'),
  )
  await expect(createOrVerifyBenchmarkLock(model_dir)).resolves.toMatchObject({ generation: 1 })

  await rm(job_dir, { recursive: true, force: true })
})

test("controlled circuit repair creates a new immutable lock generation", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-benchmark-lock-generation-"))
  const model_dir = join(job_dir, "spice")
  await createLockedFixture(model_dir)
  const first = await createOrVerifyBenchmarkLock(model_dir)
  expect(first.generation).toBe(1)
  await expect(replaceBenchmarkLockAfterCircuitRepair(model_dir, first)).rejects.toThrow(
    "must repair at least one",
  )

  await Bun.write(
    join(model_dir, "benchmarks", "transfer.circuit.tsx"),
    `${benchmarkSource}\n// Structural harness repair.\n`,
  )
  const second = await replaceBenchmarkLockAfterCircuitRepair(model_dir, first)
  expect(second.generation).toBe(2)
  await expect(verifyBenchmarkLock(model_dir, second)).resolves.toMatchObject({ generation: 2 })
  expect(
    await Bun.file(join(job_dir, ".model-benchmark-lock", "history", "generation-0001.json")).exists(),
  ).toBe(true)
  expect(
    await Bun.file(
      join(
        job_dir,
        ".model-benchmark-lock",
        "snapshots",
        "generation-0002",
        "benchmarks",
        "transfer.circuit.tsx",
      ),
    ).text(),
  ).toContain("Structural harness repair")

  const manifest = JSON.parse(await Bun.file(join(model_dir, "benchmarks.json")).text())
  manifest.benchmarks[0].tolerance = 0.5
  await Bun.write(join(model_dir, "benchmarks.json"), JSON.stringify(manifest))
  await expect(replaceBenchmarkLockAfterCircuitRepair(model_dir, second)).rejects.toThrow(
    "may change only benchmarks/*.circuit.tsx",
  )

  await rm(job_dir, { recursive: true, force: true })
})

test("benchmark locks reject incomplete manifests, malformed references, and invalid TSX", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-benchmark-schema-"))
  const model_dir = join(job_dir, "spice")
  await createLockedFixture(model_dir)

  const manifest = JSON.parse(await Bun.file(join(model_dir, "benchmarks.json")).text())
  delete manifest.benchmarks[0].weight
  await Bun.write(join(model_dir, "benchmarks.json"), JSON.stringify(manifest))
  await expect(createOrVerifyBenchmarkLock(model_dir)).rejects.toThrow("invalid weight")

  manifest.benchmarks[0].weight = 1
  await Bun.write(join(model_dir, "benchmarks.json"), JSON.stringify(manifest))
  await Bun.write(join(model_dir, "evidence", "curves", "transfer.csv"), "x,y\n0,0\n0,1\n")
  await expect(createOrVerifyBenchmarkLock(model_dir)).rejects.toThrow("duplicate x=0")

  await Bun.write(join(model_dir, "evidence", "curves", "transfer.csv"), "x,y\n0,0\n1,1\n")
  await Bun.write(
    join(model_dir, "benchmarks", "transfer.circuit.tsx"),
    benchmarkSource.replace("</board>", "</board"),
  )
  await expect(createOrVerifyBenchmarkLock(model_dir)).rejects.toThrow("invalid TSX")

  await rm(job_dir, { recursive: true, force: true })
})
