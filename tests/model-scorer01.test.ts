import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeModelScaffold } from "@/server/model-scaffold"
import sharp from "sharp"
import {
  getBenchmarkRangeCoverageError,
  getReferenceTimeAxisError,
  parseBenchmarkManifest,
  renderModelBenchmarkComparisonSvg,
  scoreModelBenchmarks,
  scoreSeriesPoints,
  scoreSingleModelBenchmark,
  validateFigureTraceColorCoverage,
} from "@/server/model-scorer"

test("benchmark range coverage rejects a missing terminal sample but tolerates floating-point noise", () => {
  const reference_points = [
    { x: 0, y: 0 },
    { x: 5, y: 1 },
  ]
  expect(
    getBenchmarkRangeCoverageError({
      reference_points,
      result_points: [
        { x: 0, y: 0 },
        { x: 4.99, y: 1 },
      ],
    }),
  ).toBe("simulation ends at x=4.99 but the reference requires x=5")
  expect(
    getBenchmarkRangeCoverageError({
      reference_points,
      result_points: [
        { x: Number.EPSILON, y: 0 },
        { x: 5 - 1e-14, y: 1 },
      ],
    }),
  ).toBeUndefined()
})

test("subpixel negative elapsed-time noise is normalized but material negative time is rejected", () => {
  const tiny_edge_noise = [
    { x: -0.0001, y: 0 },
    { x: 0.01, y: 1 },
    { x: 0.02, y: 2 },
  ]
  const simulated = [
    { x: 0, y: 0 },
    { x: 0.01, y: 1 },
    { x: 0.02, y: 2 },
  ]
  expect(getReferenceTimeAxisError(tiny_edge_noise)).toBeUndefined()
  expect(
    getBenchmarkRangeCoverageError({
      reference_points: tiny_edge_noise,
      result_points: simulated,
    }),
  ).toBeUndefined()
  expect(
    scoreSeriesPoints({
      series: {
        id: "output",
        title: "Output",
        role: "response",
        unit: "V",
        tolerance: 0.01,
      },
      reference_points: tiny_edge_noise,
      result_points: simulated,
    }).passed,
  ).toBe(true)
  expect(
    getReferenceTimeAxisError([
      { x: -0.001, y: 0 },
      { x: 0.01, y: 1 },
      { x: 0.02, y: 2 },
    ]),
  ).toContain("exceeds the 1% trace-span edge tolerance")
})

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

  const transfer = await scoreSingleModelBenchmark({ model_dir, benchmark_id: "transfer" })
  const comparison_svg = await renderModelBenchmarkComparisonSvg({
    model_dir,
    benchmark_id: "transfer",
  })
  expect(transfer.passed).toBe(true)
  expect(comparison_svg).toContain("Transfer curve")
  expect(comparison_svg).toContain("Datasheet reference")
  expect(comparison_svg).toContain("Simulation result")
  expect(comparison_svg).toContain("PASS")

  await rm(model_dir, { recursive: true, force: true })
})

test("targeted benchmark helper extracts and overlays one saved simulator trace", async () => {
  const job_dir = await mkdtemp(join(tmpdir(), "datasheet-model-diagnostic-"))
  const model_dir = join(job_dir, "spice")
  const circuit_json_file = join(job_dir, "dist", "spice", "benchmarks", "transfer", "circuit.json")
  try {
    await Promise.all([
      mkdir(model_dir, { recursive: true }),
      mkdir(join(model_dir, "evidence"), { recursive: true }),
      mkdir(join(circuit_json_file, ".."), { recursive: true }),
      Bun.write(join(job_dir, "datasheet.pdf"), "%PDF-1.7\nfixture"),
    ])
    await writeModelScaffold({ job_dir, model_dir })
    expect(await Bun.file(join(model_dir, "sync-model-wrapper.ts")).exists()).toBe(true)
    expect(await Bun.file(join(model_dir, "prepare-vision-image.ts")).exists()).toBe(true)
    expect(await Bun.file(join(model_dir, "validate-setup-evidence.ts")).exists()).toBe(true)
    await Promise.all([
      Bun.write(
        join(model_dir, "benchmarks.json"),
        JSON.stringify({
          version: 1,
          locked_at: new Date().toISOString(),
          benchmarks: [
            {
              id: "transfer",
              title: "Transfer curve",
              source: { page: 4 },
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
          ],
        }),
      ),
      Bun.write(join(model_dir, "evidence", "transfer.csv"), "x,y\n0,0\n1,1\n2,2\n"),
      Bun.write(
        circuit_json_file,
        JSON.stringify([
          {
            type: "simulation_transient_voltage_graph",
            name: "RESULT",
            timestamps_ms: [0, 1, 2],
            voltage_levels: [0, 1, 2],
          },
        ]),
      ),
    ])

    const process = Bun.spawn(["bun", "score-benchmark.ts", "transfer"], {
      cwd: model_dir,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exit_code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()])
    expect(stderr).toBe("")
    expect(exit_code).toBe(0)
    expect(
      JSON.parse(await Bun.file(join(model_dir, "diagnostics", "transfer", "comparison.json")).text()).passed,
    ).toBe(true)
    const comparison_svg = await Bun.file(join(model_dir, "diagnostics", "transfer", "comparison.svg")).text()
    expect(comparison_svg).toContain("Datasheet reference")
    expect(await Bun.file(join(model_dir, "results", "champion", "transfer.csv")).exists()).toBe(false)
  } finally {
    await rm(job_dir, { recursive: true, force: true })
  }
})

test("benchmark manifests accept only complete time-domain waveform definitions", async () => {
  const base = {
    version: 1 as const,
    locked_at: new Date().toISOString(),
    benchmarks: [
      {
        id: "bend",
        title: "Transient waveform",
        source: { page: 2, image: "evidence/figures/bend.png" },
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
  const parsed = parseBenchmarkManifest(base)
  expect(parsed.benchmarks[0]?.simulation.x_axis).toBe("time_ms")
  expect(parsed.benchmarks[0]?.source.image).toBe("evidence/figures/bend.png")
  const invalid_image = structuredClone(base)
  invalid_image.benchmarks[0]!.source.image = "evidence/figures/another-graph.png"
  expect(() => parseBenchmarkManifest(invalid_image)).toThrow(
    "source.image must be evidence/figures/bend.png",
  )
  const invalid = structuredClone(base)
  invalid.benchmarks[0]!.simulation = {
    kind: "static_curve",
    x_axis: "input_voltage",
    probe_name: "RESULT",
    dut_spice_node: "OUT",
  } as (typeof invalid.benchmarks)[0]["simulation"]
  expect(() => parseBenchmarkManifest(invalid)).toThrow('transient_voltage simulation with x_axis "time_ms"')
})

test("multi-channel figures keep and score every response and stimulus series independently", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-model-multi-channel-scorer-"))
  const benchmark = {
    id: "startup-sequence",
    title: "Startup sequence",
    source: {
      page: 7,
      figure: "Figure 12",
      image: "evidence/figures/startup-sequence.png",
      channel_count: 3,
    },
    critical: true,
    weight: 1,
    tolerance: 0.05,
    x_scale: "linear",
    series: [
      {
        id: "vout",
        title: "Output voltage",
        role: "response",
        quantity: "voltage",
        unit: "V",
        weight: 2,
        source_image: "evidence/figures/startup-sequence/vout.png",
        reference_file: "evidence/curves/startup-sequence/vout.csv",
        result_file: "results/champion/startup-sequence/vout.csv",
        simulation: {
          kind: "transient_voltage",
          x_axis: "time_ms",
          probe_name: "RESULT_VOUT",
          dut_spice_node: "OUT",
        },
      },
      {
        id: "pg",
        title: "Power-good response",
        role: "response",
        quantity: "voltage",
        unit: "V",
        weight: 1,
        source_image: "evidence/figures/startup-sequence/pg.png",
        reference_file: "evidence/curves/startup-sequence/pg.csv",
        result_file: "results/champion/startup-sequence/pg.csv",
        simulation: {
          kind: "transient_voltage",
          x_axis: "time_ms",
          probe_name: "RESULT_PG",
          dut_spice_node: "PG",
        },
      },
      {
        id: "vin",
        title: "Input-voltage stimulus",
        role: "stimulus",
        quantity: "voltage",
        unit: "V",
        source_image: "evidence/figures/startup-sequence/vin.png",
        reference_file: "evidence/curves/startup-sequence/vin.csv",
        result_file: "results/champion/startup-sequence/vin.csv",
        simulation: {
          kind: "transient_voltage",
          x_axis: "time_ms",
          probe_name: "STIMULUS_VIN",
        },
      },
    ],
  }
  try {
    await Promise.all([
      mkdir(join(model_dir, "evidence", "curves", benchmark.id), { recursive: true }),
      mkdir(join(model_dir, "results", "champion", benchmark.id), { recursive: true }),
    ])
    await Bun.write(
      join(model_dir, "benchmarks.json"),
      JSON.stringify({ version: 2, locked_at: new Date().toISOString(), benchmarks: [benchmark] }),
    )
    await Promise.all([
      Bun.write(join(model_dir, benchmark.series[0]!.reference_file), "x,y\n0,0\n1,1\n2,2\n"),
      Bun.write(join(model_dir, benchmark.series[1]!.reference_file), "x,y\n0,0\n1,0\n2,5\n"),
      Bun.write(join(model_dir, benchmark.series[2]!.reference_file), "x,y\n0,0\n1,5\n2,5\n"),
      Bun.write(join(model_dir, benchmark.series[0]!.result_file), "x,y\n0,0\n1,1\n2,2\n"),
      Bun.write(join(model_dir, benchmark.series[1]!.result_file), "x,y\n0,0\n1,0\n2,5\n"),
      Bun.write(join(model_dir, benchmark.series[2]!.result_file), "x,y\n0,0\n1,0\n2,0\n"),
    ])

    const failed_stimulus = await scoreSingleModelBenchmark({
      model_dir,
      benchmark_id: benchmark.id,
    })
    expect(failed_stimulus.passed).toBe(false)
    expect(failed_stimulus.normalized_rmse).toBe(0)
    expect(failed_stimulus.series?.map((series) => [series.series_id, series.role, series.passed])).toEqual([
      ["vout", "response", true],
      ["pg", "response", true],
      ["vin", "stimulus", false],
    ])

    await Bun.write(join(model_dir, benchmark.series[2]!.result_file), "x,y\n0,0\n1,5\n2,5\n")
    const passed = await scoreSingleModelBenchmark({ model_dir, benchmark_id: benchmark.id })
    const comparison_svg = await renderModelBenchmarkComparisonSvg({
      model_dir,
      benchmark_id: benchmark.id,
    })
    expect(passed.passed).toBe(true)
    expect(passed.series).toHaveLength(3)
    expect(comparison_svg).toContain("Output voltage · response · V")
    expect(comparison_svg).toContain("Power-good response · response · V")
    expect(comparison_svg).toContain("Input-voltage stimulus · stimulus · V")

    const missing_channel = structuredClone({
      version: 2,
      locked_at: new Date().toISOString(),
      benchmarks: [benchmark],
    })
    missing_channel.benchmarks[0]!.series.pop()
    expect(() => parseBenchmarkManifest(missing_channel)).toThrow(
      "source.channel_count=3 but series[] contains 2 channels",
    )

    const missing_subplot = structuredClone({
      version: 2,
      locked_at: new Date().toISOString(),
      benchmarks: [benchmark],
    })
    ;(missing_subplot.benchmarks[0]!.source as { subplot_count?: number }).subplot_count = 4
    missing_subplot.benchmarks[0]!.series.forEach((series, index) => {
      ;(series as typeof series & { subplot_index?: number }).subplot_index = index + 1
    })
    expect(() => parseBenchmarkManifest(missing_subplot)).toThrow("omits source subplot 4")
  } finally {
    await rm(model_dir, { recursive: true, force: true })
  }
})

test("figure evidence rejects four colored traces when only two were inventoried", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-trace-color-coverage-"))
  const source_image = "evidence/figures/four-traces.png"
  const image = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAiElEQVR4nO3YMQ3AMBAEQYN4/igMIiDMJSmd4hsrxeqiXR0AT/fyuMMb9AO+JoBOAJ0Auh8BVlXQBNBrAKEJoBNAJ4BOAJ0Aug2oWUETQK8BhCaATgCdADoBdALoXrcQ/912MAH0GkBoAugE0AmgE0AngG4DrppBE0CvAYQmgE4AnQA6AXTxgAcaM7l35H1tqAAAAABJRU5ErkJggg==",
    ),
    (character) => character.charCodeAt(0),
  )
  try {
    await mkdir(join(model_dir, "evidence", "figures"), { recursive: true })
    await Bun.write(join(model_dir, source_image), image)
    const rejection = expect(
      validateFigureTraceColorCoverage({
        model_dir,
        benchmark_id: "four-traces",
        source_image,
        trace_colors: [
          { r: 220, g: 20, b: 20, tolerance: 20 },
          { r: 20, g: 180, b: 20, tolerance: 20 },
        ],
      }),
    ).rejects
    await rejection.toThrow("contains at least 4 distinct colored waveform traces but only 2")
    await rejection.toThrow("Visible hue buckets")
  } finally {
    await rm(model_dir, { recursive: true, force: true })
  }
})

test("figure evidence ignores localized colored UI decorations", async () => {
  const model_dir = await mkdtemp(join(tmpdir(), "datasheet-trace-color-ui-"))
  const source_image = "evidence/figures/two-traces-with-ui.png"
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300">
    <rect width="600" height="300" fill="white"/>
    <path d="M20 90 C150 20 320 170 580 80" fill="none" stroke="rgb(30,90,220)" stroke-width="4"/>
    <path d="M20 210 C190 280 360 120 580 220" fill="none" stroke="rgb(210,30,180)" stroke-width="4"/>
    <path d="M18 15 L48 30 L18 45 Z" fill="rgb(220,30,30)"/>
    <rect x="68" y="15" width="35" height="30" fill="rgb(235,140,20)"/>
  </svg>`
  try {
    await mkdir(join(model_dir, "evidence", "figures"), { recursive: true })
    await Bun.write(join(model_dir, source_image), await sharp(Buffer.from(svg)).png().toBuffer())
    await expect(
      validateFigureTraceColorCoverage({
        model_dir,
        benchmark_id: "two-traces-with-ui",
        source_image,
        trace_colors: [
          { r: 30, g: 90, b: 220, tolerance: 20 },
          { r: 210, g: 30, b: 180, tolerance: 20 },
        ],
      }),
    ).resolves.toBeUndefined()
  } finally {
    await rm(model_dir, { recursive: true, force: true })
  }
})
