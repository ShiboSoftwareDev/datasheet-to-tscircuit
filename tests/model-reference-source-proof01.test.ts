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
            first: { pixel: 55.666667, value: 3.5 },
            second: { pixel: 86.666667, value: 3.4 },
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

  expect(result?.status).toBe("verified")
  if (!result || result.status !== "verified") throw new Error(JSON.stringify(result))
  expect(result.receipt.algorithm).toBe("canonical_pdf_tesseract_scope_divisions_v1")
  expect(result.receipt.canonical_crop).toEqual(canonical_run93_crop)
  expect(result.receipt.figure_identity.normalized_figure).toBe("figure10-21")
  expect(result.receipt.figure_identity.source_text).toMatch(/^Figure 10-21\.?$/)
  expect(result.receipt.figure_identity.crop_edge_gap_pdf_points).toBeCloseTo(14.6322, 3)
  expect(result.receipt.figure_identity.crop_edge_gap_pdf_points).toBeLessThanOrEqual(36)

  if (result.receipt.algorithm !== "canonical_pdf_tesseract_scope_divisions_v1") {
    throw new Error("Archived run93 unexpectedly used explicit-tick calibration")
  }
  expect(result.receipt.x_axis.division_scale.raw_text).toMatch(/100\s*u?s\/div/i)
  expect(result.receipt.x_axis.division_scale.value_per_division_si).toBeCloseTo(100e-6, 12)
  expect(result.receipt.y_axis.division_scale.raw_text).toMatch(/100\s*m[V¥]\/div/i)
  expect(result.receipt.y_axis.division_scale.value_per_division_si).toBeCloseTo(100e-3, 12)
  expect(result.receipt.y_axis.nominal_source_text).toMatch(/V O = 3\.3 V/)
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
    millivolt_as_volt.graphs[0]!.digitized_curve!.y_axis.second.value = 3.4999
    const millivolt_result = (await prove(millivolt_as_volt)).results[0]
    expect(millivolt_result?.status).toBe("ineligible")
    if (!millivolt_result || millivolt_result.status !== "ineligible") {
      throw new Error(JSON.stringify(millivolt_result))
    }
    expect(millivolt_result.diagnostic.missing_proofs).toContain("declared_voltage_scale_matches_source")
  },
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
