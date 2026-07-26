import { mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import {
  findDocumentedStimulusRange,
  getReferenceTimeAxisError,
  isEnableStimulusSeries,
  readCsvPoints,
  validateFigureTraceColorCoverage,
  validateTraceProvenance,
} from "../model-scorer"
import { clearVerifiedSimulationResults } from "../model-simulation-validator"
import { listCandidateModelFiles } from "./model-checkpoint"

export async function hasCompletedSetup(model_dir: string): Promise<boolean> {
  return Bun.file(join(model_dir, "setup-complete.json")).exists()
}

export async function getDraftBenchmarkCount(model_dir: string): Promise<number> {
  const value: unknown = JSON.parse(await readFile(join(model_dir, "benchmark-draft.json"), "utf8"))
  if (!isRecord(value) || !Array.isArray(value.benchmarks)) {
    throw new Error("benchmark-draft.json has no benchmark list")
  }
  return value.benchmarks.length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateDraftSeriesSemantics(benchmark_id: string, raw_series: Record<string, unknown>): void {
  const series_id =
    typeof raw_series.id === "string" && raw_series.id.trim() ? raw_series.id.trim() : "unknown"
  const label = `Benchmark draft ${benchmark_id} series ${series_id}`
  if (typeof raw_series.title !== "string" || !raw_series.title.trim()) {
    throw new Error(`${label} must declare the printed channel title`)
  }
  if (raw_series.role !== "response" && raw_series.role !== "stimulus") {
    throw new Error(`${label} role must be response or stimulus`)
  }
  if (typeof raw_series.quantity !== "string" || !raw_series.quantity.trim()) {
    throw new Error(`${label} must declare its physical quantity`)
  }
  if (typeof raw_series.unit !== "string" || !raw_series.unit.trim()) {
    throw new Error(`${label} must declare its printed unit`)
  }

  const quantity = raw_series.quantity.trim().toLowerCase()
  const normalized_unit = raw_series.unit.trim().replace("μ", "u").replace("µ", "u").toLowerCase()
  const uses_current_unit = ["a", "ma", "ua", "na"].includes(normalized_unit)
  const is_current = quantity === "current"
  if (uses_current_unit !== is_current) {
    throw new Error(`${label} quantity and unit must consistently identify current`)
  }
  if (/\bcurrent\b/i.test(raw_series.title) && !is_current) {
    throw new Error(
      `${label} is titled ${JSON.stringify(raw_series.title)} but is mislabeled as ${raw_series.quantity} ${raw_series.unit}; current channels must use quantity "current" and an ampere unit`,
    )
  }

  const expected_role = /\b(?:load|input|supply)\s+(?:voltage|current)\b|\benable\b/i.test(raw_series.title)
    ? "stimulus"
    : /\boutput\s+voltage\b|\bpower[\s-]*good\b|\binductor\s+current\b/i.test(raw_series.title)
      ? "response"
      : undefined
  if (expected_role && raw_series.role !== expected_role) {
    throw new Error(
      `${label} is titled ${JSON.stringify(raw_series.title)} and must be classified as a ${expected_role}`,
    )
  }
}

async function validateDraftResponseReferenceIndependence(
  model_dir: string,
  benchmarks: unknown[],
): Promise<void> {
  const seen = new Map<string, { label: string; critical: boolean; source_key: string }>()
  const blocking_duplicates: string[] = []
  for (const raw_benchmark of benchmarks) {
    if (
      !isRecord(raw_benchmark) ||
      typeof raw_benchmark.id !== "string" ||
      !Array.isArray(raw_benchmark.series)
    ) {
      continue
    }
    const benchmark_id = raw_benchmark.id.trim()
    const source = isRecord(raw_benchmark.source) ? raw_benchmark.source : {}
    const source_key = JSON.stringify({
      page: source.page,
      figure: source.figure,
      image: source.image,
    })
    for (const raw_series of raw_benchmark.series) {
      if (
        !isRecord(raw_series) ||
        raw_series.role !== "response" ||
        typeof raw_series.id !== "string" ||
        typeof raw_series.quantity !== "string" ||
        typeof raw_series.unit !== "string" ||
        typeof raw_series.reference_file !== "string"
      ) {
        continue
      }
      const series_id = raw_series.id.trim()
      const expected_reference_file = `evidence/curves/${benchmark_id}/${series_id}.csv`
      if (raw_series.reference_file !== expected_reference_file) continue
      const points = await readCsvPoints(join(model_dir, expected_reference_file))
      const signature = JSON.stringify({
        quantity: raw_series.quantity.trim().toLowerCase(),
        unit: raw_series.unit.trim().toLowerCase(),
        points,
      })
      const label = `${benchmark_id}/${series_id}`
      const critical = raw_benchmark.critical !== false
      const previous = seen.get(signature)
      if (
        previous &&
        !previous.label.startsWith(`${benchmark_id}/`) &&
        previous.source_key !== source_key &&
        (critical || previous.critical)
      ) {
        blocking_duplicates.push(
          `Evidence quality: response reference ${label} is an exact duplicate of ${previous.label} despite coming from a distinct datasheet figure; independently digitize each figure or mark the unsupported benchmark non-critical/evidence-only.`,
        )
      } else {
        seen.set(signature, { label, critical, source_key })
      }
    }
  }
  if (blocking_duplicates.length > 0) {
    throw new Error(
      `Critical benchmark reference evidence contains ${blocking_duplicates.length} copied response curve${
        blocking_duplicates.length === 1 ? "" : "s"
      }:\n${[...new Set(blocking_duplicates)].map((error) => `- ${error}`).join("\n")}`,
    )
  }
}

async function validateDraftReferenceTimeAxes(model_dir: string, benchmarks: unknown[]): Promise<void> {
  const validations = benchmarks.flatMap((raw_benchmark) => {
    if (
      !isRecord(raw_benchmark) ||
      typeof raw_benchmark.id !== "string" ||
      !Array.isArray(raw_benchmark.series)
    ) {
      return []
    }
    const benchmark_id = raw_benchmark.id.trim()
    return raw_benchmark.series.flatMap((raw_series) => {
      if (
        !isRecord(raw_series) ||
        typeof raw_series.id !== "string" ||
        typeof raw_series.reference_file !== "string"
      ) {
        return []
      }
      const series_id = raw_series.id.trim()
      const expected_reference_file = `evidence/curves/${benchmark_id}/${series_id}.csv`
      if (raw_series.reference_file !== expected_reference_file) return []
      return [
        (async () => {
          const points = await readCsvPoints(join(model_dir, expected_reference_file))
          const error = getReferenceTimeAxisError(points, `${benchmark_id}/${series_id} reference x`)
          if (error) throw new Error(error)
        })(),
      ]
    })
  })
  const results = await Promise.allSettled(validations)
  const errors = results.flatMap((result) =>
    result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
      : [],
  )
  if (errors.length > 0) {
    throw new Error(
      `Reference time validation found ${errors.length} error${errors.length === 1 ? "" : "s"}:\n${[
        ...new Set(errors),
      ]
        .map((error) => `- ${error}`)
        .join("\n")}`,
    )
  }
}

function quantile(values: number[], probability: number): number {
  const sorted = [...values].sort((first, second) => first - second)
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * probability)))
  return sorted[index]!
}

async function validateDraftStimulusRanges(model_dir: string, benchmarks: unknown[]): Promise<void> {
  const validations = benchmarks.flatMap((raw_benchmark) => {
    if (
      !isRecord(raw_benchmark) ||
      typeof raw_benchmark.id !== "string" ||
      typeof raw_benchmark.conditions !== "string" ||
      !Array.isArray(raw_benchmark.series)
    ) {
      return []
    }
    const benchmark_id = raw_benchmark.id.trim()
    const conditions = raw_benchmark.conditions
    return raw_benchmark.series.flatMap((raw_series) => {
      if (
        !isRecord(raw_series) ||
        raw_series.role !== "stimulus" ||
        typeof raw_series.id !== "string" ||
        typeof raw_series.title !== "string" ||
        typeof raw_series.unit !== "string" ||
        typeof raw_series.reference_file !== "string"
      ) {
        return []
      }
      const series_id = raw_series.id.trim()
      const expected_reference_file = `evidence/curves/${benchmark_id}/${series_id}.csv`
      if (raw_series.reference_file !== expected_reference_file) return []
      const documented = findDocumentedStimulusRange({
        conditions,
        title: raw_series.title,
        series_id,
        series_unit: raw_series.unit,
      })
      const enable_stimulus = isEnableStimulusSeries({
        title: raw_series.title,
        series_id,
      })
      if (!documented && !enable_stimulus) return []
      return [
        (async () => {
          const values = (await readCsvPoints(join(model_dir, expected_reference_file))).map(
            (point) => point.y,
          )
          const observed_low = quantile(values, 0.05)
          const observed_high = quantile(values, 0.95)
          if (documented) {
            const documented_span = documented.high - documented.low
            const tolerance = Math.max(
              documented_span * 0.125,
              Math.max(Math.abs(documented.low), Math.abs(documented.high)) * 0.02,
              1e-9,
            )
            if (
              Math.abs(observed_low - documented.low) > tolerance ||
              Math.abs(observed_high - documented.high) > tolerance
            ) {
              throw new Error(
                `${benchmark_id}/${series_id} stimulus reference has a robust range of ${observed_low.toPrecision(
                  5,
                )} to ${observed_high.toPrecision(5)} ${raw_series.unit}, but the printed condition ${JSON.stringify(
                  documented.label,
                )} requires ${documented.low.toPrecision(5)} to ${documented.high.toPrecision(
                  5,
                )} ${raw_series.unit}; recalibrate the channel's own scale and vertical offset and retrace its plotted centerline`,
              )
            }
          }
          if (enable_stimulus && !documented) {
            const observed_span = observed_high - observed_low
            const ground_tolerance = Math.max(observed_span * 0.1, Math.abs(observed_high) * 0.03, 1e-9)
            const endpoint_sample_count = Math.max(2, Math.min(5, Math.ceil(values.length * 0.1)))
            const starting_level = quantile(values.slice(0, endpoint_sample_count), 0.5)
            const ending_level = quantile(values.slice(-endpoint_sample_count), 0.5)
            const is_rising_edge = ending_level - starting_level >= observed_span * 0.25
            if (is_rising_edge && observed_high > ground_tolerance && observed_low < -ground_tolerance) {
              throw new Error(
                `${benchmark_id}/${series_id} rising-enable reference has a robust low level of ${observed_low.toPrecision(
                  5,
                )} ${raw_series.unit}; an enable edge must start at ground, so calibrate this channel from its own ground marker and volts-per-division instead of the crop's image coordinates`,
              )
            }
          }
        })(),
      ]
    })
  })
  const results = await Promise.allSettled(validations)
  const errors = results.flatMap((result) =>
    result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
      : [],
  )
  if (errors.length > 0) {
    throw new Error(
      `Stimulus evidence validation found ${errors.length} error${errors.length === 1 ? "" : "s"}:\n${[
        ...new Set(errors),
      ]
        .map((error) => `- ${error}`)
        .join("\n")}`,
    )
  }
}

function normalizedFigureLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const match = value.match(/figure\s+\d+(?:\s*[-–—]\s*\d+)+/i)
  return match?.[0].toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, "")
}

function findLikelyTimeGraphCandidates(datasheet_text: string): Array<{
  page: number
  figure: string
  reason: string
}> {
  const candidates = new Map<string, { page: number; figure: string; reason: string }>()
  for (const [page_index, page_text] of datasheet_text.split("\f").entries()) {
    const time_markers = [...page_text.matchAll(/\btime\s*\([^)]*\/\s*div[^)]*\)/gi)].map(
      (match) => match.index,
    )
    const figures = page_text.matchAll(/figure\s+\d+(?:\s*[-–—]\s*\d+)+/gi)
    for (const match of figures) {
      const figure = match[0]
      const normalized = normalizedFigureLabel(figure)
      if (!figure || !normalized) continue
      const caption = page_text.slice(match.index ?? 0, (match.index ?? 0) + 240).split(/\r?\n/)[0]!
      const title_indicates_timing =
        /\b(?:transient|waveform|response\s+time|startup|start-up|turn-on|turn-off|rise\s+time|fall\s+time)\b/i.test(
          caption,
        )
      const nearest_time_marker = time_markers.reduce(
        (distance, marker) => Math.min(distance, Math.abs(marker - (match.index ?? 0))),
        Number.POSITIVE_INFINITY,
      )
      if (!title_indicates_timing && nearest_time_marker > 1_800) continue
      const reason = title_indicates_timing
        ? caption.trim().replace(/\s+/g, " ")
        : "printed TIME (... / div) axis"
      candidates.set(normalized, {
        page: page_index + 1,
        figure: figure.replace(/\s+/g, " ").trim(),
        reason,
      })
    }
  }
  return [...candidates.values()]
}

async function validateCompleteDatasheetFigureInventory(input: {
  model_dir: string
  figure_inventory: unknown[]
  required: boolean
}): Promise<void> {
  const datasheet_text = await readFile(join(input.model_dir, "datasheet.txt"), "utf8").catch(() => undefined)
  if (datasheet_text === undefined) {
    if (input.required) {
      throw new Error(
        "Untimed setup must create datasheet.txt and search the complete document for time-domain figures",
      )
    }
    return
  }
  const inventoried = new Set(
    input.figure_inventory.flatMap((entry) => {
      if (!isRecord(entry)) return []
      const label = normalizedFigureLabel(entry.figure)
      return label ? [label] : []
    }),
  )
  const missing = findLikelyTimeGraphCandidates(datasheet_text).filter(
    ({ figure }) => !inventoried.has(normalizedFigureLabel(figure)!),
  )
  if (missing.length === 0) return
  throw new Error(
    `The complete datasheet scan found likely timing graphs missing from figure_inventory[]: ${missing
      .map(({ page, figure, reason }) => `PDF page ${page} ${figure} (${reason})`)
      .join(
        "; ",
      )}. Inspect these pages visually and classify every listed figure as time or static; do not limit discovery to typical-characteristics pages or truncated grep output.`,
  )
}

export async function validateCompletedSetup(
  model_dir: string,
  options: { require_trace_provenance?: boolean; require_complete_datasheet_scan?: boolean } = {},
): Promise<void> {
  const [setup, draft] = await Promise.all(
    ["setup-complete.json", "benchmark-draft.json"].map(async (file) => {
      const text = await readFile(join(model_dir, file), "utf8").catch(() => undefined)
      if (text === undefined) throw new Error(`Untimed setup did not create ${file}`)
      return JSON.parse(text) as unknown
    }),
  )
  if (!isRecord(setup) || setup.version !== 2) {
    throw new Error("setup-complete.json must use version 2 for complete time-graph inventory validation")
  }
  if (!isRecord(draft) || draft.version !== 2 || !Array.isArray(draft.benchmarks)) {
    throw new Error("benchmark-draft.json must use version 2 and contain benchmarks[]")
  }
  const omitted = draft.reviewed_time_graphs_not_drafted
  if (Array.isArray(omitted) && omitted.length > 0) {
    throw new Error("benchmark-draft.json explicitly omits reviewed time-domain graphs")
  }
  if (!Array.isArray(draft.figure_inventory) || draft.figure_inventory.length === 0) {
    throw new Error("benchmark-draft.json must inventory every reviewed graph in figure_inventory[]")
  }
  await validateCompleteDatasheetFigureInventory({
    model_dir,
    figure_inventory: draft.figure_inventory,
    required: Boolean(options.require_complete_datasheet_scan),
  })
  const draft_by_id = new Map<string, Record<string, unknown>>()
  const draft_ids = draft.benchmarks.map((benchmark, index) => {
    if (!isRecord(benchmark) || typeof benchmark.id !== "string" || !benchmark.id.trim()) {
      throw new Error(`benchmark-draft.json benchmark ${index + 1} has no stable id`)
    }
    const id = benchmark.id.trim()
    draft_by_id.set(id, benchmark)
    return id
  })
  if (new Set(draft_ids).size !== draft_ids.length) {
    throw new Error("benchmark-draft.json benchmark ids must be unique")
  }
  const inventoried_time_ids = draft.figure_inventory.flatMap((figure, index) => {
    if (!isRecord(figure) || (figure.x_axis !== "time" && figure.x_axis !== "static")) {
      throw new Error(`benchmark-draft.json figure_inventory item ${index + 1} must classify x_axis`)
    }
    if (figure.x_axis !== "time") return []
    if (figure.status !== "drafted" || typeof figure.benchmark_id !== "string") {
      throw new Error(
        `Every reviewed time-domain graph must be drafted; figure_inventory item ${index + 1} is omitted`,
      )
    }
    const benchmark_id = figure.benchmark_id.trim()
    if (options.require_trace_provenance) {
      const benchmark = draft_by_id.get(benchmark_id)
      const source = benchmark && isRecord(benchmark.source) ? benchmark.source : undefined
      const subplot_count = source?.subplot_count
      const channel_count = source?.channel_count
      if (
        !Number.isInteger(figure.subplot_count) ||
        figure.subplot_count !== subplot_count ||
        !Number.isInteger(figure.channel_count) ||
        figure.channel_count !== channel_count
      ) {
        throw new Error(
          `benchmark-draft.json figure_inventory item ${index + 1} must record subplot_count and channel_count matching benchmark ${benchmark_id}`,
        )
      }
    }
    return [benchmark_id]
  })
  if (
    new Set(inventoried_time_ids).size !== inventoried_time_ids.length ||
    JSON.stringify([...inventoried_time_ids].sort()) !== JSON.stringify([...draft_ids].sort())
  ) {
    throw new Error(
      "benchmark-draft.json figure_inventory time graphs and benchmarks[] must have the same unique benchmark ids",
    )
  }
  if (setup.draft_benchmark_count !== draft_ids.length) {
    throw new Error("setup-complete.json draft_benchmark_count does not match benchmark-draft.json")
  }
  const preliminary_validation_results = await Promise.allSettled([
    validateDraftReferenceTimeAxes(model_dir, draft.benchmarks),
    validateDraftStimulusRanges(model_dir, draft.benchmarks),
    validateDraftResponseReferenceIndependence(model_dir, draft.benchmarks),
  ])
  const preliminary_validation_errors = preliminary_validation_results.flatMap((result) =>
    result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
      : [],
  )
  if (options.require_trace_provenance) {
    const benchmark_results = await Promise.allSettled(
      draft_ids.map(async (benchmark_id) => {
        const benchmark = draft_by_id.get(benchmark_id)!
        const source = isRecord(benchmark.source) ? benchmark.source : undefined
        const expected_source_image = `evidence/figures/${benchmark_id}.png`
        if (
          !source ||
          source.image !== expected_source_image ||
          !Number.isInteger(source.channel_count) ||
          (source.channel_count as number) < 1 ||
          !Number.isInteger(source.subplot_count) ||
          (source.subplot_count as number) < 1
        ) {
          throw new Error(
            `Benchmark draft ${benchmark_id} must declare its exact source image plus positive channel_count and subplot_count`,
          )
        }
        if (!Array.isArray(benchmark.series) || benchmark.series.length !== source.channel_count) {
          throw new Error(
            `Benchmark draft ${benchmark_id} source.channel_count=${source.channel_count} but series[] contains ${
              Array.isArray(benchmark.series) ? benchmark.series.length : 0
            } channels`,
          )
        }
        const represented_subplots = new Set<number>()
        const trace_validations: Array<Promise<Awaited<ReturnType<typeof validateTraceProvenance>>>> = []
        for (const raw_series of benchmark.series) {
          if (!isRecord(raw_series) || typeof raw_series.id !== "string" || !raw_series.id.trim()) {
            throw new Error(`Benchmark draft ${benchmark_id} contains a series without a stable id`)
          }
          validateDraftSeriesSemantics(benchmark_id, raw_series)
          const series_id = raw_series.id.trim()
          const subplot_index = raw_series.subplot_index
          if (
            !Number.isInteger(subplot_index) ||
            (subplot_index as number) < 1 ||
            (subplot_index as number) > (source.subplot_count as number)
          ) {
            throw new Error(
              `Benchmark draft ${benchmark_id} series ${series_id} must identify one of ${source.subplot_count} source subplots`,
            )
          }
          represented_subplots.add(subplot_index as number)
          const source_image = `evidence/figures/${benchmark_id}/${series_id}.png`
          const reference_file = `evidence/curves/${benchmark_id}/${series_id}.csv`
          const trace_file = `evidence/traces/${benchmark_id}/${series_id}.json`
          if (
            raw_series.source_image !== source_image ||
            raw_series.reference_file !== reference_file ||
            raw_series.trace_file !== trace_file
          ) {
            throw new Error(
              `Benchmark draft ${benchmark_id} series ${series_id} must use its canonical source image, reference CSV, and trace provenance paths`,
            )
          }
          const x_scale = benchmark.x_scale === "log" ? "log" : "linear"
          const y_scale = raw_series.y_scale === "log" || benchmark.y_scale === "log" ? "log" : "linear"
          trace_validations.push(
            (async () =>
              validateTraceProvenance({
                model_dir,
                benchmark_id,
                series_id,
                source_image,
                trace_file,
                points: await readCsvPoints(join(model_dir, reference_file)),
                x_scale,
                y_scale,
                role: raw_series.role as "response" | "stimulus",
              }))(),
          )
        }
        const missing_subplots = Array.from(
          { length: source.subplot_count as number },
          (_, index) => index + 1,
        ).filter((subplot_index) => !represented_subplots.has(subplot_index))
        if (missing_subplots.length > 0) {
          throw new Error(
            `Benchmark draft ${benchmark_id} omits source subplot${missing_subplots.length === 1 ? "" : "s"} ${missing_subplots.join(", ")}`,
          )
        }
        const trace_results = await Promise.allSettled(trace_validations)
        const trace_errors = trace_results.flatMap((result) =>
          result.status === "rejected"
            ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
            : [],
        )
        if (trace_errors.length > 0) {
          throw new Error(trace_errors.join("; "))
        }
        const trace_colors = trace_results.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        )
        await validateFigureTraceColorCoverage({
          model_dir,
          benchmark_id,
          source_image: expected_source_image,
          trace_colors,
        })
      }),
    )
    const benchmark_errors = benchmark_results.flatMap((result, index) =>
      result.status === "rejected"
        ? [
            `${draft_ids[index]}: ${
              result.reason instanceof Error ? result.reason.message : String(result.reason)
            }`,
          ]
        : [],
    )
    if (preliminary_validation_errors.length > 0 || benchmark_errors.length > 0) {
      if (preliminary_validation_errors.length === 0) {
        throw new Error(
          `Evidence validation found ${benchmark_errors.length} benchmark error${
            benchmark_errors.length === 1 ? "" : "s"
          }:\n${benchmark_errors.map((error) => `- ${error}`).join("\n")}`,
        )
      }
      throw new Error(
        `Evidence validation found ${preliminary_validation_errors.length + benchmark_errors.length} error group${
          preliminary_validation_errors.length + benchmark_errors.length === 1 ? "" : "s"
        }:\n${[...preliminary_validation_errors, ...benchmark_errors]
          .map((error) => `- ${error.replaceAll("\n", "\n  ")}`)
          .join("\n")}`,
      )
    }
  } else if (preliminary_validation_errors.length > 0) {
    throw new Error(preliminary_validation_errors.join("\n"))
  }
}

export async function validateFinalizedBenchmarksMatchDraft(model_dir: string): Promise<void> {
  const [draft, manifest] = await Promise.all(
    ["benchmark-draft.json", "benchmarks.json"].map(async (file) => {
      const text = await readFile(join(model_dir, file), "utf8").catch(() => undefined)
      if (text === undefined) throw new Error(`Benchmark finalization did not create ${file}`)
      return JSON.parse(text) as unknown
    }),
  )
  if (!isRecord(draft) || !Array.isArray(draft.benchmarks)) {
    throw new Error("benchmark-draft.json has no benchmark list")
  }
  if (!isRecord(manifest) || !Array.isArray(manifest.benchmarks)) {
    throw new Error("benchmarks.json has no benchmark list")
  }
  const readIds = (entries: unknown[], file: string): string[] =>
    entries.map((entry, index) => {
      if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) {
        throw new Error(`${file} benchmark ${index + 1} has no stable id`)
      }
      return entry.id.trim()
    })
  const draft_ids = readIds(draft.benchmarks, "benchmark-draft.json").sort()
  const manifest_ids = readIds(manifest.benchmarks, "benchmarks.json").sort()
  if (JSON.stringify(draft_ids) !== JSON.stringify(manifest_ids)) {
    throw new Error(
      `Finalized benchmark ids must exactly match the complete time-graph draft; drafted [${draft_ids.join(
        ", ",
      )}], finalized [${manifest_ids.join(", ")}]`,
    )
  }

  const manifest_by_id = new Map(
    manifest.benchmarks.flatMap((entry) =>
      isRecord(entry) && typeof entry.id === "string" ? [[entry.id.trim(), entry] as const] : [],
    ),
  )
  const changed_fields: string[] = []
  const compareField = (
    label: string,
    draft_record: Record<string, unknown>,
    manifest_record: Record<string, unknown>,
    field: string,
  ): void => {
    if (
      draft_record[field] !== undefined &&
      JSON.stringify(draft_record[field]) !== JSON.stringify(manifest_record[field])
    ) {
      changed_fields.push(`${label}.${field}`)
    }
  }
  for (const raw_draft of draft.benchmarks) {
    if (!isRecord(raw_draft) || typeof raw_draft.id !== "string") continue
    const benchmark_id = raw_draft.id.trim()
    const finalized = manifest_by_id.get(benchmark_id)
    if (!finalized) continue
    for (const field of ["title", "conditions", "x_scale", "y_scale"]) {
      compareField(benchmark_id, raw_draft, finalized, field)
    }
    if (
      raw_draft.proposed_tolerance !== undefined &&
      JSON.stringify(raw_draft.proposed_tolerance) !== JSON.stringify(finalized.tolerance)
    ) {
      changed_fields.push(`${benchmark_id}.tolerance`)
    }
    const draft_source = isRecord(raw_draft.source) ? raw_draft.source : undefined
    const finalized_source = isRecord(finalized.source) ? finalized.source : undefined
    if (draft_source) {
      if (!finalized_source) {
        changed_fields.push(`${benchmark_id}.source`)
      } else {
        for (const field of ["page", "figure", "image", "channel_count", "subplot_count"]) {
          compareField(`${benchmark_id}.source`, draft_source, finalized_source, field)
        }
      }
    }
    if (!Array.isArray(raw_draft.series)) continue
    if (!Array.isArray(finalized.series) || finalized.series.length !== raw_draft.series.length) {
      changed_fields.push(`${benchmark_id}.series`)
      continue
    }
    const finalized_series_by_id = new Map(
      finalized.series.flatMap((entry) =>
        isRecord(entry) && typeof entry.id === "string" ? [[entry.id.trim(), entry] as const] : [],
      ),
    )
    for (const raw_series of raw_draft.series) {
      if (!isRecord(raw_series) || typeof raw_series.id !== "string") continue
      const series_id = raw_series.id.trim()
      const finalized_series = finalized_series_by_id.get(series_id)
      if (!finalized_series) {
        changed_fields.push(`${benchmark_id}.series.${series_id}`)
        continue
      }
      for (const field of [
        "title",
        "role",
        "subplot_index",
        "quantity",
        "unit",
        "source_image",
        "trace_file",
        "reference_file",
        "y_scale",
      ]) {
        compareField(`${benchmark_id}.series.${series_id}`, raw_series, finalized_series, field)
      }
    }
  }
  if (changed_fields.length > 0) {
    throw new Error(
      `Finalized benchmarks must preserve the immutable evidence draft; changed field${
        changed_fields.length === 1 ? "" : "s"
      }: ${changed_fields.slice(0, 20).join(", ")}${
        changed_fields.length > 20 ? `, and ${changed_fields.length - 20} more` : ""
      }`,
    )
  }
}

export async function findPrematureRefinementArtifacts(model_dir: string): Promise<string[]> {
  const canonical_files = [
    "benchmark-exclusions.json",
    "model.lib",
    "model-manifest.json",
    "component-with-model.circuit.tsx",
    "iteration-history.json",
    "model-card.md",
    "validation-report.json",
  ]
  const present = await Promise.all(
    canonical_files.map(async (file) =>
      (await Bun.file(join(model_dir, file)).exists()) ? file : undefined,
    ),
  )
  const candidate_files = await listCandidateModelFiles(join(model_dir, "candidates"))
  return [...present.filter((file): file is string => Boolean(file)), ...candidate_files]
}

export async function clearIncompleteBenchmarkFinalization(model_dir: string): Promise<void> {
  await Promise.all([
    rm(join(model_dir, "benchmarks.json"), { force: true }),
    rm(join(model_dir, "benchmark-exclusions.json"), { force: true }),
    rm(join(model_dir, "benchmarks"), { recursive: true, force: true }),
  ])
  await mkdir(join(model_dir, "benchmarks"), { recursive: true })
}

export async function clearRefinementArtifacts(model_dir: string): Promise<void> {
  await clearVerifiedSimulationResults(model_dir)
  await Promise.all([
    ...[
      "model.lib",
      "model-manifest.json",
      "component-with-model.circuit.tsx",
      "iteration-history.json",
      "model-card.md",
      "validation-report.json",
      "validation-feedback.md",
    ].map((file) => rm(join(model_dir, file), { force: true })),
    ...["candidates", "results/champion"].map((directory) =>
      rm(join(model_dir, directory), { recursive: true, force: true }),
    ),
  ])
  await mkdir(join(model_dir, "results", "champion"), { recursive: true })
}
