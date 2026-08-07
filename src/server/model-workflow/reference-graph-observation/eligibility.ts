import type { ModelReferenceElectricalBinding } from "../../modeling/types"
import type {
  CharacterizerReferenceGraphObservation,
  ObservedReferenceGraph,
  ObservedReferenceChannel,
  ReferenceGraphObservation,
} from "./types"

export type EligibleObservedReferenceGraph = ObservedReferenceGraph & {
  response_quantity: "voltage"
  public_pin_observable: true
  fixture_reproducible: true
  electrical_binding: ModelReferenceElectricalBinding
  channels: ObservedReferenceChannel[]
}

export type EligibleObservedReferenceChannel = Omit<EligibleObservedReferenceGraph, "channels"> & {
  source_graph_id: string
  channel_id: string
  channel_label: string
  channel_role: ObservedReferenceChannel["role"]
  measurement: ObservedReferenceChannel["measurement"]
  digitized_curve: ObservedReferenceChannel["digitized_curve"]
}

export function referenceChannelKey(graph_id: string, channel_id: string): string {
  return `${graph_id}__${channel_id}`
}

export type FoundObservedReferenceGraph = ObservedReferenceGraph & {
  response_quantity: "voltage"
  public_pin_observable: true
  fixture_reproducible: true
}

export function foundObservedGraphs(observation: ReferenceGraphObservation): FoundObservedReferenceGraph[] {
  return observation.graphs.filter(
    (graph): graph is FoundObservedReferenceGraph =>
      graph.response_quantity === "voltage" && graph.public_pin_observable && graph.fixture_reproducible,
  )
}

export function eligibleObservedGraphs(
  observation: ReferenceGraphObservation,
): EligibleObservedReferenceGraph[] {
  return observation.graphs.filter(
    (graph): graph is EligibleObservedReferenceGraph =>
      graph.response_quantity === "voltage" &&
      graph.public_pin_observable &&
      graph.fixture_reproducible &&
      graph.electrical_binding !== undefined &&
      graph.channels !== undefined &&
      graph.channels.length > 0,
  )
}

export function eligibleObservedChannels(
  observation: ReferenceGraphObservation,
): EligibleObservedReferenceChannel[] {
  return eligibleObservedGraphs(observation).flatMap((graph) => {
    const { channels, ...source_graph } = graph
    return channels.map((channel) => ({
      ...source_graph,
      graph_id: referenceChannelKey(graph.graph_id, channel.channel_id),
      source_graph_id: graph.graph_id,
      channel_id: channel.channel_id,
      channel_label: channel.label,
      channel_role: channel.role,
      measurement: structuredClone(channel.measurement),
      digitized_curve: structuredClone(channel.digitized_curve),
    }))
  })
}

/** Resolves the one plotted channel named as the graph experiment's primary response. */
export function primaryResponseChannel(
  graph: EligibleObservedReferenceGraph,
): EligibleObservedReferenceChannel | undefined {
  const channel = graph.channels.find(
    ({ role, measurement }) =>
      role === "response" &&
      measurement.type === "voltage" &&
      measurement.positive === graph.electrical_binding.response.positive &&
      measurement.negative === graph.electrical_binding.response.negative,
  )
  if (!channel) return undefined
  const { channels: _channels, ...source_graph } = graph
  return {
    ...source_graph,
    graph_id: referenceChannelKey(graph.graph_id, channel.channel_id),
    source_graph_id: graph.graph_id,
    channel_id: channel.channel_id,
    channel_label: channel.label,
    channel_role: channel.role,
    measurement: structuredClone(channel.measurement),
    digitized_curve: structuredClone(channel.digitized_curve),
  }
}

/**
 * Publish only the downstream facts established by the independent graph
 * stage. Pixel coordinates, colors, and calibration internals stay private;
 * the source-calibrated time/voltage curve becomes an immutable stage output
 * so later agents do not re-digitize the same PDF.
 */
export function projectReferenceGraphObservationForCharacterizer(
  observation: ReferenceGraphObservation,
): CharacterizerReferenceGraphObservation {
  return {
    version: 1,
    source_pdf_sha256: observation.source_pdf_sha256,
    reviewed_hints: observation.reviewed_hints.map((entry) => ({ ...entry })),
    graphs: observation.graphs.map(({ channels, ...graph }) => ({
      ...graph,
      crop: { ...graph.crop },
      ...(graph.response_quantity === "voltage" &&
      graph.public_pin_observable &&
      graph.fixture_reproducible &&
      graph.electrical_binding &&
      channels
        ? {
            server_verified_reference_channels: channels.map((channel) => ({
              channel_id: channel.channel_id,
              label: channel.label,
              role: channel.role,
              measurement: structuredClone(channel.measurement),
              provenance: "canonical_pdf_axis_and_pixel_trace_v1" as const,
              x_quantity: "time" as const,
              x_unit: "s" as const,
              y_quantity: channel.digitized_curve.y_quantity,
              y_unit: channel.digitized_curve.y_unit,
              points: channel.digitized_curve.points.map(({ x, y }) => ({ x, y })),
            })),
          }
        : {}),
    })),
  }
}
