import type { ModelCharacterization, ModelFamily, ModelInterface, ModelRequirement } from "../../modeling"
import { eligibleObservedChannels, type ReferenceGraphObservation } from "../reference-graph-observation"

function inferModelFamily(model_interface: ModelInterface): ModelFamily {
  const roles = new Set(model_interface.pins.map(({ role }) => role.trim().toLowerCase()))
  const labels = new Set(
    model_interface.pins.flatMap(({ physical_pin, component_pin, spice_node, labels }) =>
      [physical_pin, component_pin, spice_node, ...labels].map((value) =>
        value
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ""),
      ),
    ),
  )
  const has_power_input = roles.has("power_input") || labels.has("vin") || labels.has("vcc")
  const has_power_output = roles.has("power_output") || labels.has("vout")
  const has_switch_node = [...labels].some((label) => /^(?:lx|ph|sw|switch|l\d+)$/.test(label))
  if (has_power_input && has_power_output && has_switch_node) return "power_converter"
  if (has_power_input && has_power_output) return "regulator"
  return "other"
}

function graphRequirement(graph: ReturnType<typeof eligibleObservedChannels>[number]): ModelRequirement {
  const points = graph.digitized_curve.points.map(({ x, y }) => ({ x, y }))
  const y_values = points.map(({ y }) => y)
  const minimum = Math.min(...y_values)
  const maximum = Math.max(...y_values)
  const nominal =
    graph.measurement.type === "voltage" &&
    graph.measurement.positive === graph.electrical_binding.response.positive &&
    graph.measurement.negative === graph.electrical_binding.response.negative
      ? graph.electrical_binding.response.nominal_volts
      : undefined
  const target =
    nominal !== undefined && nominal >= minimum && nominal <= maximum
      ? nominal
      : minimum + (maximum - minimum) / 2
  return {
    requirement_id: graph.graph_id,
    title: `${graph.locator} — ${graph.channel_label}`,
    behavior: `Reproduce the printed ${graph.channel_label} ${graph.measurement.type} channel during the documented ${graph.electrical_binding.stimulus.type.replace("_", " ")} experiment.`,
    analysis: "transient",
    support: { status: "modeled" },
    conditions: {
      graph_id: graph.source_graph_id,
      channel_id: graph.channel_id,
      channel_role: graph.channel_role,
      stimulus: graph.electrical_binding.stimulus.type,
      source_page: graph.page,
    },
    expected: {
      unit: graph.digitized_curve.y_unit,
      target,
      min: minimum,
      max: maximum,
    },
    reference_curve: {
      x_quantity: "time",
      x_unit: "s",
      y_quantity: graph.digitized_curve.y_quantity,
      y_unit: graph.digitized_curve.y_unit,
      points,
      tolerance: 0.1,
      crop: { ...graph.crop },
      channel_id: graph.channel_id,
      channel_label: graph.channel_label,
      channel_role: graph.channel_role,
      measurement: structuredClone(graph.measurement),
      electrical_binding: structuredClone(graph.electrical_binding),
    },
    sources: [
      {
        page: graph.page,
        locator: graph.locator,
        statement: graph.reason,
      },
    ],
  }
}

/**
 * Builds the model contract directly from the independently observed graphs.
 * There is one modeled requirement per plotted channel and no second agent is
 * allowed to reinterpret, omit, resample, or rename the reference experiment.
 */
export function characterizeReferenceGraphs(input: {
  model_interface: ModelInterface
  observation: ReferenceGraphObservation
}): ModelCharacterization {
  const graphs = eligibleObservedChannels(input.observation)
  return {
    version: 1,
    family: inferModelFamily(input.model_interface),
    strategy: "behavioral",
    requirements: graphs.map(graphRequirement),
    assumptions: [],
    limitations: [
      "The generated model is evaluated only against the retained public-pin voltage-versus-time graphs.",
    ],
  }
}
