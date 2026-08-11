import type { ApplicationFixtureContract } from "../../modeling/application-fixture-contract"
import type { ModelInterface } from "../../modeling/types"
import { normalizeFigureLabel, type TimeGraphDiscovery } from "../time-graph-hints"
import { eligibleObservedGraphs, foundObservedGraphs } from "./eligibility"
import {
  isRecord,
  MAX_ELIGIBLE_GRAPHS,
  MAX_OBSERVED_GRAPHS,
  nonEmptyString,
  parseGraph,
  type ReferenceGraphArtifactPhase,
  type ReferencePointFieldPolicy,
  rejectUnknownKeys,
} from "./schema"
import { canonicalizeObservedGraphSource } from "./source-canonicalization"
import type { ObservedReferenceGraph, ReferenceGraphObservation } from "./types"

export function parseReferenceGraphObservation(
  value: unknown,
  discovery: TimeGraphDiscovery,
  model_interface: ModelInterface,
  application_fixture?: ApplicationFixtureContract,
): ReferenceGraphObservation {
  return parseReferenceGraphObservationWithPointPolicy(
    value,
    discovery,
    model_interface,
    application_fixture,
    "pixels_only",
    "comparison",
  )
}

export function parseFoundReferenceGraphObservation(
  value: unknown,
  discovery: TimeGraphDiscovery,
  model_interface?: ModelInterface,
  application_fixture?: ApplicationFixtureContract,
): ReferenceGraphObservation {
  return parseReferenceGraphObservationWithPointPolicy(
    value,
    discovery,
    model_interface,
    application_fixture,
    "pixels_only",
    "find",
  )
}

export function parseCanonicalReferenceGraphObservation(
  value: unknown,
  discovery: TimeGraphDiscovery,
  model_interface: ModelInterface,
  application_fixture?: ApplicationFixtureContract,
): ReferenceGraphObservation {
  return parseReferenceGraphObservationWithPointPolicy(
    value,
    discovery,
    model_interface,
    application_fixture,
    "canonical",
    "comparison",
  )
}

export function parseCanonicalFoundReferenceGraphObservation(
  value: unknown,
  discovery: TimeGraphDiscovery,
  model_interface: ModelInterface,
  application_fixture?: ApplicationFixtureContract,
): ReferenceGraphObservation {
  return parseReferenceGraphObservationWithPointPolicy(
    value,
    discovery,
    model_interface,
    application_fixture,
    "canonical",
    "find",
  )
}

function parseReferenceGraphObservationWithPointPolicy(
  value: unknown,
  discovery: TimeGraphDiscovery,
  model_interface: ModelInterface | undefined,
  application_fixture: ApplicationFixtureContract | undefined,
  point_field_policy: ReferencePointFieldPolicy,
  phase: ReferenceGraphArtifactPhase,
): ReferenceGraphObservation {
  if (!isRecord(value)) throw new Error("model-reference-observation.json must be an object")
  rejectUnknownKeys(
    value,
    ["version", "source_pdf_sha256", "reviewed_hints", "graphs"],
    "model-reference-observation.json",
  )
  if (value.version !== 1) throw new Error("model-reference-observation.json.version must be 1")
  if (value.source_pdf_sha256 !== discovery.source_pdf_sha256) {
    throw new Error("model-reference-observation.json.source_pdf_sha256 must match the canonical PDF")
  }
  if (application_fixture && application_fixture.source_pdf_sha256 !== discovery.source_pdf_sha256) {
    throw new Error("application-fixture-contract.json.source_pdf_sha256 must match the graph discovery PDF")
  }
  if (!Array.isArray(value.graphs))
    throw new Error("model-reference-observation.json.graphs must be an array")
  if (value.graphs.length > MAX_OBSERVED_GRAPHS) {
    throw new Error(
      `model-reference-observation.json.graphs cannot contain more than ${MAX_OBSERVED_GRAPHS} entries`,
    )
  }
  const graph_results = value.graphs.map((graph, index) => {
    try {
      return { graph: parseGraph(graph, index, model_interface, point_field_policy, phase) }
    } catch (error) {
      return { error: error instanceof Error ? error : new Error(String(error)) }
    }
  })
  const graph_errors = graph_results.flatMap((result) => (result.error ? [result.error] : []))
  if (graph_errors.length > 0) {
    const details = [...new Set(graph_errors.map((error) => error.message))]
    throw new AggregateError(
      graph_errors,
      `model-reference-observation.json contains ${graph_errors.length} invalid graph entr${graph_errors.length === 1 ? "y" : "ies"}:\n${details.map((detail) => `- ${detail}`).join("\n")}`,
    )
  }
  const graphs = graph_results.flatMap((result) => (result.graph ? [result.graph] : []))
  const graph_by_id = new Map(graphs.map((graph) => [graph.graph_id, graph]))
  if (graph_by_id.size !== graphs.length)
    throw new Error("model-reference-observation.json graph ids must be unique")
  if (
    (phase === "find" ? foundObservedGraphs : eligibleObservedGraphs)({
      version: 1,
      source_pdf_sha256: discovery.source_pdf_sha256,
      reviewed_hints: [],
      graphs,
    }).length > MAX_ELIGIBLE_GRAPHS
  ) {
    throw new Error(
      `model-reference-observation.json cannot contain more than ${MAX_ELIGIBLE_GRAPHS} eligible voltage graphs`,
    )
  }
  if (!Array.isArray(value.reviewed_hints)) {
    throw new Error("model-reference-observation.json.reviewed_hints must be an array")
  }
  const hint_by_id = new Map(discovery.hints.map((hint) => [hint.hint_id, hint]))
  const reviewed_hints = value.reviewed_hints.map((entry, index) => {
    const path = `model-reference-observation.json.reviewed_hints[${index}]`
    if (!isRecord(entry)) throw new Error(`${path} must be an object`)
    rejectUnknownKeys(entry, ["hint_id", "disposition", "graph_id", "reason"], path)
    const hint_id = nonEmptyString(entry.hint_id, `${path}.hint_id`)
    const hint = hint_by_id.get(hint_id)
    if (!hint) throw new Error(`${path}.hint_id does not name a deterministic hint`)
    if (entry.disposition !== "graph" && entry.disposition !== "not_time_graph") {
      throw new Error(`${path}.disposition must be graph or not_time_graph`)
    }
    const graph_id =
      entry.graph_id === undefined ? undefined : nonEmptyString(entry.graph_id, `${path}.graph_id`)
    if (entry.disposition === "graph") {
      const graph = graph_id ? graph_by_id.get(graph_id) : undefined
      if (!graph) throw new Error(`${path}.graph_id must name an observed graph`)
      if (graph.page !== hint.page)
        throw new Error(`${path}.graph_id must stay on hinted PDF page ${hint.page}`)
      const hinted_figure = normalizeFigureLabel(hint.figure)
      if (hinted_figure && normalizeFigureLabel(graph.locator) !== hinted_figure) {
        throw new Error(`${path}.graph_id must identify ${hint.figure}`)
      }
    } else {
      if (graph_id !== undefined) throw new Error(`${path}.graph_id is incompatible with not_time_graph`)
      if (!/^printed\s+.+\s+axis$/i.test(hint.reason)) {
        throw new Error(
          `${path}.disposition cannot dismiss the server-detected time-graph caption ${hint.figure}; only an axis-proximity hint without a timing caption may be classified not_time_graph`,
        )
      }
    }
    return {
      hint_id,
      disposition: entry.disposition,
      ...(graph_id ? { graph_id } : {}),
      reason: nonEmptyString(entry.reason, `${path}.reason`),
    } as ReferenceGraphObservation["reviewed_hints"][number]
  })
  const reviewed_ids = reviewed_hints.map(({ hint_id }) => hint_id)
  if (
    new Set(reviewed_ids).size !== reviewed_ids.length ||
    JSON.stringify([...reviewed_ids].sort()) !== JSON.stringify([...hint_by_id.keys()].sort())
  ) {
    throw new Error("model-reference-observation.json must review every deterministic hint exactly once")
  }
  const graph_hint_evidence = new Map<string, TimeGraphDiscovery["hints"]>()
  for (const review of reviewed_hints) {
    if (review.disposition !== "graph" || !review.graph_id) continue
    const hint = hint_by_id.get(review.hint_id)
    if (!hint) continue
    const evidence = graph_hint_evidence.get(review.graph_id) ?? []
    evidence.push(hint)
    graph_hint_evidence.set(review.graph_id, evidence)
  }
  const canonical_graph_errors: string[] = []
  const canonical_graphs = graphs.flatMap((graph): ObservedReferenceGraph[] => {
    try {
      return [
        canonicalizeObservedGraphSource({
          graph,
          source_hints: graph_hint_evidence.get(graph.graph_id) ?? [],
          model_interface,
          application_fixture,
          phase,
          preserve_find_ineligibility: phase === "find" && point_field_policy === "canonical",
          preserve_source_ineligibility: point_field_policy === "canonical",
        }),
      ]
    } catch (error) {
      canonical_graph_errors.push(
        `${graph.graph_id}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return []
    }
  })
  if (canonical_graph_errors.length > 0) {
    throw new Error(`Reference graph electrical validation failed:\n${canonical_graph_errors.join("\n")}`)
  }
  return {
    version: 1,
    source_pdf_sha256: discovery.source_pdf_sha256,
    reviewed_hints,
    graphs: canonical_graphs,
  }
}
