import type { ModelProgress, ModelProgressPhase } from "@/shared/job-types"

const PROGRESS_PHASES = new Set<ModelProgressPhase>([
  "queued",
  "extracting_datasheet",
  "digitizing_graphs",
  "preparing_benchmarks",
  "waiting_for_component",
  "locking_benchmarks",
  "building_baseline",
  "simulating",
  "scoring",
  "refining",
  "finalizing",
  "validating",
  "complete",
  "timed_out",
  "failed",
  "cancelled",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function parseModelProgress(value: unknown): ModelProgress {
  if (!isRecord(value)) throw new Error("model-progress.json must be an object")
  if (typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence < 0) {
    throw new Error("model-progress.json has an invalid sequence")
  }
  if (typeof value.phase !== "string" || !PROGRESS_PHASES.has(value.phase as ModelProgressPhase)) {
    throw new Error("model-progress.json has an invalid phase")
  }
  if (typeof value.message !== "string" || !value.message.trim()) {
    throw new Error("model-progress.json has no message")
  }
  if (typeof value.updated_at !== "string" || !value.updated_at.trim()) {
    throw new Error("model-progress.json has no updated_at")
  }
  if (!Number.isFinite(Date.parse(value.updated_at))) {
    throw new Error("model-progress.json has an invalid updated_at")
  }

  const evidence = isRecord(value.evidence)
    ? {
        pages_reviewed: optionalCount(value.evidence.pages_reviewed),
        graphs_found: optionalCount(value.evidence.graphs_found),
        graphs_digitized: optionalCount(value.evidence.graphs_digitized),
        figures_found: optionalCount(value.evidence.figures_found),
        figures_digitized: optionalCount(value.evidence.figures_digitized),
        channels_found: optionalCount(value.evidence.channels_found),
        channels_digitized: optionalCount(value.evidence.channels_digitized),
        benchmark_drafts: optionalCount(value.evidence.benchmark_drafts),
      }
    : undefined
  const benchmark = isRecord(value.benchmark)
    ? {
        current: typeof value.benchmark.current === "string" ? value.benchmark.current : undefined,
        completed: optionalCount(value.benchmark.completed),
        total: optionalCount(value.benchmark.total),
        draft_total: optionalCount(value.benchmark.draft_total),
        locked_total: optionalCount(value.benchmark.locked_total),
        omitted: optionalCount(value.benchmark.omitted),
      }
    : undefined
  const champion = isRecord(value.champion)
    ? {
        revision: typeof value.champion.revision === "string" ? value.champion.revision : undefined,
        passing: optionalCount(value.champion.passing),
        total: optionalCount(value.champion.total),
        score: optionalNumber(value.champion.score),
        worst_normalized_error: optionalNumber(value.champion.worst_normalized_error),
      }
    : undefined

  return {
    sequence: value.sequence,
    phase: value.phase as ModelProgressPhase,
    message: value.message.trim(),
    updated_at: value.updated_at,
    iteration: optionalCount(value.iteration),
    evidence,
    benchmark,
    champion,
  }
}
