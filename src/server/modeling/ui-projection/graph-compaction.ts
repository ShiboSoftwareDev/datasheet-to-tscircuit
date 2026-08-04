import type { AnyCircuitElement } from "circuit-json"

const MAX_PREVIEW_CIRCUIT_GRAPH_SAMPLES = 1_000

function extremaPreservingSampleIndexes(levels: readonly number[], maximum: number): number[] {
  if (levels.length <= maximum) return levels.map((_, index) => index)
  const interior_count = levels.length - 2
  const bucket_count = Math.max(1, Math.floor((maximum - 2) / 2))
  const indexes = [0]
  for (let bucket = 0; bucket < bucket_count; bucket += 1) {
    const start = 1 + Math.floor((bucket * interior_count) / bucket_count)
    const end = 1 + Math.floor(((bucket + 1) * interior_count) / bucket_count)
    let minimum_index = start
    let maximum_index = start
    for (let index = start + 1; index < end; index += 1) {
      const value = levels[index]
      const minimum = levels[minimum_index]
      const maximum_value = levels[maximum_index]
      if (value === undefined || minimum === undefined || maximum_value === undefined) continue
      if (value < minimum) minimum_index = index
      if (value > maximum_value) maximum_index = index
    }
    if (minimum_index <= maximum_index) {
      indexes.push(minimum_index)
      if (maximum_index !== minimum_index) indexes.push(maximum_index)
    } else {
      indexes.push(maximum_index, minimum_index)
    }
  }
  indexes.push(levels.length - 1)
  return indexes
}

/**
 * Circuit JSON retained for provenance remains complete. Only the UI projection
 * is compacted, preserving the first/last samples and each time bucket's extrema
 * so Runframe keeps edges and peaks without duplicating tens of thousands of
 * simulator samples into every preview response.
 */
export function compactModelPreviewCircuitJson(circuit_json: AnyCircuitElement[]): AnyCircuitElement[] {
  let changed = false
  const compacted = circuit_json.map((element) => {
    const record = element as AnyCircuitElement & Record<string, unknown>
    const level_field =
      record.type === "simulation_transient_voltage_graph"
        ? "voltage_levels"
        : record.type === "simulation_transient_current_graph"
          ? "current_levels"
          : undefined
    if (!level_field) return element
    const timestamps = record.timestamps_ms
    const levels = record[level_field]
    if (
      !Array.isArray(timestamps) ||
      !Array.isArray(levels) ||
      timestamps.length !== levels.length ||
      timestamps.length <= MAX_PREVIEW_CIRCUIT_GRAPH_SAMPLES ||
      !timestamps.every((value) => typeof value === "number" && Number.isFinite(value)) ||
      !levels.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      return element
    }
    const indexes = extremaPreservingSampleIndexes(levels, MAX_PREVIEW_CIRCUIT_GRAPH_SAMPLES)
    changed = true
    return {
      ...record,
      timestamps_ms: indexes.map((index) => timestamps[index]),
      [level_field]: indexes.map((index) => levels[index]),
    } as AnyCircuitElement
  })
  return changed ? compacted : circuit_json
}
