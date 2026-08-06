import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { BunProcessRunner } from "@/server/infrastructure/process"
import {
  applyReferenceGraphSourceEligibility,
  buildReferenceGraphSourceProof,
  parseReferenceGraphSourceProof,
} from "@/server/model-workflow/reference-graph-axis-proof"
import { divisionScaleCandidates } from "@/server/model-workflow/reference-graph-axis-proof/ocr-extraction"
import {
  recoverMissingTimeDivisionPrefix,
  uniqueDivisionScale,
} from "@/server/model-workflow/reference-graph-axis-proof/scope-divisions"
import type { ReferenceGraphObservation } from "@/server/model-workflow/reference-graph-observation"

const archived_run93_pdf = join(
  import.meta.dir,
  "..",
  ".runtime/jobs/ca181c1a-27ee-4013-beb9-683c7c985fc0/spice/datasheet.pdf",
)
const testWithArchivedRun93 = existsSync(archived_run93_pdf) ? test : test.skip

const canonical_run93_crop = {
  page: 25,
  render_dpi: 200 as const,
  x_px: 840,
  y_px: 190,
  width_px: 680,
  height_px: 500,
}

function requireSourceProofTools(): void {
  const missing = ["pdftoppm", "pdftotext", "tesseract"].filter((command) => !Bun.which(command))
  expect(
    missing,
    "The archived production replay is present, so its PDF/OCR proof runtimes are required",
  ).toEqual([])
}

async function run93Observation(): Promise<ReferenceGraphObservation> {
  const source_pdf_sha256 = createHash("sha256")
    .update(await readFile(archived_run93_pdf))
    .digest("hex")
  const trace_x_pixels = [47, 100.333333, 153.666667, 207.666667, 261, 314.666667, 367.666667, 421.333333]
  return {
    version: 1,
    source_pdf_sha256,
    reviewed_hints: [],
    graphs: [
      {
        graph_id: "figure_10_21",
        page: 25,
        locator: "Figure 10-21. Load Transient, PFM/PWM Boost Operation",
        x_axis: "time",
        time_axis_evidence: "100 us/div",
        response_quantity: "voltage",
        public_pin_observable: true,
        fixture_reproducible: true,
        reason: "Archived run93 source graph",
        crop: canonical_run93_crop,
        electrical_binding: {
          response: {
            type: "voltage",
            positive: "dut.VOUT",
            negative: "gnd",
            nominal_volts: 3.3,
          },
          stimulus: {
            type: "current_step",
            positive: "dut.VOUT",
            negative: "gnd",
            pulse: {
              low: 0.1,
              high: 1,
              delay: 0.0002,
              rise: 0.000001,
              fall: 0.000001,
              width: 0.0004,
              period: 0.001,
            },
          },
        },
        digitized_curve: {
          method: "manual_pixel_trace",
          x_quantity: "time",
          x_unit: "s",
          y_quantity: "voltage",
          y_unit: "V",
          x_range: { min: 0, max: 0.0007 },
          y_range: { min: 2.8, max: 3.6 },
          x_axis: {
            scale: "linear",
            first: { pixel: 47, value: 0 },
            second: { pixel: 100.333333, value: 0.0001 },
          },
          y_axis: {
            scale: "linear",
            first: { pixel: 86.666667, value: 3.4 },
            second: { pixel: 55.666667, value: 3.5 },
          },
          trace_color: { r: 0, g: 0, b: 255, tolerance: 40 },
          points: trace_x_pixels.map((pixel_x, index) => ({
            pixel_x,
            pixel_y: 118.333333,
            x: index * 0.0001,
            y: 3.3,
          })),
        },
      },
    ],
  }
}

async function run93Figure1025Observation(): Promise<ReferenceGraphObservation> {
  const observation = await run93Observation()
  const graph = observation.graphs[0]!
  const x_axis = {
    scale: "linear" as const,
    first: { pixel: 27, value: 0 },
    second: { pixel: 564, value: 0.001 },
  }
  const y_axis = {
    scale: "linear" as const,
    first: { pixel: 141.33, value: 3.2 },
    second: { pixel: 78.67, value: 3.4 },
  }
  const point_y = 106
  const pointYVolts =
    y_axis.first.value +
    ((point_y - y_axis.first.pixel) / (y_axis.second.pixel - y_axis.first.pixel)) *
      (y_axis.second.value - y_axis.first.value)
  const pointXPixels = [32, 105, 180, 255, 330, 405, 480, 560]
  graph.graph_id = "figure_10_25"
  graph.locator = "Figure 10-25. Load Transient, PWM Buck-Boost Operation"
  graph.crop = {
    page: 25,
    render_dpi: 200,
    x_px: 860,
    y_px: 1_410,
    width_px: 680,
    height_px: 615,
  }
  graph.digitized_curve = {
    method: "manual_pixel_trace",
    x_quantity: "time",
    x_unit: "s",
    y_quantity: "voltage",
    y_unit: "V",
    x_range: { min: 0, max: 0.001 },
    y_range: { min: 3.2, max: 3.4 },
    x_axis,
    y_axis,
    trace_color: { r: 100, g: 100, b: 255, tolerance: 120 },
    points: pointXPixels.map((pixel_x) => ({
      pixel_x,
      pixel_y: point_y,
      x:
        x_axis.first.value +
        ((pixel_x - x_axis.first.pixel) / (x_axis.second.pixel - x_axis.first.pixel)) *
          (x_axis.second.value - x_axis.first.value),
      y: pointYVolts,
    })),
  }
  return observation
}

async function prove(observation: ReferenceGraphObservation) {
  return buildReferenceGraphSourceProof({
    observation,
    datasheet_path: archived_run93_pdf,
    process_runner: new BunProcessRunner(),
    signal: new AbortController().signal,
  })
}

testWithArchivedRun93("builds a source-grounded scope receipt for archived run93 Figure 10-21", async () => {
  requireSourceProofTools()
  const proof = await prove(await run93Observation())
  const result = proof.results[0]

  if (!result || result.status !== "verified") throw new Error(JSON.stringify(result))
  expect(result.status).toBe("verified")
  expect(result.receipt.algorithm).toBe("canonical_pdf_tesseract_scope_divisions_v2")
  expect(result.receipt.canonical_crop).toEqual(canonical_run93_crop)
  expect(result.receipt.figure_identity.normalized_figure).toBe("figure10-21")
  expect(result.receipt.figure_identity.source_text).toMatch(/^Figure 10-21\.?$/)
  expect(result.receipt.figure_identity.crop_edge_gap_pdf_points).toBeCloseTo(14.6322, 3)
  expect(result.receipt.figure_identity.crop_edge_gap_pdf_points).toBeLessThanOrEqual(36)

  if (result.receipt.algorithm !== "canonical_pdf_tesseract_scope_divisions_v2") {
    throw new Error("Archived run93 unexpectedly used explicit-tick calibration")
  }
  expect(result.receipt.x_axis.division_scale.raw_text).toMatch(/100\s*u?s\/div/i)
  expect(result.receipt.x_axis.division_scale.value_per_division_si).toBeCloseTo(100e-6, 12)
  expect(result.receipt.y_axis.division_scale.raw_text).toMatch(/100\s*m[V¥]\/div/i)
  expect(result.receipt.y_axis.division_scale.value_per_division_si).toBeCloseTo(100e-3, 12)
  expect(result.receipt.y_axis.nominal_source_text).toMatch(/V O = 3\.3 V/)
  expect(result.receipt.y_axis.nominal_baseline_pixel).toBeCloseTo(118.333333, 5)
  expect(result.receipt.y_axis.nominal_source_bbox_pdf_points.y_min).toBeGreaterThanOrEqual(
    canonical_run93_crop.y_px * (72 / canonical_run93_crop.render_dpi),
  )

  const parsed = parseReferenceGraphSourceProof(JSON.parse(JSON.stringify(proof)), proof.source_pdf_sha256)
  expect(parsed).toEqual(proof)
  const tampered = structuredClone(proof)
  const tampered_result = tampered.results[0]
  if (!tampered_result || tampered_result.status !== "verified") throw new Error("missing receipt")
  tampered_result.receipt.canonical_crop.width_px += 1
  expect(() => parseReferenceGraphSourceProof(tampered, proof.source_pdf_sha256)).toThrow(
    /receipt_sha256 does not match its canonical receipt/,
  )
  const relabeled_axis = structuredClone(proof) as unknown as {
    results: Array<{ receipt: { x_axis: { quantity: string } } }>
  }
  relabeled_axis.results[0]!.receipt.x_axis.quantity = "frequency"
  expect(() => parseReferenceGraphSourceProof(relabeled_axis, proof.source_pdf_sha256)).toThrow(
    /x_axis must retain time in s/,
  )
})

testWithArchivedRun93(
  "discovers the source grid independently of a narrow adjacent-anchor claim",
  async () => {
    requireSourceProofTools()
    const observation = await run93Observation()
    const graph = observation.graphs[0]!
    if (!graph.digitized_curve) throw new Error("Archived run93 observation is missing its curve")
    graph.digitized_curve.y_range = { min: 3.3, max: 3.4 }
    graph.digitized_curve.y_axis = {
      scale: "linear",
      first: { pixel: 118.333333, value: 3.3 },
      second: { pixel: 86.666667, value: 3.4 },
    }

    const proof = await prove(observation)
    const result = proof.results[0]

    if (!result || result.status !== "verified") throw new Error(JSON.stringify(result))
    expect(result.receipt.algorithm).toBe("canonical_pdf_tesseract_scope_divisions_v2")
    if (result.receipt.algorithm !== "canonical_pdf_tesseract_scope_divisions_v2") {
      throw new Error("Archived run93 unexpectedly used explicit-tick calibration")
    }
    expect(result.receipt.y_axis.grid.line_pixels.length).toBeGreaterThanOrEqual(3)
    expect(result.receipt.y_axis.grid.first_anchor_line_pixel).toBeCloseTo(118.333333, 1)
    expect(result.receipt.y_axis.grid.second_anchor_line_pixel).toBeCloseTo(86.666667, 1)
  },
)

testWithArchivedRun93(
  "finds right-edge scope controls when the faint Horizontal heading is not recognized",
  async () => {
    requireSourceProofTools()
    const proof = await prove(await run93Figure1025Observation())
    const result = proof.results[0]

    if (!result || result.status !== "verified") throw new Error(JSON.stringify(result))
    expect(result.status).toBe("verified")
    expect(result.receipt.algorithm).toBe("canonical_pdf_tesseract_scope_divisions_v2")
    if (result.receipt.algorithm !== "canonical_pdf_tesseract_scope_divisions_v2") {
      throw new Error("Figure 10-25 unexpectedly used explicit-tick calibration")
    }
    expect(result.receipt.x_axis.division_scale.value_per_division_si).toBeCloseTo(100e-6, 12)
    expect(result.receipt.y_axis.division_scale.value_per_division_si).toBeCloseTo(100e-3, 12)
  },
)

testWithArchivedRun93(
  "finds plot-local scope controls when the canonical crop has extra right padding",
  async () => {
    requireSourceProofTools()
    const observation = await run93Figure1025Observation()
    const graph = observation.graphs[0]!
    if (!graph.digitized_curve) throw new Error("Archived run93 observation is missing its curve")
    const old_x = graph.crop.x_px
    graph.crop.x_px = 850
    graph.crop.width_px = 850
    const translated_x = old_x - graph.crop.x_px
    graph.digitized_curve.x_axis.first.pixel += translated_x
    graph.digitized_curve.x_axis.second.pixel += translated_x
    for (const point of graph.digitized_curve.points) point.pixel_x += translated_x
    const proof = await prove(observation)
    const result = proof.results[0]

    if (!result || result.status !== "verified") throw new Error(JSON.stringify(result))
    expect(result.receipt.algorithm).toBe("canonical_pdf_tesseract_scope_divisions_v2")
    if (result.receipt.algorithm !== "canonical_pdf_tesseract_scope_divisions_v2") {
      throw new Error("Figure 10-25 unexpectedly used explicit-tick calibration")
    }
    expect(result.receipt.y_axis.division_scale.value_per_division_si).toBeCloseTo(100e-3, 12)
  },
)

test("accepts unique low-confidence scope unit tokens after normalizing common V glyph artifacts", () => {
  const words = [
    {
      block: 1,
      paragraph: 1,
      line: 1,
      word: 1,
      confidence: 91,
      text: "100",
      bbox: { left: 0, top: 0, width: 30, height: 20 },
    },
    {
      block: 1,
      paragraph: 1,
      line: 1,
      word: 2,
      confidence: 18.5,
      text: "mV¥/div",
      bbox: { left: 35, top: 0, width: 60, height: 20 },
    },
  ]
  const candidates = divisionScaleCandidates(words)
  const scale = uniqueDivisionScale(candidates, "V")

  expect(scale?.raw_text).toBe("100 mV¥/div")
  expect(scale?.value_per_division_si).toBeCloseTo(0.1, 12)

  const backslash_words = structuredClone(words)
  backslash_words[1]!.text = "m\\V/div"
  const backslash_scale = uniqueDivisionScale(divisionScaleCandidates(backslash_words), "V")
  expect(backslash_scale?.raw_text).toBe("100 m\\V/div")
  expect(backslash_scale?.value_per_division_si).toBeCloseTo(0.1, 12)
})

test("recovers a missing time prefix only from an adjacent same-panel measurement", () => {
  const scale = uniqueDivisionScale(
    divisionScaleCandidates([
      {
        block: 1,
        paragraph: 1,
        line: 1,
        word: 1,
        confidence: 91,
        text: "100",
        bbox: { left: 144, top: 103, width: 60, height: 27 },
      },
      {
        block: 1,
        paragraph: 1,
        line: 1,
        word: 2,
        confidence: 26,
        text: "s/div",
        bbox: { left: 208, top: 103, width: 70, height: 27 },
      },
    ]),
    "s",
  )
  const measurement_words = [
    {
      block: 1,
      paragraph: 1,
      line: 2,
      word: 1,
      confidence: 83,
      text: "301",
      bbox: { left: 152, top: 134, width: 56, height: 25 },
    },
    {
      block: 1,
      paragraph: 1,
      line: 2,
      word: 2,
      confidence: 83,
      text: "us",
      bbox: { left: 212, top: 134, width: 39, height: 25 },
    },
  ]

  const recovered = recoverMissingTimeDivisionPrefix(scale, measurement_words)
  expect(recovered?.value_per_division_si).toBeCloseTo(100e-6, 12)
  expect(recovered?.normalization).toEqual({
    algorithm: "missing_time_prefix_from_adjacent_measurement_v1",
    corroborating_raw_text: "301 us",
    multiplier: 1e-6,
  })

  const measurement_above_scale = structuredClone(measurement_words)
  for (const word of measurement_above_scale) word.bbox.top = 60
  expect(recoverMissingTimeDivisionPrefix(scale, measurement_above_scale)).toEqual(scale)
})

testWithArchivedRun93(
  "rejects a same-page neighboring plot and a crop whose caption and nominal text are not source-local",
  async () => {
    requireSourceProofTools()
    const canonical = await run93Observation()

    const wrong_figure = structuredClone(canonical)
    wrong_figure.graphs[0]!.crop = {
      ...canonical_run93_crop,
      x_px: 150,
    }
    const wrong_figure_result = (await prove(wrong_figure)).results[0]
    expect(wrong_figure_result?.status).toBe("ineligible")
    if (!wrong_figure_result || wrong_figure_result.status !== "ineligible") {
      throw new Error(JSON.stringify(wrong_figure_result))
    }
    expect(wrong_figure_result.diagnostic.missing_proofs).toContain("adjacent_figure_identity")

    const distant_text = structuredClone(canonical)
    distant_text.graphs[0]!.crop = {
      ...canonical_run93_crop,
      height_px: 220,
    }
    const distant_text_result = (await prove(distant_text)).results[0]
    expect(distant_text_result?.status).toBe("ineligible")
    if (!distant_text_result || distant_text_result.status !== "ineligible") {
      throw new Error(JSON.stringify(distant_text_result))
    }
    expect(distant_text_result.diagnostic.missing_proofs).toContain("adjacent_figure_identity")
    expect(distant_text_result.diagnostic.missing_proofs).toContain("printed_output_nominal_voltage")
  },
)

testWithArchivedRun93(
  "rejects shifted anchors, scaled time claims, and millivolt-as-volt calibration",
  async () => {
    requireSourceProofTools()
    const canonical = await run93Observation()

    const shifted_anchor = structuredClone(canonical)
    shifted_anchor.graphs[0]!.digitized_curve!.x_axis.second.pixel += 10
    const shifted_result = (await prove(shifted_anchor)).results[0]
    expect(shifted_result?.status).toBe("ineligible")
    if (!shifted_result || shifted_result.status !== "ineligible") {
      throw new Error(JSON.stringify(shifted_result))
    }
    expect(shifted_result.diagnostic.missing_proofs).toContain("time_grid_and_anchor_alignment")

    const scaled_time = structuredClone(canonical)
    scaled_time.graphs[0]!.digitized_curve!.x_axis.second.value = 0.0002
    const scaled_time_result = (await prove(scaled_time)).results[0]
    expect(scaled_time_result?.status).toBe("ineligible")
    if (!scaled_time_result || scaled_time_result.status !== "ineligible") {
      throw new Error(JSON.stringify(scaled_time_result))
    }
    expect(scaled_time_result.diagnostic.missing_proofs).toContain("declared_time_scale_matches_source")

    const millivolt_as_volt = structuredClone(canonical)
    millivolt_as_volt.graphs[0]!.digitized_curve!.y_axis.second.value = 3.4001
    const millivolt_result = (await prove(millivolt_as_volt)).results[0]
    expect(millivolt_result?.status).toBe("ineligible")
    if (!millivolt_result || millivolt_result.status !== "ineligible") {
      throw new Error(JSON.stringify(millivolt_result))
    }
    expect(millivolt_result.diagnostic.missing_proofs).toContain("declared_voltage_scale_matches_source")
  },
  15_000,
)

testWithArchivedRun93(
  "server owns the absolute scope voltage calibration instead of trusting an observer offset",
  async () => {
    requireSourceProofTools()
    const observation = await run93Observation()
    const curve = observation.graphs[0]!.digitized_curve!
    curve.y_axis.first.value += 0.4
    curve.y_axis.second.value += 0.4
    curve.y_range.min += 0.4
    curve.y_range.max += 0.4
    curve.points = curve.points.map((point) => ({ ...point, y: point.y + 0.4 }))

    const proof = await prove(observation)
    const result = proof.results[0]
    if (!result || result.status !== "verified") throw new Error(JSON.stringify(result))
    expect(result.status).toBe("verified")
    expect(result.receipt.algorithm).toBe("canonical_pdf_tesseract_scope_divisions_v2")
    if (result.receipt.algorithm !== "canonical_pdf_tesseract_scope_divisions_v2") {
      throw new Error("Archived run93 unexpectedly used a non-scope calibration")
    }

    const canonical = applyReferenceGraphSourceEligibility({ observation, proof })
    const canonical_curve = canonical.graphs[0]!.digitized_curve!
    expect(observation.graphs[0]!.digitized_curve!.points[0]!.y).toBeCloseTo(3.7, 12)
    expect(canonical_curve.points[0]!.y).toBeCloseTo(3.3, 12)
    expect(canonical_curve.points.at(-1)!.y).toBeCloseTo(3.3, 12)
    expect(
      Math.abs(
        (canonical_curve.y_axis.second.value - canonical_curve.y_axis.first.value) /
          (canonical_curve.y_axis.second.pixel - canonical_curve.y_axis.first.pixel),
      ),
    ).toBeCloseTo(result.receipt.y_axis.source_volts_per_pixel, 12)
  },
  15_000,
)

testWithArchivedRun93("rejects an oversized crop containing a neighboring plot", async () => {
  requireSourceProofTools()
  const observation = await run93Observation()
  observation.graphs[0]!.crop = {
    ...canonical_run93_crop,
    x_px: 100,
    y_px: 150,
    width_px: 1_500,
    height_px: 650,
  }

  const result = (await prove(observation)).results[0]
  expect(result?.status).toBe("ineligible")
  if (!result || result.status !== "ineligible") throw new Error(JSON.stringify(result))
  expect(result.diagnostic.missing_proofs).toContain("oscilloscope_panels")
})

testWithArchivedRun93("demotes source-ineligible graphs and removes private executable claims", async () => {
  const observation = await run93Observation()
  const graph_id = observation.graphs[0]!.graph_id
  const demoted = applyReferenceGraphSourceEligibility({
    observation,
    proof: {
      version: 1,
      source_pdf_sha256: observation.source_pdf_sha256,
      results: [
        {
          status: "ineligible",
          graph_id,
          code: "axis_calibration_unproven",
          reason: "The exact crop has no source-grounded voltage scale.",
          diagnostic: {
            recognized_measurements: ["100 us/div"],
            missing_proofs: ["unique_printed_voltage_per_division"],
          },
        },
      ],
    },
  })

  expect(demoted.graphs[0]).toMatchObject({
    graph_id,
    fixture_reproducible: false,
    reason: expect.stringContaining("Axis calibration is source-ineligible"),
  })
  expect(demoted.graphs[0]!.electrical_binding).toBeUndefined()
  expect(demoted.graphs[0]!.digitized_curve).toBeUndefined()
})
