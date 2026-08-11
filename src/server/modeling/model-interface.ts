import type { AnyCircuitElement } from "circuit-json"
import { physicalPinHint, type ComponentEvidence } from "../component-evidence"
import { normalizePin } from "../component-evidence/get-pad-agreement-errors"
import { normalizeElectricalPinLabel } from "../pin-label-normalization"
import type { ModelInterface } from "./types"

function identifier(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^A-Za-z_]/, (prefix) => `N_${prefix}`)
    .toUpperCase()
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function selectorSafe(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
}

function evidenceSelector(pin: ComponentEvidence["pinout"]["pins"][number]): string {
  const physical_selector = `pin${pin.number}`
  if (selectorSafe(physical_selector)) return physical_selector
  const label_selector = pin.labels.find(selectorSafe)
  if (label_selector) return label_selector
  throw new Error(
    `Physical pin ${pin.number} has no selector-safe physical or label name for the model interface`,
  )
}

function resolveComponentSelector(input: {
  pin: ComponentEvidence["pinout"]["pins"][number]
  circuit_json: AnyCircuitElement[]
}): { component_pin: string; source_port_id: string } {
  const ports = input.circuit_json
    .map((element) => element as unknown as Record<string, unknown> & { type: string })
    .filter(({ type }) => type === "source_port")
  const expected_pin = normalizePin(input.pin.number)
  const exact_physical_matches = ports.filter((port) =>
    stringArray(port.port_hints).includes(physicalPinHint(input.pin.number)),
  )
  const matches =
    exact_physical_matches.length > 0
      ? exact_physical_matches
      : ports.filter((port) => {
          const aliases = [
            typeof port.pin_number === "string" || typeof port.pin_number === "number"
              ? String(port.pin_number)
              : "",
            ...stringArray(port.port_hints),
          ]
          return aliases.some((alias) => normalizePin(alias) === expected_pin)
        })
  if (matches.length !== 1) {
    throw new Error(
      `Physical pin ${input.pin.number} maps to ${matches.length} Circuit JSON source ports; the model interface requires exactly one`,
    )
  }
  const port = matches[0]!
  if (typeof port.source_port_id !== "string" || !port.source_port_id) {
    throw new Error(`Circuit JSON port for physical pin ${input.pin.number} has no source_port_id`)
  }
  const hints = [
    ...stringArray(port.port_hints),
    ...(typeof port.name === "string" ? [port.name] : []),
  ].filter(selectorSafe)
  const physical_selector = hints.find(
    (hint) => hint.toLowerCase() === `pin${input.pin.number}`.toLowerCase(),
  )
  const label_selectors = new Set(input.pin.labels.map(normalizeElectricalPinLabel))
  const label_selector = hints.find((hint) => label_selectors.has(normalizeElectricalPinLabel(hint)))
  const component_pin = physical_selector ?? label_selector
  if (!component_pin) {
    throw new Error(
      `Circuit JSON port ${port.source_port_id} for physical pin ${input.pin.number} has no selector-safe physical or label hint`,
    )
  }
  return { component_pin, source_port_id: port.source_port_id }
}

function createModelInterfaceWithSelectors(
  evidence: ComponentEvidence,
  selector_for_pin: (
    pin: ComponentEvidence["pinout"]["pins"][number],
    index: number,
  ) => { component_pin: string; source_port_id: string },
): ModelInterface {
  const entry_name = identifier(evidence.part_number.value) || "DATASHEET_MODEL"
  const used_nodes = new Set<string>()
  const electrical_pins = evidence.pinout.pins.filter(({ role }) => role !== "no_connect")
  const pins = electrical_pins.map((pin, index) => {
    const selector = selector_for_pin(pin, index)
    const primary_label = pin.labels[0]
    const base =
      identifier(primary_label ? normalizeElectricalPinLabel(primary_label) : `PIN_${pin.number}`) ||
      `PIN_${identifier(pin.number)}`
    let spice_node = base
    let suffix = 2
    while (used_nodes.has(spice_node)) {
      spice_node = `${base}_${suffix}`
      suffix += 1
    }
    used_nodes.add(spice_node)
    return {
      physical_pin: pin.number,
      component_pin: selector.component_pin,
      source_port_id: selector.source_port_id,
      spice_node,
      labels: [...pin.labels],
      role: pin.role,
    }
  })
  if (pins.length === 0) throw new Error("Component evidence has no pins for the SPICE interface")
  return {
    version: 1,
    part_number: evidence.part_number.value,
    entry_name,
    pins,
  }
}

/**
 * Creates the standalone electrical interface used by graph characterization,
 * model generation, and validation before a generated component exists. The
 * source-port ids are stable evidence identities, not Circuit JSON ids.
 */
export function createEvidenceModelInterface(evidence: ComponentEvidence): ModelInterface {
  return createModelInterfaceWithSelectors(evidence, (pin, index) => ({
    component_pin: evidenceSelector(pin),
    source_port_id: `evidence_port_${index + 1}`,
  }))
}

/** Creates the final integration interface from the validated component. */
export function createModelInterface(
  evidence: ComponentEvidence,
  circuit_json: AnyCircuitElement[],
): ModelInterface {
  return createModelInterfaceWithSelectors(evidence, (pin) => resolveComponentSelector({ pin, circuit_json }))
}

/**
 * The generated component may supply different concrete Circuit JSON ids, but
 * it must implement the exact electrical interface that was modeled.
 */
export function assertModelInterfaceIntegrationCompatible(
  modeled: ModelInterface,
  integrated: ModelInterface,
): void {
  const modeled_contract = {
    version: modeled.version,
    part_number: modeled.part_number,
    entry_name: modeled.entry_name,
    pins: modeled.pins.map(({ source_port_id: _source_port_id, ...pin }) => pin),
  }
  const integrated_contract = {
    version: integrated.version,
    part_number: integrated.part_number,
    entry_name: integrated.entry_name,
    pins: integrated.pins.map(({ source_port_id: _source_port_id, ...pin }) => pin),
  }
  if (JSON.stringify(integrated_contract) !== JSON.stringify(modeled_contract)) {
    throw new Error("Validated component pin interface does not match the evidence-derived SPICE interface")
  }
}
