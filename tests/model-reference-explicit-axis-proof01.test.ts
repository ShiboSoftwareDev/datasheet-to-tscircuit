import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "bun:test"
import { BunProcessRunner } from "@/server/infrastructure/process"
import { buildReferenceGraphSourceProof } from "@/server/model-workflow/reference-graph-axis-proof"
import type { ReferenceGraphObservation } from "@/server/model-workflow/reference-graph-observation"

const temporary_directories: string[] = []

afterEach(async () => {
  await Promise.all(temporary_directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function explicitTickPdf(): Uint8Array {
  const commands = [
    "0.82 G",
    "0.35 w",
    ...Array.from({ length: 5 }, (_, index) => {
      const x = 72 + index * 36
      return `${x} 72 m ${x} 165.6 l S`
    }),
    ...Array.from({ length: 5 }, (_, index) => {
      const y = 72 + index * 23.4
      return `72 ${y} m 216 ${y} l S`
    }),
    "0 0 0 RG",
    "0.8 w",
    "72 72 m 216 72 l S",
    "72 72 m 72 165.6 l S",
    "0.078431 0.313725 0.705882 RG",
    "1.2 w",
    "72 72 m 86.4 74.5 l 100.8 79 l 115.2 91 l 129.6 112 l 144 142 l 158.4 156 l 172.8 160 l 187.2 163 l 201.6 164 l 216 165.6 l S",
    "0 0 0 rg",
    "BT /F1 10 Tf 54 45 Td (0.0 ms) Tj ET",
    "BT /F1 10 Tf 204 45 Td (1 ms) Tj ET",
    "BT /F1 10 Tf 21 68 Td (0.0 V) Tj ET",
    "BT /F1 10 Tf 27 161.6 Td (2 V) Tj ET",
    "BT /F1 10 Tf 121 15 Td (Figure 1.) Tj ET",
  ].join("\n")
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 288 216] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
  ]
  let pdf = "%PDF-1.4\n"
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref_offset = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")
  pdf += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref_offset}\n%%EOF\n`
  return Buffer.from(pdf, "ascii")
}

function observationForPdf(source_pdf_sha256: string): ReferenceGraphObservation {
  const points = Array.from({ length: 20 }, (_, index) => {
    const ratio = index / 19
    return {
      pixel_x: 200 + ratio * 400,
      pixel_y: 400 - ratio * 260,
      x: ratio * 0.001,
      y: ratio * 2,
    }
  })
  return {
    version: 1,
    source_pdf_sha256,
    reviewed_hints: [],
    graphs: [
      {
        graph_id: "explicit_tick_graph",
        page: 1,
        locator: "Figure 1. Explicit voltage transient",
        x_axis: "time",
        time_axis_evidence: "0 s to 1 ms",
        response_quantity: "voltage",
        public_pin_observable: true,
        fixture_reproducible: true,
        reason: "Generated production-tool explicit-axis fixture",
        crop: {
          page: 1,
          render_dpi: 200,
          x_px: 0,
          y_px: 0,
          width_px: 800,
          height_px: 600,
        },
        electrical_binding: {
          response: {
            type: "voltage",
            positive: "dut.OUT",
            negative: "gnd",
            nominal_volts: 2,
          },
          stimulus: {
            type: "voltage_step",
            positive: "dut.IN",
            negative: "gnd",
            pulse: {
              low: 0,
              high: 1,
              delay: 0,
              rise: 0.001,
              fall: 0.0001,
              width: 0.002,
              period: 0.004,
            },
          },
        },
        digitized_curve: {
          method: "manual_pixel_trace",
          x_quantity: "time",
          x_unit: "s",
          y_quantity: "voltage",
          y_unit: "V",
          x_range: { min: 0, max: 0.001 },
          y_range: { min: 0, max: 2 },
          x_axis: {
            scale: "linear",
            first: { pixel: 200, value: 0 },
            second: { pixel: 600, value: 0.001 },
          },
          y_axis: {
            scale: "linear",
            first: { pixel: 400, value: 0 },
            second: { pixel: 140, value: 2 },
          },
          trace_color: { r: 20, g: 80, b: 180, tolerance: 24 },
          points,
        },
      },
    ],
  }
}

test("proves generated explicit time/voltage ticks with real Poppler and Tesseract", async () => {
  const missing = ["pdftoppm", "pdftotext", "tesseract"].filter((command) => !Bun.which(command))
  expect(missing, "Reference-axis production tools are required in clean CI").toEqual([])

  const workspace = await mkdtemp(join(tmpdir(), "explicit-axis-proof-"))
  temporary_directories.push(workspace)
  await mkdir(workspace, { recursive: true })
  const datasheet_path = join(workspace, "datasheet.pdf")
  const pdf = explicitTickPdf()
  await Bun.write(datasheet_path, pdf)
  const source_pdf_sha256 = createHash("sha256").update(pdf).digest("hex")
  const proof = await buildReferenceGraphSourceProof({
    observation: observationForPdf(source_pdf_sha256),
    datasheet_path,
    process_runner: new BunProcessRunner(),
    signal: new AbortController().signal,
  })
  const result = proof.results[0]

  if (!result || result.status !== "verified") throw new Error(JSON.stringify(result))
  expect(result.status).toBe("verified")
  expect(result.receipt.algorithm).toBe("canonical_pdf_tesseract_explicit_ticks_v1")
  if (result.receipt.algorithm !== "canonical_pdf_tesseract_explicit_ticks_v1") {
    throw new Error("Generated explicit-tick fixture unexpectedly used scope calibration")
  }
  expect(result.receipt.figure_identity.normalized_figure).toBe("figure1")
  expect(result.receipt.x_axis.first.value_si).toBe(0)
  expect(result.receipt.x_axis.second.value_si).toBeCloseTo(0.001, 12)
  expect(result.receipt.y_axis.first.value_si).toBe(0)
  expect(result.receipt.y_axis.second.value_si).toBe(2)
})
