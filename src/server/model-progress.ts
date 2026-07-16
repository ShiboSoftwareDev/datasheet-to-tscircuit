import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ModelProgress, ModelProgressPhase } from "@/shared/job-types"
import type { ModelRunStore } from "./model-run-store"

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

export interface ModelProgressMonitor {
  sync: () => Promise<void>
  stop: () => void
}

export function startModelProgressMonitor(input: {
  model_run_id: string
  model_dir: string
  model_run_store: ModelRunStore
  interval_ms?: number
}): ModelProgressMonitor {
  let last_text: string | undefined
  let sync_in_flight: Promise<void> | undefined
  let is_stopped = false
  const sync = async () => {
    if (is_stopped) return
    if (sync_in_flight) return sync_in_flight
    sync_in_flight = (async () => {
      try {
        const text = await readFile(join(input.model_dir, "model-progress.json"), "utf8").catch(
          () => undefined,
        )
        if (!text || text === last_text) return
        const parsed_progress = parseModelProgress(JSON.parse(text) as unknown)
        const current_sequence =
          input.model_run_store.getModelRun(input.model_run_id)?.progress?.sequence ?? -1
        const sequenced_progress =
          parsed_progress.sequence <= current_sequence
            ? { ...parsed_progress, sequence: current_sequence + 1 }
            : parsed_progress
        const current_progress = input.model_run_store.getModelRun(input.model_run_id)?.progress
        const terminal_agent_phase = new Set<ModelProgressPhase>([
          "complete",
          "timed_out",
          "failed",
          "cancelled",
        ]).has(sequenced_progress.phase)
        const current_phase = current_progress?.phase
        const safe_phase =
          terminal_agent_phase &&
          current_phase &&
          !new Set<ModelProgressPhase>(["complete", "timed_out", "failed", "cancelled"]).has(current_phase)
            ? current_phase
            : sequenced_progress.phase
        const locked_total = current_progress?.benchmark?.locked_total
        const progress: ModelProgress = {
          ...sequenced_progress,
          phase: safe_phase,
          // Agent clocks can drift or write a future timestamp. The server receipt
          // time is authoritative for UI freshness and history ordering.
          updated_at: new Date().toISOString(),
          benchmark: {
            ...sequenced_progress.benchmark,
            ...(locked_total === undefined
              ? {}
              : {
                  total: locked_total,
                  completed:
                    sequenced_progress.benchmark?.completed === undefined
                      ? undefined
                      : Math.min(sequenced_progress.benchmark.completed, locked_total),
                  locked_total,
                  draft_total: current_progress?.benchmark?.draft_total,
                  omitted: current_progress?.benchmark?.omitted,
                }),
          },
        }
        last_text = text
        input.model_run_store.updateProgress(input.model_run_id, progress)
      } catch {
        // The agent may be replacing the file while it is polled. A later poll retries it.
      }
    })()
    try {
      await sync_in_flight
    } finally {
      sync_in_flight = undefined
    }
  }
  const timer = setInterval(() => void sync(), input.interval_ms ?? 500)
  return {
    sync,
    stop: () => {
      is_stopped = true
      clearInterval(timer)
    },
  }
}
