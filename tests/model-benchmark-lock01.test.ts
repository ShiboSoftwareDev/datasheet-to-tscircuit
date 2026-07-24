import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createOrVerifyBenchmarkLock,
  replaceBenchmarkLockAfterCircuitRepair,
  validateBenchmarkSuiteForLock,
  verifyBenchmarkLock,
} from "@/server/model-benchmark-lock"
import { assertBenchmarkSourceContract } from "@/server/model-benchmark-lock/assert-benchmark-source-contract"
import type { BenchmarkRecord } from "@/server/model-benchmark-lock/types"

const referencePng = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
  (character) => character.charCodeAt(0),
)

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
    mkdir(join(model_dir, "evidence", "figures"), { recursive: true }),
  ])
  await Promise.all([
    Bun.write(join(model_dir, "benchmarks", "transfer.circuit.tsx"), benchmarkSource),
    Bun.write(join(model_dir, "evidence", "curves", "transfer.csv"), "x,y\n0,0\n1,1\n"),
    Bun.write(join(model_dir, "evidence", "figures", "transfer.png"), referencePng),
    Bun.write(
      join(model_dir, "benchmarks.json"),
      JSON.stringify({
        version: 1,
        locked_at: new Date().toISOString(),
        benchmarks: [
          {
            id: "transfer",
            title: "Transfer",
            source: { page: 3, image: "evidence/figures/transfer.png" },
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

test("new benchmark suites require and lock one exact graph crop per benchmark", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-benchmark-image-lock-"))
  const model_dir = join(job_dir, "spice")
  await createLockedFixture(model_dir)

  const manifest = JSON.parse(await Bun.file(join(model_dir, "benchmarks.json")).text())
  delete manifest.benchmarks[0].source.image
  await Bun.write(join(model_dir, "benchmarks.json"), JSON.stringify(manifest))
  await expect(validateBenchmarkSuiteForLock(model_dir, { require_source_images: true })).rejects.toThrow(
    "must declare source.image",
  )

  manifest.benchmarks[0].source.image = "evidence/figures/transfer.png"
  await Bun.write(join(model_dir, "benchmarks.json"), JSON.stringify(manifest))
  await Bun.write(join(model_dir, "evidence", "figures", "transfer.png"), "not a png")
  await expect(validateBenchmarkSuiteForLock(model_dir, { require_source_images: true })).rejects.toThrow(
    "must be a valid PNG graph crop",
  )

  await Bun.write(join(model_dir, "evidence", "figures", "transfer.png"), referencePng)
  const lock = await createOrVerifyBenchmarkLock(model_dir)
  expect(lock.files.some(({ file }) => file === "evidence/figures/transfer.png")).toBe(true)
  expect(
    new Uint8Array(
      await Bun.file(
        join(
          job_dir,
          ".model-benchmark-lock",
          "snapshots",
          "generation-0001",
          "evidence",
          "figures",
          "transfer.png",
        ),
      ).arrayBuffer(),
    ),
  ).toEqual(referencePng)

  const changed_image = referencePng.slice()
  changed_image[changed_image.length - 1] ^= 1
  await Bun.write(join(model_dir, "evidence", "figures", "transfer.png"), changed_image)
  await expect(verifyBenchmarkLock(model_dir)).rejects.toThrow("no longer matches")

  await rm(job_dir, { recursive: true, force: true })
})

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

test("benchmark locks preserve and validate server-owned evidence-only exclusions", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-benchmark-exclusion-lock-"))
  const model_dir = join(job_dir, "spice")
  await createLockedFixture(model_dir)
  await Promise.all([
    Bun.write(
      join(model_dir, "benchmark-draft.json"),
      JSON.stringify({ version: 2, benchmarks: [{ id: "transfer" }, { id: "bad-stimulus" }] }),
    ),
    Bun.write(
      join(model_dir, "benchmark-exclusions.json"),
      JSON.stringify({
        version: 1,
        excluded_at: new Date().toISOString(),
        excluded: [
          {
            benchmark_id: "bad-stimulus",
            reasons: ["stimulus does not match its digitized channel"],
          },
        ],
      }),
    ),
  ])

  const lock = await createOrVerifyBenchmarkLock(model_dir)
  expect(lock.files.some(({ file }) => file === "benchmark-exclusions.json")).toBe(true)
  await expect(verifyBenchmarkLock(model_dir, lock)).resolves.toMatchObject({
    benchmark_ids: ["transfer"],
  })

  const exclusions = JSON.parse(await Bun.file(join(model_dir, "benchmark-exclusions.json")).text())
  exclusions.excluded[0].reasons = ["weakened after locking"]
  await Bun.write(join(model_dir, "benchmark-exclusions.json"), JSON.stringify(exclusions))
  await expect(verifyBenchmarkLock(model_dir, lock)).rejects.toThrow("no longer matches")

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

test("multi-channel voltage stimuli must be probed at the driven DUT port", () => {
  const benchmark: BenchmarkRecord = {
    id: "line-transient",
    source_image: "evidence/figures/line-transient.png",
    series: [
      {
        id: "vout",
        role: "response",
        quantity: "voltage",
        unit: "V",
        reference_file: "evidence/curves/line-transient/vout.csv",
        simulation: {
          kind: "transient_voltage",
          x_axis: "time_ms",
          probe_name: "VOUT",
          dut_spice_node: "VOUT",
        },
      },
      {
        id: "vin",
        role: "stimulus",
        quantity: "voltage",
        unit: "V",
        reference_file: "evidence/curves/line-transient/vin.csv",
        simulation: {
          kind: "transient_voltage",
          x_axis: "time_ms",
          probe_name: "VIN",
        },
      },
    ],
  }
  const direct_probe_source = `import Component from "../component-with-model.circuit"

export default () => <board>
  <Component name="DUT" />
  <voltageprobe name="VOUT" connectsTo=".DUT > .VOUT" />
  <voltageprobe name="VIN" connectsTo=".DUT > .VIN" />
  <analogsimulation duration="1ms" timePerStep="0.1ms" spiceEngine="ngspice" />
</board>`

  expect(() => assertBenchmarkSourceContract(direct_probe_source, benchmark)).not.toThrow()
  expect(() =>
    assertBenchmarkSourceContract(
      direct_probe_source.replace('connectsTo=".DUT > .VIN"', 'connectsTo=".VIN_SOURCE > .pin1"'),
      benchmark,
    ),
  ).toThrow("must measure the applied waveform directly at its DUT port")
  expect(() =>
    assertBenchmarkSourceContract(
      direct_probe_source.replace("<board>", '<board><spicemodel name="VIN_SOURCE" />'),
      benchmark,
    ),
  ).not.toThrow()
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

test("current channels require a differential probe across their declared sense resistor", () => {
  const benchmark: BenchmarkRecord = {
    id: "switching",
    series: [
      {
        id: "il",
        role: "response",
        quantity: "current",
        unit: "A",
        reference_file: "evidence/curves/switching/il.csv",
        simulation: {
          kind: "transient_voltage",
          x_axis: "time_ms",
          probe_name: "RESULT_IL",
          dut_spice_node: "L1",
          sense_resistor: "R_IL_SENSE",
          scale: 100,
        },
      },
    ],
  }
  const direct_pin_probe = `import Component from "../component-with-model.circuit"
export default () => <board>
  <Component name="DUT" />
  <resistor name="R_IL_SENSE" resistance="10m" />
  <voltageprobe name="RESULT_IL" connectsTo=".DUT > .L1" referenceTo="net.GND" />
  <analogsimulation duration="1ms" timePerStep="0.1ms" spiceEngine="ngspice" />
</board>`
  expect(() => assertBenchmarkSourceContract(direct_pin_probe, benchmark)).toThrow(
    "must measure differentially across both pins",
  )

  const sensed_probe = direct_pin_probe.replace(
    'connectsTo=".DUT > .L1" referenceTo="net.GND"',
    'connectsTo=".R_IL_SENSE > .pin1" referenceTo=".R_IL_SENSE > .pin2"',
  )
  expect(() => assertBenchmarkSourceContract(sensed_probe, benchmark)).not.toThrow()
})

test("benchmark locks warn about copied response digitization without withholding output", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-benchmark-duplicate-response-"))
  const model_dir = join(job_dir, "spice")
  await Promise.all([
    mkdir(join(model_dir, "benchmarks"), { recursive: true }),
    mkdir(join(model_dir, "evidence", "curves"), { recursive: true }),
  ])
  await Promise.all([
    Bun.write(join(model_dir, "benchmarks", "pfm.circuit.tsx"), benchmarkSource),
    Bun.write(join(model_dir, "benchmarks", "pwm.circuit.tsx"), benchmarkSource),
    Bun.write(join(model_dir, "evidence", "curves", "pfm.csv"), "x,y\n0,0\n1,1\n2,0\n"),
    Bun.write(join(model_dir, "evidence", "curves", "pwm.csv"), "x,y\n0,0\n1,1\n2,0\n"),
    Bun.write(
      join(model_dir, "benchmarks.json"),
      JSON.stringify({
        version: 1,
        locked_at: new Date().toISOString(),
        benchmarks: ["pfm", "pwm"].map((id, index) => ({
          id,
          title: id.toUpperCase(),
          source: { page: 10 + index },
          critical: true,
          weight: 1,
          tolerance: 0.1,
          reference_file: `evidence/curves/${id}.csv`,
          result_file: `results/champion/${id}.csv`,
          simulation: {
            kind: "transient_voltage",
            x_axis: "time_ms",
            probe_name: "VOUT",
            dut_spice_node: "OUT",
          },
        })),
      }),
    ),
  ])

  const warnings = await validateBenchmarkSuiteForLock(model_dir)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain("independently digitize each datasheet figure")
  await rm(job_dir, { recursive: true, force: true })
})

test("benchmark locks warn about near-identical response shapes without withholding output", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-benchmark-near-duplicate-response-"))
  const model_dir = join(job_dir, "spice")
  await Promise.all([
    mkdir(join(model_dir, "benchmarks"), { recursive: true }),
    mkdir(join(model_dir, "evidence", "curves"), { recursive: true }),
  ])
  await Promise.all([
    Bun.write(join(model_dir, "benchmarks", "pfm.circuit.tsx"), benchmarkSource),
    Bun.write(join(model_dir, "benchmarks", "pwm.circuit.tsx"), benchmarkSource),
    Bun.write(join(model_dir, "evidence", "curves", "pfm.csv"), "x,y\n0,0\n1,1\n2,0\n"),
    Bun.write(join(model_dir, "evidence", "curves", "pwm.csv"), "x,y\n0,2\n1,4\n2,2\n"),
    Bun.write(
      join(model_dir, "benchmarks.json"),
      JSON.stringify({
        version: 1,
        locked_at: new Date().toISOString(),
        benchmarks: ["pfm", "pwm"].map((id, index) => ({
          id,
          title: id.toUpperCase(),
          source: { page: 10 + index },
          critical: true,
          weight: 1,
          tolerance: 0.1,
          reference_file: `evidence/curves/${id}.csv`,
          result_file: `results/champion/${id}.csv`,
          simulation: {
            kind: "transient_voltage",
            x_axis: "time_ms",
            probe_name: "VOUT",
            dut_spice_node: "OUT",
          },
        })),
      }),
    ),
  ])

  const warnings = await validateBenchmarkSuiteForLock(model_dir)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain("near-identical normalized shape")
  await rm(job_dir, { recursive: true, force: true })
})

test("benchmark locks warn about copied channel images without withholding output", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-benchmark-duplicate-channel-image-"))
  const model_dir = join(job_dir, "spice")
  const source = benchmarkSource.replace(
    '<voltageprobe name="VOUT" connectsTo="DUT.pin2" />',
    '<voltageprobe name="VOUT" connectsTo="DUT.pin2" />\n      <voltageprobe name="PG" connectsTo="DUT.pin2" />',
  )
  await Promise.all([
    mkdir(join(model_dir, "benchmarks"), { recursive: true }),
    mkdir(join(model_dir, "evidence", "curves", "startup"), { recursive: true }),
    mkdir(join(model_dir, "evidence", "figures", "startup"), { recursive: true }),
  ])
  await Promise.all([
    Bun.write(join(model_dir, "benchmarks", "startup.circuit.tsx"), source),
    Bun.write(join(model_dir, "evidence", "curves", "startup", "vout.csv"), "x,y\n0,0\n1,1\n2,2\n"),
    Bun.write(join(model_dir, "evidence", "curves", "startup", "pg.csv"), "x,y\n0,0\n1,0\n2,1\n"),
    Bun.write(join(model_dir, "evidence", "figures", "startup.png"), referencePng),
    Bun.write(join(model_dir, "evidence", "figures", "startup", "vout.png"), referencePng),
    Bun.write(join(model_dir, "evidence", "figures", "startup", "pg.png"), referencePng),
    Bun.write(
      join(model_dir, "benchmarks.json"),
      JSON.stringify({
        version: 2,
        locked_at: new Date().toISOString(),
        benchmarks: [
          {
            id: "startup",
            title: "Startup",
            source: {
              page: 10,
              figure: "Figure 10-1",
              image: "evidence/figures/startup.png",
              channel_count: 2,
            },
            critical: true,
            weight: 1,
            tolerance: 0.1,
            series: [
              {
                id: "vout",
                title: "Output voltage",
                role: "response",
                quantity: "voltage",
                unit: "V",
                weight: 1,
                source_image: "evidence/figures/startup/vout.png",
                reference_file: "evidence/curves/startup/vout.csv",
                result_file: "results/champion/startup/vout.csv",
                simulation: {
                  kind: "transient_voltage",
                  x_axis: "time_ms",
                  probe_name: "VOUT",
                  dut_spice_node: "OUT",
                },
              },
              {
                id: "pg",
                title: "Power good",
                role: "response",
                quantity: "voltage",
                unit: "V",
                weight: 1,
                source_image: "evidence/figures/startup/pg.png",
                reference_file: "evidence/curves/startup/pg.csv",
                result_file: "results/champion/startup/pg.csv",
                simulation: {
                  kind: "transient_voltage",
                  x_axis: "time_ms",
                  probe_name: "PG",
                  dut_spice_node: "OUT",
                },
              },
            ],
          },
        ],
      }),
    ),
  ])

  const warnings = await validateBenchmarkSuiteForLock(model_dir, { require_source_images: true })
  expect(warnings.filter((warning) => warning.includes("complete figure"))).toHaveLength(2)
  expect(warnings.some((warning) => warning.includes("same channel image"))).toBe(true)
  await rm(job_dir, { recursive: true, force: true })
})
