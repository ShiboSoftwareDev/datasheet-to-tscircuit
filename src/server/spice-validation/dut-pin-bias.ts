import type { ModelPublicElectricalEndpoint, ModelReferenceElectricalBinding } from "../modeling/types"
import type { ResolvedApplicationFixture } from "../modeling/application-fixture-contract"
import type { FixtureElement } from "./types"

function dutEndpoint(endpoint: string): ModelPublicElectricalEndpoint | undefined {
  return endpoint.startsWith("dut.") ? (endpoint as ModelPublicElectricalEndpoint) : undefined
}

export function deterministicDutPinBiases(input: {
  model_interface: { pins: readonly { spice_node: string }[] }
  binding: ModelReferenceElectricalBinding
  application_fixture?: ResolvedApplicationFixture
}): Extract<FixtureElement, { type: "resistor" }>[] {
  const connected = new Set<ModelPublicElectricalEndpoint>()
  const protect = new Set<ModelPublicElectricalEndpoint>()
  const add = (endpoint: string, target: Set<ModelPublicElectricalEndpoint>) => {
    const dut = dutEndpoint(endpoint)
    if (dut) target.add(dut)
  }
  for (const group of input.application_fixture?.node_groups ?? []) {
    for (const endpoint of group.dut_endpoints) connected.add(endpoint)
  }
  for (const overlay of input.application_fixture?.condition_overlays ?? []) {
    connected.add(overlay.endpoint)
  }
  add(input.binding.response.positive, protect)
  add(input.binding.response.negative, protect)
  if (input.binding.stimulus.type !== "steady_state") {
    for (const endpoint of [input.binding.stimulus.positive, input.binding.stimulus.negative]) {
      add(endpoint, connected)
      add(endpoint, protect)
    }
  }
  for (const auxiliary of input.binding.auxiliary_fixtures ?? []) {
    if (auxiliary.type === "logic_state") {
      add(auxiliary.endpoint, connected)
      add(auxiliary.endpoint, protect)
      add(auxiliary.reference, protect)
      continue
    }
    for (const endpoint of [auxiliary.positive, auxiliary.negative]) {
      add(endpoint, connected)
      add(endpoint, protect)
    }
  }
  return input.model_interface.pins.flatMap((pin, pin_index) => {
    const endpoint = `dut.${pin.spice_node}` as ModelPublicElectricalEndpoint
    if (connected.has(endpoint)) return []
    return [
      {
        id: `pin_bias_${pin_index + 1}`,
        type: "resistor" as const,
        positive: endpoint,
        negative: "gnd" as const,
        resistance_ohms: protect.has(endpoint) ? 1e12 : 1e9,
      },
    ]
  })
}
