import {
  type ApplicationFixtureContract,
  resolveApplicationFixtureForBinding,
} from "../../modeling/application-fixture-contract"
import type { ModelInterface, ModelReferenceElectricalBinding } from "../../modeling/types"
import type { TimeGraphDiscovery, TimeGraphTransientFixtureEvidence } from "../time-graph-hints"
import {
  assertBindingMatchesPrintedFixture,
  assertPrintedFixtureEndpointsResolvable,
  FixtureEndpointResolutionError,
  reconcileGraphPassiveConstraints,
} from "./fixture-reconciliation"
import type { ObservedReferenceGraph, ObservedVoltageTimeCurve } from "./types"
import type { ReferenceGraphArtifactPhase } from "./schema"

function withoutComparisonState(graph: ObservedReferenceGraph): ObservedReferenceGraph {
  const { electrical_binding: _binding, digitized_curve: _curve, ...found } = graph
  return found
}

export function canonicalizeObservedGraphSource(input: {
  graph: ObservedReferenceGraph
  source_hints: TimeGraphDiscovery["hints"]
  model_interface: ModelInterface
  application_fixture?: ApplicationFixtureContract
  phase?: ReferenceGraphArtifactPhase
}): ObservedReferenceGraph {
  const { graph, source_hints, model_interface, application_fixture, phase = "comparison" } = input
  const unsupported_conditions = [
    ...new Set(source_hints.flatMap(({ unsupported_fixture_conditions }) => unsupported_fixture_conditions)),
  ]
  if (unsupported_conditions.length > 0) {
    const without_binding = withoutComparisonState(graph)
    return {
      ...without_binding,
      fixture_reproducible: false,
      reason:
        `Server-owned datasheet conditions require unsupported ${unsupported_conditions.join(", ")} state; ` +
        "the supported public-pin tscircuit fixture cannot reproduce this graph.",
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
    const without_binding = withoutComparisonState(graph)
    return {
      ...without_binding,
      fixture_reproducible: false,
      reason:
        "Server-owned datasheet text does not prove one complete tscircuit-supported transient setup; an electrical fixture cannot be invented for this graph.",
    }
  }

  const printed_fixture_evidence =
    unique_fixture_evidence.length === 1
      ? (JSON.parse(unique_fixture_evidence[0]!) as TimeGraphTransientFixtureEvidence)
      : undefined

  if (printed_fixture_evidence?.stimulus.type === "steady_state") {
    return {
      ...withoutComparisonState(graph),
      fixture_reproducible: false,
      reason:
        "The printed elapsed-time waveform has no changing public-pin stimulus. The current tscircuit model runtime forbids autonomous time-driven behavior and cannot reproduce internal switching waveforms from a steady fixture.",
    }
  }

  if (phase === "find") {
    const found = withoutComparisonState(graph)
    const potentially_eligible = graph.response_quantity === "voltage" && graph.public_pin_observable
    if (!potentially_eligible || !printed_fixture_evidence) {
      return { ...found, fixture_reproducible: false }
    }
    const passive_constraint_failure = reconcileGraphPassiveConstraints({
      source_hints,
      application_fixture,
    })
    if (passive_constraint_failure) {
      return {
        ...found,
        fixture_reproducible: false,
        reason:
          `[${passive_constraint_failure.code}] Server-owned graph-local passive constraint failed: ` +
          passive_constraint_failure.message,
      }
    }
    try {
      assertPrintedFixtureEndpointsResolvable({
        evidence: printed_fixture_evidence,
        model_interface,
        graph_id: graph.graph_id,
      })
    } catch (error) {
      if (error instanceof FixtureEndpointResolutionError) {
        return {
          ...found,
          fixture_reproducible: false,
          reason: `Server-owned printed conditions cannot map uniquely to public endpoints and fixture language: ${error.message}`,
        }
      }
      throw error
    }
    return {
      ...found,
      fixture_reproducible: true,
      reason:
        "Server-owned graph-local conditions resolve to a public voltage response and a tscircuit-supported transient fixture.",
    }
  }
  if (
    printed_fixture_evidence &&
    graph.response_quantity === "voltage" &&
    graph.public_pin_observable &&
    !graph.fixture_reproducible
  ) {
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
      assertPrintedFixtureEndpointsResolvable({
        evidence: printed_fixture_evidence,
        model_interface,
        graph_id: graph.graph_id,
      })
    } catch (error) {
      if (error instanceof FixtureEndpointResolutionError) {
        const { electrical_binding: _unmappable_binding, ...without_binding } = graph
        return {
          ...without_binding,
          fixture_reproducible: false,
          reason: `Server-owned printed conditions cannot map uniquely to public endpoints and fixture language: ${error.message}`,
        }
      }
      throw error
    }
    throw new Error(
      `Graph ${graph.graph_id} cannot be marked fixture_reproducible:false: server-owned printed conditions resolve to one public response and a tscircuit-supported transient fixture. Mark it true and provide electrical_binding plus digitized_curve.`,
    )
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
      evidence: printed_fixture_evidence!,
      model_interface,
    })
  } catch (error) {
    if (error instanceof FixtureEndpointResolutionError) {
      const { electrical_binding: _unmappable_binding, ...without_binding } = graph
      return {
        ...without_binding,
        fixture_reproducible: false,
        reason: `Server-owned printed conditions cannot map uniquely to public endpoints and fixture language: ${error.message}`,
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
