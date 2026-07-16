import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseBenchmarkManifest, scoreModelBenchmarks } from "@/server/model-scorer"

test("model scorer evaluates every locked benchmark from numeric CSV data", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-scorer-"))
  await Promise.all([
    mkdir(join(model_dir, "evidence"), { recursive: true }),
    mkdir(join(model_dir, "results", "champion"), { recursive: true }),
  ])
  await Bun.write(
    join(model_dir, "benchmarks.json"),
    JSON.stringify({
      version: 1,
      locked_at: new Date().toISOString(),
      benchmarks: [
        {
          id: "transfer",
          title: "Transfer curve",
          source: { page: 4, figure: "Figure 2" },
          critical: true,
          weight: 1,
          tolerance: 0.05,
          reference_file: "evidence/transfer.csv",
          result_file: "results/champion/transfer.csv",
          simulation: {
            kind: "transient_voltage",
            x_axis: "time_ms",
            probe_name: "RESULT",
            dut_spice_node: "OUT",
          },
        },
        {
          id: "dropout",
          title: "Dropout curve",
          source: { page: 5 },
          critical: false,
          weight: 1,
          tolerance: 0.05,
          reference_file: "evidence/dropout.csv",
          result_file: "results/champion/dropout.csv",
          simulation: {
            kind: "transient_voltage",
            x_axis: "time_ms",
            probe_name: "RESULT",
            dut_spice_node: "OUT",
          },
        },
      ],
    }),
  )
  await Promise.all([
    Bun.write(join(model_dir, "evidence", "transfer.csv"), "x,y\n0,0\n1,1\n2,2\n"),
    Bun.write(join(model_dir, "results", "champion", "transfer.csv"), "x,y\n0,0\n1,1\n2,2\n"),
    Bun.write(join(model_dir, "evidence", "dropout.csv"), "x,y\n0,0\n1,1\n2,2\n"),
    Bun.write(join(model_dir, "results", "champion", "dropout.csv"), "x,y\n0,0\n1,2\n2,4\n"),
  ])

  const report = await scoreModelBenchmarks(model_dir)

  expect(report.benchmark_count).toBe(2)
  expect(report.passing_count).toBe(1)
  expect(report.all_critical_passed).toBe(true)
  expect(report.all_passed).toBe(false)
  expect(report.benchmarks[0]?.normalized_rmse).toBe(0)
  expect(report.benchmarks[1]?.passed).toBe(false)

  await rm(model_dir, { recursive: true, force: true })
})

test("benchmark manifests accept only complete time-domain waveform definitions", async () => {
  const base = {
    version: 1 as const,
    locked_at: new Date().toISOString(),
    benchmarks: [
      {
        id: "bend",
        title: "Transient waveform",
        source: { page: 2 },
        critical: true,
        weight: 1,
        tolerance: 0.01,
        max_error_tolerance: 0.02,
        reference_file: "evidence/waveform.csv",
        result_file: "results/champion/bend.csv",
        simulation: {
          kind: "transient_voltage",
          x_axis: "time_ms",
          probe_name: "RESULT",
          dut_spice_node: "OUT",
        },
      },
    ],
  }
  expect(parseBenchmarkManifest(base).benchmarks[0]?.simulation.x_axis).toBe("time_ms")
  const invalid = structuredClone(base)
  invalid.benchmarks[0]!.simulation = {
    kind: "static_curve",
    x_axis: "input_voltage",
    probe_name: "RESULT",
    dut_spice_node: "OUT",
  } as (typeof invalid.benchmarks)[0]["simulation"]
  expect(() => parseBenchmarkManifest(invalid)).toThrow('transient_voltage simulation with x_axis "time_ms"')
})
