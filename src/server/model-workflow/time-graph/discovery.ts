import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createStageWorkspace, readBoundedTextArtifact } from "../../infrastructure/artifacts"
import type { ProcessRunner } from "../../infrastructure/process"
import { parseTimeGraphDiscovery } from "./artifact"
import {
  deriveTimeGraphLocalConditionReceipt,
  unsupported_condition_patterns,
  unsupportedFixtureConditions,
} from "./condition-receipt"
import { deriveTimeGraphPrintedExperiment, parsePrintedConditionFacts } from "./printed-experiment"
import {
  compactText,
  MAX_FIXTURE_EVIDENCE_CONTEXT_LENGTH,
  MAX_OPERATING_CONDITION_EVIDENCE_LENGTH,
} from "./shared"
import type { TimeGraphDiscovery, TimeGraphHint } from "./types"

export function normalizeFigureLabel(value: string): string | undefined {
  const match = value.match(/figure\s+\d+(?:\s*[-–—]\s*\d+)*/i)
  return match?.[0].toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, "")
}

const FIGURE_PATTERN = /figure\s+\d+(?:\s*[-–—]\s*\d+)*/gi
const TIME_AXIS_PATTERN =
  /\btime\s*[([]\s*(?:[-+]?(?:\d+(?:\.\d*)?|\.\d+)\s*)?(?:[fpnumµμ]?s|[fpnumµμ]?sec(?:ond)?s?|seconds?)\s*(?:\/\s*div(?:ision)?)?\s*[)\]]/gi
const TIME_GRAPH_TITLE_PATTERN =
  /\b(?:transient|waveforms?|response\s+time|startup|start-up|turn-on|turn-off|rise\s+time|fall\s+time)\b/i
const NON_GRAPH_TITLE_PATTERN = /\b(?:scheme|block\s+diagram|flow\s*chart|state\s+diagram)\b/i

interface ScoredTimeGraphCandidate {
  candidate: Omit<TimeGraphHint, "hint_id">
  score: number
}

/**
 * Pull only the text belonging to this figure on its physical pdftotext line.
 * TI tables put titles before `Figure N`; graph captions put them after it and
 * two-column pages can contain another figure on the same line.
 */
function lineCaptionParts(
  page_text: string,
  figure_start: number,
  figure_end: number,
): { before: string; after: string; has_caption_period: boolean } {
  const line_start = page_text.lastIndexOf("\n", figure_start - 1) + 1
  const next_newline = page_text.indexOf("\n", figure_end)
  const line_end = next_newline < 0 ? page_text.length : next_newline
  const line = page_text.slice(line_start, line_end)
  const figure_start_in_line = figure_start - line_start
  const figure_end_in_line = figure_end - line_start
  const previous_figure = [...line.slice(0, figure_start_in_line).matchAll(FIGURE_PATTERN)].at(-1)
  const next_figure = line.slice(figure_end_in_line).search(FIGURE_PATTERN)
  const before_start = previous_figure ? (previous_figure.index ?? 0) + previous_figure[0].length : 0
  const after_end = next_figure < 0 ? line.length : figure_end_in_line + next_figure
  return {
    before: compactText(line.slice(before_start, figure_start_in_line)),
    after: compactText(line.slice(figure_end_in_line, after_end).replace(/^\s*\.\s*/, "")),
    has_caption_period: /^\s*\./.test(line.slice(figure_end_in_line)),
  }
}

function normalizedEvidenceExcerpt(context: string, fallback: string): string {
  const normalized = context.replace(/\s+/g, " ").trim()
  const first_blocker = unsupported_condition_patterns
    .map(({ pattern }) => {
      pattern.lastIndex = 0
      return normalized.search(pattern)
    })
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0]
  const step_index = normalized.search(
    /\b(?:load\s+current|[iv][a-z0-9_]*)\s+(?:current\s+)?(?:steps?\s+)?from\s+[-+]?(?:\d+(?:\.\d*)?|\.\d+)/i,
  )
  const anchor = first_blocker ?? (step_index >= 0 ? step_index : undefined)
  if (anchor === undefined) {
    const caption = fallback.replace(/\s+/g, " ").trim()
    const combined = `${caption} ${normalized}`.trim()
    return combined.slice(0, MAX_OPERATING_CONDITION_EVIDENCE_LENGTH)
  }
  const start = Math.max(0, anchor - 700)
  return normalized.slice(start, start + MAX_OPERATING_CONDITION_EVIDENCE_LENGTH).trim()
}

function sourceContextsForFigure(input: {
  pages: string[]
  page_index: number
  normalized_figure: string
  figure_offset: number
}): { operating: string; fixture: string } {
  const operating_contexts: string[] = []
  const fixture_contexts: string[] = []
  for (const page_index of [input.page_index - 1, input.page_index]) {
    const page = input.pages[page_index]
    if (!page) continue
    for (const match of page.matchAll(/figure\s+\d+(?:\s*[-–—]\s*\d+)*/gi)) {
      if (normalizeFigureLabel(match[0]) !== input.normalized_figure) continue
      const offset = match.index ?? 0
      const before = page.slice(0, offset)
      const line_index = before.split("\n").length - 1
      const line_start = before.lastIndexOf("\n") + 1
      const column = offset - line_start
      const lines = page.split("\n")
      const page_width = Math.max(1, ...lines.map((line) => line.length))
      const figure_columns_on_line = [...(lines[line_index] ?? "").matchAll(FIGURE_PATTERN)]
        .map((figure_match) => figure_match.index ?? 0)
        .sort((left, right) => left - right)
      const page_has_two_figure_columns = lines.some((line) => [...line.matchAll(FIGURE_PATTERN)].length >= 2)
      const column_boundary = !page_has_two_figure_columns
        ? page_width
        : figure_columns_on_line.length >= 2
          ? Math.max(1, figure_columns_on_line[1]! - 5)
          : Math.floor(page_width * 0.44)
      const column_start = column >= column_boundary ? column_boundary : 0
      const column_end = column >= column_boundary ? page_width : column_boundary
      let section_start_row = 0
      for (let row = line_index - 1; row >= 0; row -= 1) {
        const previous_line = lines[row] ?? ""
        const has_figure_in_same_column = [...previous_line.matchAll(FIGURE_PATTERN)].some((figure_match) => {
          const figure_column = figure_match.index ?? 0
          return figure_column >= column_boundary === column >= column_boundary
        })
        if (!has_figure_in_same_column) continue
        section_start_row = row + 1
        break
      }
      const context_start_row = Math.max(section_start_row, line_index - 12)
      const column_context = lines
        .slice(context_start_row, Math.min(lines.length, line_index + 4))
        .map((line) => line.slice(column_start, column_end))
        .join("\n")
      const narrow_step_contexts: string[] = []
      for (let row = context_start_row; row <= line_index; row += 1) {
        const line = lines[row] ?? ""
        for (const step_match of line.matchAll(/\b(?:load\s+current|[iv][a-z0-9_]*)\s+from\b/gi)) {
          const step_column = step_match.index ?? 0
          if (step_column < column_start || step_column >= column_end) continue
          narrow_step_contexts.push(
            lines
              .slice(row, Math.min(lines.length, row + 5, line_index + 1))
              .map((candidate_line) => candidate_line.slice(step_column, step_column + 56))
              .join("\n"),
          )
        }
      }
      fixture_contexts.push(column_context)
      operating_contexts.push(
        page.slice(Math.max(0, offset - 700), offset + 1_400),
        column_context,
        ...narrow_step_contexts,
      )
    }
  }
  if (operating_contexts.length === 0) {
    const page = input.pages[input.page_index] ?? ""
    const fallback = page.slice(Math.max(0, input.figure_offset - 700), input.figure_offset + 1_400)
    operating_contexts.push(fallback)
    fixture_contexts.push(fallback)
  }
  return {
    operating: operating_contexts.join("\n"),
    fixture: fixture_contexts.join("\n"),
  }
}

function summaryFixtureEvidenceByFigure(datasheet_text: string): Map<string, string> {
  const summaries = new Map<string, string>()
  for (const page of datasheet_text.split("\f")) {
    if (!/table\s+\d+[^\n]*typical\s+characteristics\s+curves/i.test(page)) continue
    const figures = [...page.matchAll(FIGURE_PATTERN)]
    for (const [index, figure] of figures.entries()) {
      const normalized = normalizeFigureLabel(figure[0])
      if (!normalized) continue
      const figure_end = (figure.index ?? 0) + figure[0].length
      const previous_end =
        index === 0
          ? Math.max(0, page.search(/\bparameter\b/i))
          : (figures[index - 1]!.index ?? 0) + figures[index - 1]![0].length
      const after_figure = page.slice(figure_end)
      const first_line_end = after_figure.indexOf("\n")
      const second_line_end = first_line_end < 0 ? -1 : after_figure.indexOf("\n", first_line_end + 1)
      const context_end = second_line_end < 0 ? figure_end : figure_end + second_line_end
      const context = compactText(page.slice(previous_end, context_end)).slice(
        0,
        MAX_FIXTURE_EVIDENCE_CONTEXT_LENGTH,
      )
      if (
        parsePrintedConditionFacts(context).length > 0 ||
        deriveTimeGraphLocalConditionReceipt({ fixture_evidence_context: context }).conditions.length > 0
      ) {
        summaries.set(normalized, context)
      }
    }
  }
  return summaries
}

export function findLikelyTimeGraphCandidates(datasheet_text: string): Omit<TimeGraphHint, "hint_id">[] {
  const candidates = new Map<string, ScoredTimeGraphCandidate>()
  const pages = datasheet_text.split("\f")
  const summary_evidence_by_figure = summaryFixtureEvidenceByFigure(datasheet_text)
  if (pages.at(-1)?.trim() === "") pages.pop()
  for (const [page_index, page_text] of pages.entries()) {
    const time_markers = [...page_text.matchAll(TIME_AXIS_PATTERN)].map((match) => match.index ?? 0)
    for (const match of page_text.matchAll(FIGURE_PATTERN)) {
      const figure = match[0]?.replace(/\s+/g, " ").trim()
      const normalized = figure ? normalizeFigureLabel(figure) : undefined
      if (!figure || !normalized) continue
      const figure_offset = match.index ?? 0
      const caption = lineCaptionParts(page_text, figure_offset, figure_offset + match[0].length)
      const title_after_figure = TIME_GRAPH_TITLE_PATTERN.test(caption.after)
      const title_before_figure = TIME_GRAPH_TITLE_PATTERN.test(caption.before)
      const title_indicates_timing = title_after_figure || title_before_figure
      const title_text = title_after_figure ? caption.after : caption.before
      const title_is_non_graph = title_indicates_timing && NON_GRAPH_TITLE_PATTERN.test(title_text)
      const nearest_time_marker = time_markers.reduce(
        (distance, marker) => Math.min(distance, Math.abs(marker - figure_offset)),
        Number.POSITIVE_INFINITY,
      )
      const has_nearby_time_axis = nearest_time_marker <= 1_800
      if ((!title_indicates_timing || title_is_non_graph) && !has_nearby_time_axis) continue
      const source_contexts = sourceContextsForFigure({
        pages,
        page_index,
        normalized_figure: normalized,
        figure_offset,
      })
      const caption_reason = compactText(
        title_after_figure ? `${figure}. ${caption.after}` : `${caption.before} ${figure}`,
      )
      const operating_condition_evidence = normalizedEvidenceExcerpt(
        source_contexts.operating,
        caption_reason,
      )
      const fixture_evidence_context = compactText(source_contexts.fixture).slice(
        0,
        MAX_FIXTURE_EVIDENCE_CONTEXT_LENGTH,
      )
      const summary_fixture_evidence_context = summary_evidence_by_figure.get(normalized) ?? null
      const printed_experiment = deriveTimeGraphPrintedExperiment({
        fixture_evidence_context,
        summary_fixture_evidence_context,
      })
      const graph_local_conditions = deriveTimeGraphLocalConditionReceipt({
        fixture_evidence_context,
        summary_fixture_evidence_context,
      })
      const candidate: Omit<TimeGraphHint, "hint_id"> = {
        page: page_index + 1,
        figure,
        reason: title_indicates_timing && !title_is_non_graph ? caption_reason : "printed Time (unit) axis",
        operating_condition_evidence,
        fixture_evidence_context: fixture_evidence_context || caption_reason,
        summary_fixture_evidence_context,
        condition_conflicts: printed_experiment.condition_conflicts,
        graph_local_conditions,
        unsupported_fixture_conditions: unsupportedFixtureConditions(
          source_contexts.operating,
          graph_local_conditions,
        ),
        transient_fixture_evidence: printed_experiment.evidence,
      }
      const scored: ScoredTimeGraphCandidate = {
        candidate,
        score:
          (has_nearby_time_axis ? 100 : 0) +
          (caption.has_caption_period ? 30 : 0) +
          (title_after_figure && !title_is_non_graph ? 20 : 0) +
          (title_before_figure && !title_is_non_graph ? 10 : 0),
      }
      const current = candidates.get(normalized)
      if (!current || scored.score > current.score) candidates.set(normalized, scored)
    }
  }
  return [...candidates.values()]
    .map(({ candidate }) => candidate)
    .sort((left, right) => left.page - right.page || left.figure.localeCompare(right.figure))
}

export async function discoverTimeGraphHints(input: {
  datasheet_path: string
  process_runner: ProcessRunner
  signal: AbortSignal
  on_output?: (stream: "system" | "stdout" | "stderr", message: string) => void | Promise<void>
}): Promise<TimeGraphDiscovery> {
  const workspace = await createStageWorkspace({
    prefix: "model-time-graph-scan",
    files: [{ source: input.datasheet_path, destination: "datasheet.pdf" }],
  })
  try {
    const text_path = join(workspace.path, "datasheet.txt")
    await input.process_runner.run({
      command: ["pdftotext", "-layout", join(workspace.path, "datasheet.pdf"), text_path],
      command_label: "Scan complete datasheet for time-domain figures",
      cwd: workspace.path,
      signal: input.signal,
      wall_timeout_ms: 120_000,
      max_output_chars: 20_000,
      on_output: input.on_output,
    })
    const text = await readBoundedTextArtifact({ path: text_path, max_bytes: 32 * 1024 * 1024 })
    const pages = text.split("\f")
    if (pages.at(-1)?.trim() === "") pages.pop()
    const hints = findLikelyTimeGraphCandidates(text).map((hint, index) => ({
      hint_id: `time_graph_${String(index + 1).padStart(3, "0")}`,
      ...hint,
    }))
    const discovery: TimeGraphDiscovery = {
      version: 1,
      source_pdf_sha256: createHash("sha256")
        .update(await readFile(input.datasheet_path))
        .digest("hex"),
      page_count: pages.length,
      hints,
    }
    return parseTimeGraphDiscovery(discovery, discovery.source_pdf_sha256)
  } finally {
    await workspace.dispose().catch(() => undefined)
  }
}
