import { createHash } from "node:crypto"
import type { ModelTrainingValidationReport } from "./model-training-validation"

export const DEFAULT_MODEL_CANDIDATE_SEARCH_LIMITS = {
  max_checks: 10,
  max_topologies: 3,
  max_fit_calls: 3,
  max_fit_calls_per_topology: 2,
  max_fit_evaluations: 96,
  max_fit_evaluations_per_call: 48,
} as const

export interface ModelTrainingCandidateQuality {
  readonly passed: boolean
  readonly execution_error_count: number
  readonly missing_series_count: number
  readonly failed_case_count: number
  readonly failed_series_count: number
  readonly worst_normalized_max_error: number
  readonly mean_normalized_rmse: number
}

const TOLERANCE_ERROR_CODES = new Set([
  "bounds_exceeded",
  "curve_tolerance_exceeded",
  "target_tolerance_exceeded",
])

function finite(values: readonly (number | undefined)[]): number[] {
  return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
}

/**
 * Ranks only the public direct/viewer development result. Acceptance remains an
 * independent server concern; this rank exists to keep a good runnable seed
 * from being replaced by a worse edit during one bounded agent session.
 */
export function createModelTrainingCandidateQuality(
  report: ModelTrainingValidationReport,
): ModelTrainingCandidateQuality {
  const series = report.cases.flatMap(({ server_series, viewer_series }) => [
    ...server_series,
    ...viewer_series,
  ])
  const normalized_max_errors = finite(series.map(({ metrics }) => metrics.normalized_max_error))
  const normalized_rmse = finite(series.map(({ metrics }) => metrics.normalized_rmse))
  const execution_error_count = [
    ...report.error_codes,
    ...report.cases.flatMap(({ error_codes }) => error_codes),
    ...series.flatMap(({ error_codes }) => error_codes),
  ].filter((code) => !TOLERANCE_ERROR_CODES.has(code)).length
  const missing_series_count = report.cases.reduce(
    (count, validation_case) =>
      count +
      Number(validation_case.server_series.length === 0) +
      Number(validation_case.viewer_series.length === 0),
    0,
  )
  return {
    passed: report.status === "passed",
    execution_error_count,
    missing_series_count,
    failed_case_count: report.cases.filter(({ status }) => status !== "passed").length,
    failed_series_count: series.filter(({ status }) => status !== "passed").length,
    worst_normalized_max_error:
      normalized_max_errors.length > 0 ? Math.max(...normalized_max_errors) : Infinity,
    mean_normalized_rmse:
      normalized_rmse.length > 0
        ? normalized_rmse.reduce((sum, value) => sum + value, 0) / normalized_rmse.length
        : Infinity,
  }
}

const QUALITY_FIELDS: readonly (keyof ModelTrainingCandidateQuality)[] = [
  "passed",
  "execution_error_count",
  "missing_series_count",
  "failed_case_count",
  "failed_series_count",
  "worst_normalized_max_error",
  "mean_normalized_rmse",
]

/** Negative means left is the better public-training development candidate. */
export function compareModelTrainingCandidateQuality(
  left: ModelTrainingCandidateQuality,
  right: ModelTrainingCandidateQuality,
): number {
  for (const field of QUALITY_FIELDS) {
    const left_value = field === "passed" ? (left.passed ? 0 : 1) : left[field]
    const right_value = field === "passed" ? (right.passed ? 0 : 1) : right[field]
    if (left_value < right_value) return -1
    if (left_value > right_value) return 1
  }
  return 0
}

const PARAMETER_LITERAL =
  /^(\s*\.param\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*)[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/i

/** Numeric .param calibration does not create a new topology. */
export function modelCandidateTopologyFingerprint(source: string): string {
  const normalized = source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.split("$", 1)[0]!.trim())
    .filter((line) => line && !line.startsWith("*"))
    .map((line) => line.replace(PARAMETER_LITERAL, "$1<value>").replace(/\s+/g, " ").toLowerCase())
    .join("\n")
  return createHash("sha256").update(normalized).digest("hex")
}

export interface ModelCandidateSearchSnapshot {
  readonly source: string
  readonly card: string
  readonly quality: ModelTrainingCandidateQuality
  readonly topology_fingerprint: string
  readonly candidate_receipt: string
  readonly training_receipt: string
}

export interface ModelCandidateSearchBudgetDecision {
  readonly allowed: boolean
  readonly diagnostic?: string
  readonly topology_fingerprint: string
  readonly remaining_checks: number
  readonly remaining_fit_calls: number
  readonly remaining_fit_evaluations: number
  readonly granted_fit_evaluations?: number
}

type SearchLimits = typeof DEFAULT_MODEL_CANDIDATE_SEARCH_LIMITS

export class ModelCandidateSearchSession {
  readonly #limits: SearchLimits
  readonly #topologies = new Set<string>()
  readonly #fit_calls_by_topology = new Map<string, number>()
  #checks = 0
  #fit_calls = 0
  #fit_evaluations = 0
  #best: ModelCandidateSearchSnapshot | undefined

  constructor(limits: SearchLimits = DEFAULT_MODEL_CANDIDATE_SEARCH_LIMITS) {
    this.#limits = limits
  }

  get best(): ModelCandidateSearchSnapshot | undefined {
    return this.#best
  }

  get summary() {
    return {
      checks: this.#checks,
      fit_calls: this.#fit_calls,
      fit_evaluations: this.#fit_evaluations,
      topology_count: this.#topologies.size,
      remaining_checks: Math.max(0, this.#limits.max_checks - this.#checks),
      remaining_fit_calls: Math.max(0, this.#limits.max_fit_calls - this.#fit_calls),
      remaining_fit_evaluations: Math.max(0, this.#limits.max_fit_evaluations - this.#fit_evaluations),
    }
  }

  seed(snapshot: ModelCandidateSearchSnapshot): void {
    if (this.#best) return
    this.#best = snapshot
    this.#topologies.add(snapshot.topology_fingerprint)
  }

  #decision(input: {
    source: string
    kind: "check" | "fit"
    requested_fit_evaluations?: number
  }): ModelCandidateSearchBudgetDecision {
    const topology_fingerprint = modelCandidateTopologyFingerprint(input.source)
    const is_new_topology = !this.#topologies.has(topology_fingerprint)
    const summary = this.summary
    const denied = (diagnostic: string): ModelCandidateSearchBudgetDecision => ({
      allowed: false,
      diagnostic,
      topology_fingerprint,
      remaining_checks: summary.remaining_checks,
      remaining_fit_calls: summary.remaining_fit_calls,
      remaining_fit_evaluations: summary.remaining_fit_evaluations,
    })
    if (is_new_topology && this.#topologies.size >= this.#limits.max_topologies) {
      return denied(
        `The bounded search already evaluated ${this.#limits.max_topologies} distinct topologies. ` +
          "The best runnable candidate was retained; stop changing topology and finish honestly.",
      )
    }
    if (input.kind === "check") {
      if (this.#checks >= this.#limits.max_checks) {
        return denied(
          `The bounded search already used ${this.#limits.max_checks} full candidate checks. ` +
            "The best runnable candidate was retained; stop manual guessing and finish honestly.",
        )
      }
      this.#checks += 1
      this.#topologies.add(topology_fingerprint)
      const next = this.summary
      return {
        allowed: true,
        topology_fingerprint,
        remaining_checks: next.remaining_checks,
        remaining_fit_calls: next.remaining_fit_calls,
        remaining_fit_evaluations: next.remaining_fit_evaluations,
      }
    }

    const topology_fit_calls = this.#fit_calls_by_topology.get(topology_fingerprint) ?? 0
    if (this.#fit_calls >= this.#limits.max_fit_calls) {
      return denied(
        `The bounded search already used ${this.#limits.max_fit_calls} fitter calls. ` +
          "Use the retained result instead of widening the same search repeatedly.",
      )
    }
    if (topology_fit_calls >= this.#limits.max_fit_calls_per_topology) {
      return denied(
        `This topology already used ${this.#limits.max_fit_calls_per_topology} fitter calls. ` +
          "Its residual shape now requires an evidence-driven topology decision, not more bound changes.",
      )
    }
    const remaining_evaluations = this.#limits.max_fit_evaluations - this.#fit_evaluations
    const granted_fit_evaluations = Math.min(
      Math.max(3, Math.floor(input.requested_fit_evaluations ?? 32)),
      this.#limits.max_fit_evaluations_per_call,
      remaining_evaluations,
    )
    if (granted_fit_evaluations < 3) {
      return denied(
        `The bounded search already used ${this.#limits.max_fit_evaluations} simulator evaluations. ` +
          "The best runnable candidate was retained; finish without another fit.",
      )
    }
    this.#fit_calls += 1
    this.#fit_evaluations += granted_fit_evaluations
    this.#fit_calls_by_topology.set(topology_fingerprint, topology_fit_calls + 1)
    this.#topologies.add(topology_fingerprint)
    const next = this.summary
    return {
      allowed: true,
      topology_fingerprint,
      remaining_checks: next.remaining_checks,
      remaining_fit_calls: next.remaining_fit_calls,
      remaining_fit_evaluations: next.remaining_fit_evaluations,
      granted_fit_evaluations,
    }
  }

  reserveCheck(source: string): ModelCandidateSearchBudgetDecision {
    return this.#decision({ source, kind: "check" })
  }

  reserveFit(source: string, requested_evaluations: number): ModelCandidateSearchBudgetDecision {
    return this.#decision({
      source,
      kind: "fit",
      requested_fit_evaluations: requested_evaluations,
    })
  }

  consider(snapshot: ModelCandidateSearchSnapshot): "initial" | "improved" | "retained" {
    if (!this.#best) {
      this.#best = snapshot
      return "initial"
    }
    if (compareModelTrainingCandidateQuality(snapshot.quality, this.#best.quality) < 0) {
      this.#best = snapshot
      return "improved"
    }
    return "retained"
  }
}
