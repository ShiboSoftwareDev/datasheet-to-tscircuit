import { join } from "node:path"
import type { AnyCircuitElement } from "circuit-json"
import type { ModelManifest } from "@/shared/job-types"
import { isCircuitJson } from "../component-circuit-json"
import type { ModelInterface } from "./types"

export function createIntegratedComponentSource(manifest: ModelManifest, model_source: string): string {
  const mapping = Object.fromEntries(
    manifest.pins.map(({ spice_node, component_pin }) => [spice_node, component_pin]),
  )
  return `import { cloneElement, type ComponentProps, type ReactElement } from "react"
import Component from "./component.circuit"

const modelSource = ${JSON.stringify(model_source)}
export type ComponentWithModelProps = ComponentProps<typeof Component>
type ComponentElement = ReactElement<ComponentWithModelProps>

export default function ComponentWithModel(props: ComponentWithModelProps) {
  return cloneElement(Component(props) as ComponentElement, {
    ...props,
    spiceModel: (
      <spicemodel
        source={modelSource}
        spicePinMapping={${JSON.stringify(mapping, null, 2)}}
      />
    ),
  })
}
`
}

export async function writeIntegratedComponent(input: {
  model_dir: string
  manifest: ModelManifest
  model_source: string
  file_name?: string
}): Promise<string> {
  const source = createIntegratedComponentSource(input.manifest, input.model_source)
  await Bun.write(join(input.model_dir, input.file_name ?? "component-with-model.circuit.tsx"), source)
  return source
}

function normalizeModelSource(source: string): string {
  return source.replace(/\r\n?/g, "\n").trim()
}

export function assertCircuitEmbedsModel(
  value: unknown,
  model_source: string,
  model_interface: ModelInterface,
): asserts value is AnyCircuitElement[] {
  if (!isCircuitJson(value)) throw new Error("Integrated component build produced invalid Circuit JSON")
  const models = value.filter((element) => element.type === "simulation_spice_subcircuit")
  const embedded = models[0]
  const expected_mapping = Object.fromEntries(
    model_interface.pins.map(({ spice_node, source_port_id }) => [spice_node, source_port_id]),
  )
  const actual_mapping =
    embedded &&
    "spice_pin_to_source_port_map" in embedded &&
    typeof embedded.spice_pin_to_source_port_map === "object" &&
    embedded.spice_pin_to_source_port_map !== null &&
    !Array.isArray(embedded.spice_pin_to_source_port_map)
      ? embedded.spice_pin_to_source_port_map
      : undefined
  const orderedEntries = (mapping: Record<string, unknown>) =>
    Object.entries(mapping).sort(([left], [right]) => left.localeCompare(right))
  if (
    models.length !== 1 ||
    !("subcircuit_source" in embedded!) ||
    typeof embedded.subcircuit_source !== "string" ||
    normalizeModelSource(embedded.subcircuit_source) !== normalizeModelSource(model_source) ||
    !actual_mapping ||
    JSON.stringify(orderedEntries(actual_mapping)) !== JSON.stringify(orderedEntries(expected_mapping))
  ) {
    throw new Error(
      "Integrated component must embed exactly the canonical model.lib subcircuit and server-owned pin mapping",
    )
  }
}

/**
 * Binds a validation waveform to the generated DUT model. Validation TSX may
 * contain private fixture subcircuits, so this check resolves the model through
 * the unique source component named DUT instead of counting every SPICE helper.
 */
export function assertValidationCircuitEmbedsModel(
  value: unknown,
  model_source: string,
  manifest: ModelManifest,
): asserts value is AnyCircuitElement[] {
  if (!isCircuitJson(value)) throw new Error("Validation TSX produced invalid Circuit JSON")
  const records = value as Array<AnyCircuitElement & Record<string, unknown>>
  const duts = records.filter(
    (element) =>
      element.type === "source_component" &&
      element.name === "DUT" &&
      element.manufacturer_part_number === manifest.part_number,
  )
  const dut_id = duts[0]?.source_component_id
  const embedded_models = records.filter(
    (element) =>
      element.type === "simulation_spice_subcircuit" &&
      typeof dut_id === "string" &&
      element.source_component_id === dut_id,
  )
  const embedded = embedded_models[0]
  const mapping =
    embedded &&
    typeof embedded.spice_pin_to_source_port_map === "object" &&
    embedded.spice_pin_to_source_port_map !== null &&
    !Array.isArray(embedded.spice_pin_to_source_port_map)
      ? (embedded.spice_pin_to_source_port_map as Record<string, unknown>)
      : undefined
  const expected_nodes = [...manifest.pins.map(({ spice_node }) => spice_node)].sort()
  const actual_nodes = mapping ? Object.keys(mapping).sort() : []
  const ports_by_id = new Map(
    records.flatMap((element) =>
      element.type === "source_port" && typeof element.source_port_id === "string"
        ? [[element.source_port_id, element] as const]
        : [],
    ),
  )
  const ports_match =
    mapping !== undefined &&
    manifest.pins.every(({ component_pin, spice_node }) => {
      const port_id = mapping[spice_node]
      const port = typeof port_id === "string" ? ports_by_id.get(port_id) : undefined
      if (!port) return false
      return (
        port.source_component_id === dut_id &&
        Array.isArray(port.port_hints) &&
        port.port_hints.includes(component_pin)
      )
    })
  if (
    duts.length !== 1 ||
    embedded_models.length !== 1 ||
    typeof embedded?.subcircuit_source !== "string" ||
    normalizeModelSource(embedded.subcircuit_source) !== normalizeModelSource(model_source) ||
    JSON.stringify(actual_nodes) !== JSON.stringify(expected_nodes) ||
    !ports_match
  ) {
    throw new Error(
      "Validation Circuit JSON must bind the unique DUT to the canonical model.lib source and generated pin mapping",
    )
  }
}
