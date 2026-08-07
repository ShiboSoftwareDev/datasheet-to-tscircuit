import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ProcessRunner } from "../../infrastructure/process"
import type { ModelReferenceCropRegion, ModelReferenceElectricalBinding } from "../../modeling/types"
import type { ObservedReferenceGraph } from "../reference-graph-observation"
import { normalizeFigureLabel } from "../time-graph-hints"
import { sha256, SOURCE_LOCAL_TEXT_GAP_PDF_POINTS, valuesAgree } from "./shared"
import type { ReferenceGraphFigureIdentityReceipt } from "./types"

interface PdfTextWord {
  text: string
  bbox: { x_min: number; y_min: number; x_max: number; y_max: number }
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function pdfTextWords(bbox_html: string): PdfTextWord[] {
  return [
    ...bbox_html.matchAll(
      /<word\s+xMin="([^"]+)"\s+yMin="([^"]+)"\s+xMax="([^"]+)"\s+yMax="([^"]+)">([\s\S]*?)<\/word>/g,
    ),
  ].flatMap((match) => {
    const coordinates = match.slice(1, 5).map(Number)
    const text = decodeXmlText(match[5]!.replace(/<[^>]+>/g, "")).trim()
    if (!text || coordinates.some((coordinate) => !Number.isFinite(coordinate))) return []
    return [
      {
        text,
        bbox: {
          x_min: coordinates[0]!,
          y_min: coordinates[1]!,
          x_max: coordinates[2]!,
          y_max: coordinates[3]!,
        },
      },
    ]
  })
}

function joinedPdfBoundingBox(words: readonly PdfTextWord[]) {
  return {
    x_min: Math.min(...words.map(({ bbox }) => bbox.x_min)),
    y_min: Math.min(...words.map(({ bbox }) => bbox.y_min)),
    x_max: Math.max(...words.map(({ bbox }) => bbox.x_max)),
    y_max: Math.max(...words.map(({ bbox }) => bbox.y_max)),
  }
}

function cropInPdfPoints(crop: ModelReferenceCropRegion) {
  const scale = 72 / crop.render_dpi
  return {
    x_min: crop.x_px * scale,
    y_min: crop.y_px * scale,
    x_max: (crop.x_px + crop.width_px) * scale,
    y_max: (crop.y_px + crop.height_px) * scale,
  }
}

function boxGap(
  crop: ReturnType<typeof cropInPdfPoints>,
  box: PdfTextWord["bbox"],
): { vertical: number; horizontal_overlap: number } {
  const vertical =
    box.y_min > crop.y_max ? box.y_min - crop.y_max : box.y_max < crop.y_min ? crop.y_min - box.y_max : 0
  const horizontal_overlap = Math.max(0, Math.min(crop.x_max, box.x_max) - Math.max(crop.x_min, box.x_min))
  return { vertical, horizontal_overlap }
}

export function figureIdentityFromPdfText(input: {
  graph: ObservedReferenceGraph
  bbox_html: string
}): ReferenceGraphFigureIdentityReceipt | undefined {
  const normalized_figure = normalizeFigureLabel(input.graph.locator)
  if (!normalized_figure) return undefined
  const words = pdfTextWords(input.bbox_html)
  const crop = cropInPdfPoints(input.graph.crop)
  const candidates: Array<{
    words: PdfTextWord[]
    bbox: PdfTextWord["bbox"]
    vertical: number
  }> = []
  for (let index = 0; index < words.length; index += 1) {
    const window = words.slice(index, index + 2)
    if (window.length !== 2) continue
    if (normalizeFigureLabel(window.map(({ text }) => text).join(" ")) !== normalized_figure) continue
    const bbox = joinedPdfBoundingBox(window)
    const gap = boxGap(crop, bbox)
    if (gap.vertical > SOURCE_LOCAL_TEXT_GAP_PDF_POINTS || gap.horizontal_overlap < 8) continue
    candidates.push({ words: window, bbox, vertical: gap.vertical })
  }
  candidates.sort((left, right) => left.vertical - right.vertical)
  const nearest = candidates[0]
  if (!nearest || (candidates[1] && Math.abs(candidates[1].vertical - nearest.vertical) < 0.01)) {
    return undefined
  }
  return {
    algorithm: "pdftotext_bbox_adjacent_figure_v1",
    normalized_figure,
    source_text: nearest.words.map(({ text }) => text).join(" "),
    bbox_pdf_points: nearest.bbox,
    crop_edge_gap_pdf_points: nearest.vertical,
    bbox_output_sha256: sha256(input.bbox_html),
  }
}

export function nominalVoltageFromPdfText(input: {
  graph: ObservedReferenceGraph & { electrical_binding: ModelReferenceElectricalBinding }
  bbox_html: string
}):
  | {
      value: number
      source_text: string
      bbox: PdfTextWord["bbox"]
    }
  | undefined {
  const nominal = input.graph.electrical_binding.response.nominal_volts
  if (nominal === undefined) return undefined
  const words = pdfTextWords(input.bbox_html)
  const crop = cropInPdfPoints(input.graph.crop)
  const candidates: Array<{
    value: number
    source_text: string
    bbox: PdfTextWord["bbox"]
    gap: number
  }> = []
  for (let index = 0; index + 3 < words.length; index += 1) {
    const head = words.slice(index, index + 4)
    if (!/^v$/i.test(head[0]!.text) || !/^o(?:ut)?$/i.test(head[1]!.text) || head[2]!.text !== "=") {
      continue
    }
    const value = Number(head[3]!.text.replace(/,$/, ""))
    if (!Number.isFinite(value) || !valuesAgree(value, nominal)) continue
    const unit = words.slice(index + 4, index + 12).find((word) => /^v,?$/i.test(word.text))
    if (!unit || unit.bbox.y_min - head[3]!.bbox.y_max > 18) continue
    const bbox = joinedPdfBoundingBox([...head, unit])
    const gap = boxGap(crop, bbox)
    if (gap.vertical > SOURCE_LOCAL_TEXT_GAP_PDF_POINTS || gap.horizontal_overlap < 8) continue
    candidates.push({
      value,
      source_text: [...head, unit].map(({ text }) => text).join(" "),
      bbox,
      gap: gap.vertical,
    })
  }
  candidates.sort((left, right) => left.gap - right.gap)
  return candidates[0]
}

export async function extractPdfTextBBox(input: {
  graph: ObservedReferenceGraph
  workspace: string
  process_runner: ProcessRunner
  signal: AbortSignal
}): Promise<string> {
  const output_path = join(input.workspace, `${input.graph.graph_id}-bbox.html`)
  await input.process_runner.run({
    command: [
      "pdftotext",
      "-bbox-layout",
      "-f",
      String(input.graph.page),
      "-l",
      String(input.graph.page),
      join(input.workspace, "datasheet.pdf"),
      output_path,
    ],
    command_label: `Extract canonical figure geometry ${input.graph.graph_id}`,
    cwd: input.workspace,
    signal: input.signal,
    wall_timeout_ms: 120_000,
    max_output_chars: 20_000,
  })
  return readFile(output_path, "utf8")
}
