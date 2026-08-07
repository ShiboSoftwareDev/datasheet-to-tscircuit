import { createHash } from "node:crypto"
import type { ModelCharacterization, ModelReferencePoint, ModelRequirement } from "../../modeling/types"
import { modelReferenceElectricalBindingsEqual } from "../../modeling/reference-electrical-binding"
import type { ReferenceGraphSourceProof } from "../reference-graph-axis-proof"
import { assertExactCanonicalReferenceCrop, matchingReferenceGraphs } from "../reference-graph-crop-proof"
import { eligibleObservedChannels, type EligibleObservedReferenceChannel } from "./eligibility"
import {
  finiteNumber,
  MAX_TRACE_POINTS,
  MAX_NORMALIZED_ERROR,
  MAX_NORMALIZED_RMSE,
  MIN_X_COVERAGE_RATIO,
  minimumTracePointCount,
} from "./schema"
import type { ModelReferenceNumericVerification, ReferenceGraphObservation } from "./types"

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function interpolateLinear(points: readonly ModelReferencePoint[], x: number): number {
  const first = points[0]
  const last = points.at(-1)
  if (!first || !last) throw new Error("Cannot interpolate an empty reference curve")
  if (x <= first.x) return first.y
  if (x >= last.x) return last.y
  let low = 0
  let high = points.length - 1
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (points[middle]!.x <= x) low = middle
    else high = middle
  }
  const left = points[low]!
  const right = points[high]!
  const ratio = (x - left.x) / (right.x - left.x)
  return left.y + ratio * (right.y - left.y)
}

function parseCandidateCurve(
  requirement: ModelRequirement,
  minimum_points: number,
  expected: { quantity: "voltage" | "current"; unit: "V" | "A" },
): {
  points: ModelReferencePoint[]
  digest: string
} {
  if (requirement.analysis !== "transient") {
    throw new Error(
      `Modeled requirement ${requirement.requirement_id} must remain a transient time-domain requirement`,
    )
  }
  const curve = requirement.reference_curve
  if (
    !curve ||
    curve.x_quantity !== "time" ||
    curve.x_unit !== "s" ||
    curve.y_quantity !== expected.quantity ||
    curve.y_unit !== expected.unit ||
    requirement.expected.unit !== expected.unit
  ) {
    throw new Error(
      `Modeled requirement ${requirement.requirement_id} must use a time (s) to ${expected.quantity} (${expected.unit}) reference curve`,
    )
  }
  if (curve.points.length < minimum_points || curve.points.length > MAX_TRACE_POINTS) {
    throw new Error(
      `Modeled requirement ${requirement.requirement_id} must contain ${minimum_points} through ${MAX_TRACE_POINTS} distributed curve points`,
    )
  }
  const points = curve.points.map((point, index) => {
    const x = finiteNumber(point.x, `Modeled requirement ${requirement.requirement_id} point ${index + 1}.x`)
    const y = finiteNumber(point.y, `Modeled requirement ${requirement.requirement_id} point ${index + 1}.y`)
    if (index > 0 && x <= curve.points[index - 1]!.x) {
      throw new Error(
        `Modeled requirement ${requirement.requirement_id} curve time values must increase strictly`,
      )
    }
    return { x, y }
  })
  return {
    points,
    digest: sha256Json({
      x_quantity: curve.x_quantity,
      x_unit: curve.x_unit,
      y_quantity: curve.y_quantity,
      y_unit: curve.y_unit,
      points,
    }),
  }
}

function compareCurveFidelity(input: {
  requirement: ModelRequirement
  graph: EligibleObservedReferenceChannel
}): ModelReferenceNumericVerification["matches"][number]["curve_fidelity"] {
  const observer_curve = input.graph.digitized_curve
  const candidate = parseCandidateCurve(
    input.requirement,
    minimumTracePointCount(observer_curve.x_axis.second.pixel - observer_curve.x_axis.first.pixel),
    { quantity: observer_curve.y_quantity, unit: observer_curve.y_unit },
  )
  const observer_points = observer_curve.points.map(({ x, y }) => ({ x, y }))
  const observer_start = observer_points[0]!.x
  const observer_end = observer_points.at(-1)!.x
  const observer_span = observer_end - observer_start
  if (!(observer_span > 0)) throw new Error(`Independent graph ${input.graph.graph_id} has no time span`)
  const candidate_start = candidate.points[0]!.x
  const candidate_end = candidate.points.at(-1)!.x
  const overlap_start = Math.max(observer_start, candidate_start)
  const overlap_end = Math.min(observer_end, candidate_end)
  const x_coverage_ratio = Math.max(0, overlap_end - overlap_start) / observer_span
  if (x_coverage_ratio < MIN_X_COVERAGE_RATIO) {
    throw new Error(
      `Modeled requirement ${input.requirement.requirement_id} fails independent numeric curve fidelity: elapsed-time coverage is below the required ${(MIN_X_COVERAGE_RATIO * 100).toFixed(0)}%`,
    )
  }
  const sample_x = [
    overlap_start,
    ...observer_points.flatMap(({ x }) => (x > overlap_start && x < overlap_end ? [x] : [])),
    ...candidate.points.flatMap(({ x }) => (x > overlap_start && x < overlap_end ? [x] : [])),
    overlap_end,
  ]
    .sort((left, right) => left - right)
    .filter((x, index, values) => index === 0 || x !== values[index - 1])
  const y_span = observer_curve.y_range.max - observer_curve.y_range.min
  const errors = sample_x.map(
    (x) => Math.abs(interpolateLinear(candidate.points, x) - interpolateLinear(observer_points, x)) / y_span,
  )
  const normalized_rmse = Math.sqrt(errors.reduce((sum, error) => sum + error * error, 0) / errors.length)
  const max_normalized_error = Math.max(...errors)
  if (normalized_rmse > MAX_NORMALIZED_RMSE || max_normalized_error > MAX_NORMALIZED_ERROR) {
    // Deliberately report aggregate metrics only. The independent axis anchors,
    // traced points, and error locations stay private across characterization retries.
    throw new Error(
      `Modeled requirement ${input.requirement.requirement_id} fails independent numeric curve fidelity (normalized RMSE ${normalized_rmse.toFixed(3)}, maximum error ${max_normalized_error.toFixed(3)})`,
    )
  }
  return {
    algorithm: "linear_interpolation_axis_normalized_v1",
    observer_curve_sha256: sha256Json(observer_curve),
    candidate_curve_sha256: candidate.digest,
    compared_sample_count: sample_x.length,
    x_coverage_ratio,
    normalized_rmse,
    max_normalized_error,
    thresholds: {
      min_x_coverage_ratio: MIN_X_COVERAGE_RATIO,
      max_normalized_rmse: MAX_NORMALIZED_RMSE,
      max_normalized_error: MAX_NORMALIZED_ERROR,
    },
  }
}

export function verifyCharacterizationGraphEvidence(input: {
  characterization: ModelCharacterization
  observation: ReferenceGraphObservation
  source_proof?: ReferenceGraphSourceProof
}): ModelReferenceNumericVerification {
  const modeled = input.characterization.requirements.filter(({ support }) => support.status === "modeled")
  const eligible = eligibleObservedChannels(input.observation)
  if (modeled.length === 0 && eligible.length > 0) {
    throw new Error(
      `The independent datasheet observer found eligible elapsed-time comparison channel${eligible.length === 1 ? "" : "s"}: ${eligible
        .map(({ page, locator, channel_label }) => `PDF page ${page} ${locator} (${channel_label})`)
        .join(
          "; ",
        )}. Create a modeled requirement for every eligible graph instead of returning an all-documented characterization.`,
    )
  }
  const matches = modeled.map((requirement) => {
    const graph_matches = matchingReferenceGraphs({ requirement, graphs: eligible })
    if (graph_matches.length !== 1) {
      throw new Error(
        `Modeled requirement ${requirement.requirement_id} must match exactly one independently observed simulatable elapsed-time channel; found ${graph_matches.length}`,
      )
    }
    const graph = graph_matches[0] as EligibleObservedReferenceChannel
    const crop_proof = assertExactCanonicalReferenceCrop({ requirement, graph })
    const candidate_binding = requirement.reference_curve?.electrical_binding
    if (
      !candidate_binding ||
      !modelReferenceElectricalBindingsEqual(candidate_binding, graph.electrical_binding)
    ) {
      throw new Error(
        `Modeled requirement ${requirement.requirement_id} must preserve the independent graph's exact experiment binding, including source kind, DUT endpoints, levels, and timing`,
      )
    }
    return {
      requirement_id: requirement.requirement_id,
      graph_id: graph.graph_id,
      crop_proof,
      axis_calibration_receipt_sha256: input.source_proof
        ? (() => {
            const receipts = input.source_proof.results.filter(
              (
                result,
              ): result is Extract<ReferenceGraphSourceProof["results"][number], { status: "verified" }> =>
                result.status === "verified" && result.graph_id === graph.source_graph_id,
            )
            if (receipts.length !== 1) {
              throw new Error(
                `Independent source graph ${graph.source_graph_id} does not have exactly one verified axis receipt`,
              )
            }
            return receipts[0]!.receipt_sha256
          })()
        : "legacy-unretained-axis-proof",
      curve_fidelity: compareCurveFidelity({ requirement, graph }),
    }
  })
  const matched_graph_ids = new Set(matches.map(({ graph_id }) => graph_id))
  if (matched_graph_ids.size !== matches.length) {
    throw new Error(
      "Each modeled requirement must map one-to-one with a different independently eligible plotted channel",
    )
  }
  const unmatched_graphs = eligible.filter(({ graph_id }) => !matched_graph_ids.has(graph_id))
  if (unmatched_graphs.length > 0) {
    throw new Error(
      `Every independently eligible plotted channel must become a modeled requirement; missing ${unmatched_graphs
        .map(
          ({ graph_id, page, locator, channel_label }) =>
            `${graph_id} (${channel_label}, PDF page ${page}, ${locator})`,
        )
        .join("; ")}`,
    )
  }
  return {
    version: 2,
    source_pdf_sha256: input.observation.source_pdf_sha256,
    matches,
  }
}
