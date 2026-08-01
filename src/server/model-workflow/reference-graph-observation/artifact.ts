import {
  type ApplicationFixtureContract,
  resolveApplicationFixtureForBinding,
} from "../../modeling/application-fixture-contract"
import type { ModelInterface, ModelReferenceElectricalBinding } from "../../modeling/types"
import {
  normalizeFigureLabel,
  type TimeGraphDiscovery,
  type TimeGraphTransientFixtureEvidence,
} from "../time-graph-hints"
import { eligibleObservedGraphs } from "./eligibility"
import {
  assertBindingMatchesPrintedFixture,
  reconcileGraphPassiveConstraints,
} from "./fixture-reconciliation"
import {
  isRecord,
  MAX_ELIGIBLE_GRAPHS,
  MAX_OBSERVED_GRAPHS,
  nonEmptyString,
  parseGraph,
  rejectUnknownKeys,
} from "./schema"
import type { ObservedReferenceGraph, ObservedVoltageTimeCurve, ReferenceGraphObservation } from "./types"

export function parseReferenceGraphObservation(
  value: unknown,
  discovery: TimeGraphDiscovery,
  model_interface: ModelInterface,
  application_fixture?: ApplicationFixtureContract,
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
  const graphs = value.graphs.map((graph, index) => parseGraph(graph, index, model_interface))
  const graph_by_id = new Map(graphs.map((graph) => [graph.graph_id, graph]))
  if (graph_by_id.size !== graphs.length)
    throw new Error("model-reference-observation.json graph ids must be unique")
  if (
    eligibleObservedGraphs({
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
  const canonical_graphs = graphs.map((graph): ObservedReferenceGraph => {
    const source_hints = graph_hint_evidence.get(graph.graph_id) ?? []
    const unsupported_conditions = [
      ...new Set(
        source_hints.flatMap(({ unsupported_fixture_conditions }) => unsupported_fixture_conditions),
      ),
    ]
    if (unsupported_conditions.length > 0) {
      // The complete-PDF scan is server-owned and authoritative. Do not spend
      // another observer attempt asking an agent to agree with a deterministic
      // blocker: canonicalize the graph as fixture-ineligible and discard the
      // electrical binding that is valid only for reproducible graphs.
      const { electrical_binding: _unsupported_binding, ...without_binding } = graph
      return {
        ...without_binding,
        fixture_reproducible: false,
        reason:
          `Server-owned datasheet conditions require unsupported ${unsupported_conditions.join(", ")} state; ` +
          "an ordinary public-pin analog pulse fixture cannot reproduce this graph.",
      }
    }
    const condition_conflicts = source_hints.flatMap(({ condition_conflicts }) => condition_conflicts)
    if (condition_conflicts.length > 0) {
      const { electrical_binding: _conflicting_binding, ...without_binding } = graph
      return {
        ...without_binding,
        fixture_reproducible: false,
        reason: `Server-owned summary/caption conditions conflict (${condition_conflicts
          .map(({ key }) => key)
          .join(", ")}); no source-precedence guess is permitted.`,
      }
    }
    const fixture_evidence = source_hints.map(({ transient_fixture_evidence }) => transient_fixture_evidence)
    const unique_fixture_evidence = [
      ...new Set(fixture_evidence.flatMap((evidence) => (evidence ? [JSON.stringify(evidence)] : []))),
    ]
    if (
      source_hints.length > 0 &&
      (fixture_evidence.some((evidence) => evidence === null) || unique_fixture_evidence.length !== 1)
    ) {
      const { electrical_binding: _invented_binding, ...without_binding } = graph
      return {
        ...without_binding,
        fixture_reproducible: false,
        reason:
          "Server-owned datasheet text does not prove one non-flat public-pin voltage/current step with numeric levels and edge timing; an electrical fixture cannot be invented for this graph.",
      }
    }
    const is_eligible =
      graph.response_quantity === "voltage" && graph.public_pin_observable && graph.fixture_reproducible
    if (!is_eligible) return graph
    if (source_hints.length === 0) {
      throw new Error(
        `Eligible graph ${graph.graph_id} must be tied to deterministic, source-grounded operating-condition evidence in time-graph-hints.json`,
      )
    }
    const passive_constraint_failure = reconcileGraphPassiveConstraints({
      source_hints,
      application_fixture,
    })
    if (passive_constraint_failure) {
      const { electrical_binding: _unbound_passive_fixture, ...without_binding } = graph
      return {
        ...without_binding,
        fixture_reproducible: false,
        reason:
          `[${passive_constraint_failure.code}] Server-owned graph-local passive constraint failed: ` +
          passive_constraint_failure.message,
      }
    }
    try {
      assertBindingMatchesPrintedFixture({
        graph: graph as ObservedReferenceGraph & {
          electrical_binding: ModelReferenceElectricalBinding
          digitized_curve: ObservedVoltageTimeCurve
        },
        evidence: JSON.parse(unique_fixture_evidence[0]!) as TimeGraphTransientFixtureEvidence,
        model_interface,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/printed signal .+ resolves to \d+ public model pins|cannot map uniquely/i.test(message)) {
        const { electrical_binding: _unmappable_binding, ...without_binding } = graph
        return {
          ...without_binding,
          fixture_reproducible: false,
          reason: `Server-owned printed conditions cannot map uniquely to public endpoints and fixture language: ${message}`,
        }
      }
      throw error
    }
    if (!application_fixture || application_fixture.availability === "not_present") {
      const binding = graph.electrical_binding!
      if (binding.application_fixture_sha256 || binding.application_topology_sha256) {
        throw new Error(
          `Eligible graph ${graph.graph_id} must omit application fixture digests because canonical evidence explicitly declares availability not_present`,
        )
      }
      return graph
    }
    const binding = graph.electrical_binding!
    const unbound: ModelReferenceElectricalBinding = {
      response: binding.response,
      stimulus: binding.stimulus,
      ...(binding.auxiliary_fixtures ? { auxiliary_fixtures: binding.auxiliary_fixtures } : {}),
    }
    const resolved_application = resolveApplicationFixtureForBinding({
      contract: application_fixture,
      binding: unbound,
    })
    if (
      (binding.application_fixture_sha256 !== undefined &&
        binding.application_fixture_sha256 !== application_fixture.contract_sha256) ||
      (binding.application_topology_sha256 !== undefined &&
        binding.application_topology_sha256 !== resolved_application.topology_sha256)
    ) {
      throw new Error(
        `Eligible graph ${graph.graph_id} application fixture digests do not match the server-compiled printed topology`,
      )
    }
    return {
      ...graph,
      electrical_binding: {
        ...unbound,
        application_fixture_sha256: application_fixture.contract_sha256,
        application_topology_sha256: resolved_application.topology_sha256,
      },
    }
  })
  return {
    version: 1,
    source_pdf_sha256: discovery.source_pdf_sha256,
    reviewed_hints,
    graphs: canonical_graphs,
  }
}
