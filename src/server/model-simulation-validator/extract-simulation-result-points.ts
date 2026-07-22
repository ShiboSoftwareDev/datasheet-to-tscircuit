import { SimulationExtractionDefinition, SimulationGraph, SimulationSeriesDefinition } from "./types"
import { getCircuitBuildDiagnostics, isCircuitJson } from "./get-circuit-build-diagnostics"
import { isRecord } from "./parse-simulation-definition"

export function parseSimulationOutput(value: unknown): { graphs: SimulationGraph[]; errors: string[] } {
  if (!isCircuitJson(value)) throw new Error("simulation did not produce Circuit JSON")
  const diagnostics = getCircuitBuildDiagnostics(value)
  const graphs: SimulationGraph[] = []
  for (const element of value) {
    if (!isRecord(element) || typeof element.type !== "string") continue
    if (element.type !== "simulation_transient_voltage_graph") continue
    if (
      typeof element.name !== "string" ||
      !Array.isArray(element.timestamps_ms) ||
      !Array.isArray(element.voltage_levels)
    ) {
      continue
    }
    if (
      element.timestamps_ms.length !== element.voltage_levels.length ||
      element.timestamps_ms.length < 2 ||
      !element.timestamps_ms.every((entry) => typeof entry === "number" && Number.isFinite(entry)) ||
      !element.voltage_levels.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ) {
      continue
    }
    graphs.push({
      name: element.name,
      timestamps_ms: element.timestamps_ms as number[],
      voltage_levels: element.voltage_levels as number[],
    })
  }
  return { graphs, errors: [...diagnostics.source_errors, ...diagnostics.simulation_errors] }
}

function requireGraph(graphs: SimulationGraph[], probe_name: string): SimulationGraph {
  const matches = graphs.filter((candidate) => candidate.name === probe_name)
  if (matches.length === 0) throw new Error(`simulation produced no voltage graph named ${probe_name}`)
  if (matches.length > 1) throw new Error(`simulation produced multiple voltage graphs named ${probe_name}`)
  return matches[0]!
}

export function extractSimulationResultPoints(
  circuit_json: unknown,
  definition: SimulationExtractionDefinition,
): Array<{ x: number; y: number }> {
  const graph = requireGraph(parseSimulationOutput(circuit_json).graphs, definition.probe_name)
  return graph.timestamps_ms.map((x, index) => ({
    x,
    y: graph.voltage_levels[index]! * definition.scale + definition.offset,
  }))
}

export function extractSimulationResultSeries(
  circuit_json: unknown,
  definitions: SimulationSeriesDefinition[],
): Record<string, Array<{ x: number; y: number }>> {
  const graphs = parseSimulationOutput(circuit_json).graphs
  return Object.fromEntries(
    definitions.map((definition) => {
      const graph = requireGraph(graphs, definition.probe_name)
      return [
        definition.series_id,
        graph.timestamps_ms.map((x, index) => ({
          x,
          y: graph.voltage_levels[index]! * definition.scale + definition.offset,
        })),
      ]
    }),
  )
}
