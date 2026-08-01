import type { ReferenceGraphObservation } from "../reference-graph-observation"
import type { ReferenceGraphAxisProofResult, ReferenceGraphSourceProof } from "./types"

export function verifiedReferenceGraphIds(proof: ReferenceGraphSourceProof): Set<string> {
  return new Set(proof.results.flatMap((result) => (result.status === "verified" ? [result.graph_id] : [])))
}

/** Produces the only observation view characterization is allowed to consume. */
export function applyReferenceGraphSourceEligibility(input: {
  observation: ReferenceGraphObservation
  proof: ReferenceGraphSourceProof
}): ReferenceGraphObservation {
  if (input.proof.source_pdf_sha256 !== input.observation.source_pdf_sha256) {
    throw new Error("Reference graph source proof does not belong to the observed PDF")
  }
  const results = new Map(input.proof.results.map((result) => [result.graph_id, result]))
  return {
    ...input.observation,
    reviewed_hints: input.observation.reviewed_hints.map((entry) => ({ ...entry })),
    graphs: input.observation.graphs.map((graph) => {
      const was_candidate =
        graph.response_quantity === "voltage" &&
        graph.public_pin_observable &&
        graph.fixture_reproducible &&
        graph.electrical_binding !== undefined &&
        graph.digitized_curve !== undefined
      if (!was_candidate) return { ...graph, crop: { ...graph.crop } }
      const result = results.get(graph.graph_id)
      if (result?.status === "verified") return { ...graph, crop: { ...graph.crop } }
      const reason =
        result?.status === "ineligible"
          ? result.reason
          : "No canonical PDF axis-calibration result was retained for this graph."
      return {
        ...graph,
        crop: { ...graph.crop },
        fixture_reproducible: false,
        reason: `${graph.reason} Axis calibration is source-ineligible: ${reason}`,
        electrical_binding: undefined,
        digitized_curve: undefined,
      }
    }),
  }
}

export function axisReceiptForGraph(
  proof: ReferenceGraphSourceProof,
  graph_id: string,
): Extract<ReferenceGraphAxisProofResult, { status: "verified" }> {
  const matches = proof.results.filter(
    (result): result is Extract<ReferenceGraphAxisProofResult, { status: "verified" }> =>
      result.status === "verified" && result.graph_id === graph_id,
  )
  if (matches.length !== 1) {
    throw new Error(`Independent graph ${graph_id} does not have exactly one verified axis receipt`)
  }
  return matches[0]!
}
