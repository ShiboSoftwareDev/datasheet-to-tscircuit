import {
  type ApplicationFixtureContract,
  resolveApplicationFixtureForBinding,
} from "../../modeling/application-fixture-contract"
import type { ModelInterface, ModelReferenceElectricalBinding } from "../../modeling/types"
import type { TimeGraphDiscovery, TimeGraphTransientFixtureEvidence } from "../time-graph-hints"
import {
  assertBindingMatchesPrintedFixture,
  reconcileGraphPassiveConstraints,
} from "./fixture-reconciliation"
import type { ObservedReferenceGraph, ObservedVoltageTimeCurve } from "./types"

export function canonicalizeObservedGraphSource(input: {
  graph: ObservedReferenceGraph
  source_hints: TimeGraphDiscovery["hints"]
  model_interface: ModelInterface
  application_fixture?: ApplicationFixtureContract
}): ObservedReferenceGraph {
  const { graph, source_hints, model_interface, application_fixture } = input
  const unsupported_conditions = [
    ...new Set(source_hints.flatMap(({ unsupported_fixture_conditions }) => unsupported_fixture_conditions)),
  ]
  if (unsupported_conditions.length > 0) {
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
}
